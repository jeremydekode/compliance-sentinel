// ============================================================================
// PDF VIEWER — renders an EXACT PDF (converted from the docx by a real Office
// engine) with pdf.js, plus a HIGHLIGHT LAYER: finding quotes are located in
// each page's text layer and overlaid as colored, clickable regions with
// scroll-to-highlight sync. Because pdf.js is our own renderer (not a locked
// iframe), the exact render and the interactive review can coexist.
//
// Rendering runs in a single effect with real cleanup (cancels the in-flight
// pdf.js task, destroys the doc) — safe under StrictMode double-mount and
// resize/URL changes. Highlights are a SEPARATE pass over cached text-layer
// data, so accept/dismiss decisions never re-render 40+ canvases.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader2, FileWarning } from "lucide-react";
// Vite bundles the worker and hands back its URL — reliable across dev/prod.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export interface PdfHighlight {
  id: string;
  /** Text to locate (a finding's evidence quote). */
  text: string;
  /** Fallback anchor if `text` can't be located. */
  altText?: string;
  kind: "edit" | "critical" | "high" | "medium" | "info" | "input";
}

interface PdfViewerProps {
  /** Public URL of the converted PDF. */
  fileUrl: string | null;
  className?: string;
  highlights?: PdfHighlight[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
  onAnchorStatus?: (status: Record<string, boolean>) => void;
}

// pdf.js paints a page in chunks scheduled with requestAnimationFrame. rAF is
// suspended while a document is hidden (backgrounded tab / offscreen webview),
// which stalls the render indefinitely. This shim schedules each frame via BOTH
// rAF and a short timer — whichever fires first wins (guarded against double
// firing). In a visible tab native rAF (~16ms) always wins, so behaviour is
// unchanged; when hidden, the timer keeps rendering moving. Installed only for
// the duration of a render, then restored.
function installFrameFallback(): () => void {
  if (typeof window === "undefined") return () => {};
  const native = window.requestAnimationFrame?.bind(window);
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    let done = false;
    const run = (t: number) => { if (done) return; done = true; cb(t); };
    if (native) native(run);
    const id = window.setTimeout(() => run(performance.now()), 32);
    return id as unknown as number;
  }) as typeof window.requestAnimationFrame;
  return () => { if (native) window.requestAnimationFrame = native; };
}

/** Highlight fill colors: [resting, active]. multiply-blended over the canvas. */
const KIND_COLORS: Record<PdfHighlight["kind"], [string, string]> = {
  input:    ["rgba(168,85,247,0.28)", "rgba(168,85,247,0.5)"],
  critical: ["rgba(239,68,68,0.3)",   "rgba(239,68,68,0.52)"],
  high:     ["rgba(249,115,22,0.3)",  "rgba(249,115,22,0.52)"],
  medium:   ["rgba(245,158,11,0.3)",  "rgba(245,158,11,0.52)"],
  info:     ["rgba(56,189,248,0.28)", "rgba(56,189,248,0.5)"],
  edit:     ["rgba(16,185,129,0.28)", "rgba(16,185,129,0.5)"],
};

function normText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

interface PageEntry {
  div: HTMLDivElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewport: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: any[];
}

export function PdfViewer({ fileUrl, className, highlights, activeId, onSelect, onAnchorStatus }: PdfViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  // Re-render on MEANINGFUL width changes only. `scrollbar-gutter: stable` keeps
  // clientWidth constant whether or not the scrollbar shows, so appending pages
  // can't start a width→render→width feedback loop.
  const [width, setWidth] = useState(0);
  const lastRenderedWidth = useRef(0);
  // Per-page text-layer data cached for the (cheap) highlight pass.
  const pagesRef = useRef<PageEntry[]>([]);
  const [pagesReady, setPagesReady] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const utilRef = useRef<any>(null);
  // Keep callbacks in refs so the highlight effect doesn't rerun on identity churn.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onAnchorStatusRef = useRef(onAnchorStatus);
  onAnchorStatusRef.current = onAnchorStatus;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const w = root.clientWidth;
        if (Math.abs(w - lastRenderedWidth.current) > 24) setWidth(w);
      });
    });
    ro.observe(root);
    setWidth(root.clientWidth);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, []);

  // ── Pass 1: render pages to canvases + cache text layers ───────────────────
  useEffect(() => {
    if (!fileUrl) { setPhase("error"); return; }
    if (!width) return; // wait for a measured width
    lastRenderedWidth.current = width;
    setPhase("loading");

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let task: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let doc: any = null;
    const restoreFrames = installFrameFallback();

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        utilRef.current = pdfjs.Util;
        // disableFontFace: render glyphs as canvas paths instead of injecting
        // @font-face rules (the Font Loading API can stall in embedded views).
        doc = await pdfjs.getDocument({ url: fileUrl, disableFontFace: true }).promise;
        if (cancelled) return;
        const container = containerRef.current;
        if (!container) return;
        container.replaceChildren();
        pagesRef.current = [];
        setPagesReady(0);
        const avail = width - 24;
        const dpr = Math.min(2, window.devicePixelRatio || 1);

        // Progressive: append + reveal each page as it finishes so the first
        // page shows in ~1s instead of after all 40+ pages.
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(1.6, Math.max(0.4, avail / base.width));
          const viewport = page.getViewport({ scale });

          const pageDiv = document.createElement("div");
          pageDiv.style.cssText =
            `position:relative;width:${Math.floor(viewport.width)}px;height:${Math.floor(viewport.height)}px;` +
            `margin:0 auto 16px;background:#fff;box-shadow:0 1px 8px rgba(0,0,0,.15);`;
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          pageDiv.appendChild(canvas);
          container.appendChild(pageDiv);

          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          task = page.render({
            canvasContext: ctx,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          });
          try {
            await task.promise;
          } catch (err) {
            if (cancelled || (err as Error)?.name === "RenderingCancelledException") return;
            throw err;
          }
          if (cancelled) return;
          // Cache the text layer for the highlight pass.
          try {
            const tc = await page.getTextContent();
            if (cancelled) return;
            pagesRef.current.push({ div: pageDiv, viewport, items: tc.items ?? [] });
          } catch {
            pagesRef.current.push({ div: pageDiv, viewport, items: [] });
          }
          setPagesReady(pagesRef.current.length);
          if (i === 1) setPhase("ready"); // reveal once the first page is painted
        }
        if (!cancelled) setPhase("ready");
      } catch (e) {
        if (!cancelled) {
          console.warn("PdfViewer: render failed:", (e as Error)?.message);
          setPhase("error");
        }
      } finally {
        restoreFrames();
      }
    })();

    return () => {
      cancelled = true;
      try { task?.cancel(); } catch { /* noop */ }
      try { doc?.destroy?.(); } catch { /* noop */ }
    };
  }, [fileUrl, width]);

  // ── Pass 2: locate highlight quotes in the cached text layers, overlay ─────
  useEffect(() => {
    const pages = pagesRef.current;
    const Util = utilRef.current;
    if (!pages.length || !Util) return;
    for (const p of pages) p.div.querySelectorAll("[data-hl]").forEach((el) => el.remove());
    if (!highlights?.length) { onAnchorStatusRef.current?.({}); return; }

    // Per-page: normalized text buffer + span→item offset map.
    const pageData = pages.map((p) => {
      let buf = "";
      const spans: { start: number; end: number; idx: number }[] = [];
      p.items.forEach((it, idx) => {
        const t = normText(String(it.str ?? ""));
        if (!t) return;
        const start = buf.length ? buf.length + 1 : 0;
        buf = buf.length ? `${buf} ${t}` : t;
        spans.push({ start, end: buf.length, idx });
      });
      return { buf, spans };
    });

    const tryFind = (needle: string) => {
      if (!needle || needle.length < 8) return null;
      for (let pi = 0; pi < pageData.length; pi++) {
        const pos = pageData[pi].buf.indexOf(needle);
        if (pos >= 0) return { pi, pos, len: needle.length };
      }
      return null;
    };

    const status: Record<string, boolean> = {};
    for (const h of highlights) {
      // Progressive anchors: full quote → 70-char prefix → first 8 words → altText.
      const candidates: string[] = [];
      const full = normText(h.text);
      if (full) {
        candidates.push(full);
        if (full.length > 70) candidates.push(full.slice(0, 70).trim());
        const words = full.split(" ");
        if (words.length > 8) candidates.push(words.slice(0, 8).join(" "));
      }
      const alt = normText(h.altText ?? "");
      if (alt) {
        candidates.push(alt);
        if (alt.length > 70) candidates.push(alt.slice(0, 70).trim());
      }
      let hit: { pi: number; pos: number; len: number } | null = null;
      for (const c of candidates) { hit = tryFind(c); if (hit) break; }
      status[h.id] = !!hit;
      if (!hit) continue;

      const pd = pageData[hit.pi];
      const page = pages[hit.pi];
      const end = hit.pos + hit.len;
      for (const s of pd.spans) {
        if (s.end <= hit.pos || s.start >= end) continue;
        const it = page.items[s.idx];
        if (!it) continue;
        const tx = Util.transform(page.viewport.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]) || 10;
        const x = tx[4];
        const y = tx[5] - fh;
        const w = (it.width ?? 0) * page.viewport.scale;
        const el = document.createElement("div");
        el.dataset.hl = h.id;
        el.dataset.hlKind = h.kind;
        el.style.cssText =
          `position:absolute;left:${x}px;top:${y}px;width:${Math.max(w, 4)}px;height:${fh * 1.3}px;` +
          `background:${KIND_COLORS[h.kind]?.[0] ?? KIND_COLORS.medium[0]};border-radius:2px;cursor:pointer;` +
          `mix-blend-mode:multiply;`;
        el.addEventListener("click", () => onSelectRef.current?.(h.id));
        page.div.appendChild(el);
      }
    }
    onAnchorStatusRef.current?.(status);
  }, [highlights, pagesReady]);

  // ── Active highlight: stronger fill + outline + scroll into view ───────────
  useEffect(() => {
    const pages = pagesRef.current;
    if (!pages.length) return;
    let first: HTMLElement | null = null;
    for (const p of pages) {
      p.div.querySelectorAll<HTMLElement>("[data-hl]").forEach((el) => {
        const kind = (el.dataset.hlKind ?? "medium") as PdfHighlight["kind"];
        const on = !!activeId && el.dataset.hl === activeId;
        el.style.background = (KIND_COLORS[kind] ?? KIND_COLORS.medium)[on ? 1 : 0];
        el.style.outline = on ? "2px solid rgba(217,70,239,0.9)" : "none";
        if (on && !first) first = el;
      });
    }
    // Instant jump (not smooth): smooth scrolling animates on rAF, which is
    // suspended in hidden/backgrounded documents — the jump silently no-ops.
    if (first) (first as HTMLElement).scrollIntoView({ behavior: "auto", block: "center" });
  }, [activeId, pagesReady, highlights]);

  return (
    <div
      ref={rootRef}
      style={{ scrollbarGutter: "stable" }}
      className={cn("relative h-full overflow-y-auto overflow-x-hidden bg-muted/40", className)}
    >
      {phase === "loading" && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Rendering exact document…
          </div>
        </div>
      )}
      <div ref={containerRef} className={cn("py-6", phase !== "ready" && "opacity-0")} />
      {phase === "error" && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-6" />
            <p>The exact preview couldn't be generated.</p>
            {fileUrl && (
              <a href={fileUrl} className="text-primary underline" target="_blank" rel="noreferrer">Open the file</a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
