// ============================================================================
// DOC VIEWER — faithful in-browser document rendering with inline highlights.
// ----------------------------------------------------------------------------
// Renders a DOCX via `docx-preview` (client-only): real page chrome, headers/
// footers, logo images, fonts — the document looks like the document.
//
// Highlights use the CSS Custom Highlight API: for each item we locate its
// anchor text in the rendered text nodes (normalized search) and register a
// Range under a per-kind Highlight — NO DOM surgery, so docx-preview's output
// is never corrupted. Items that can't be anchored are reported back through
// onAnchorStatus so the rail can badge them (never silently dropped).
//
// Fallback (PDF / non-DOCX / fetch failure): extracted text in the legal
// review page's `whitespace-pre-wrap font-serif` style.
// ============================================================================

import { useEffect, useRef, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Loader2, FileWarning } from "lucide-react";

export interface DocHighlight {
  id: string;
  /** Verbatim-ish text to anchor on (an edit's `before`, a finding's evidence quote). */
  text: string;
  /** Highlight style bucket — maps to a ::highlight() rule. */
  kind: "edit" | "critical" | "high" | "medium" | "info";
}

export type AnchorStatus = Record<string, boolean>;

interface DocViewerProps {
  /** Public URL of the source file (Supabase storage). */
  fileUrl: string | null;
  /** Fallback plain text when the file can't be rendered (PDF etc.). */
  fallbackText?: string | null;
  highlights?: DocHighlight[];
  /** The currently selected item — gets the stronger "active" style + scroll. */
  activeId?: string | null;
  /** Click on a highlighted region selects the item in the rail. */
  onSelect?: (id: string) => void;
  /** Reports which highlight ids anchored successfully. */
  onAnchorStatus?: (status: AnchorStatus) => void;
  className?: string;
}

// ── text-node search ─────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[   ​]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

interface TextIndex {
  nodes: Text[];
  /** Normalized full text. */
  full: string;
  /** For each node, its start offset in `full`. */
  starts: number[];
  /** Map from normalized offset to (nodeIdx, rawOffsetInNode). */
  locate: (normOffset: number) => { node: Text; offset: number } | null;
}

/** Builds a searchable index over all text nodes in a container. Normalization
 *  collapses whitespace, so we keep a per-character map from normalized to raw
 *  offsets per node (cheap: one pass). */
function buildTextIndex(root: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  const rawMaps: number[][] = []; // normalized-char index -> raw offset (per node)
  let full = "";
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const raw = t.data;
    if (!raw) continue;
    let norm = "";
    const map: number[] = [];
    let lastWasSpace = full.endsWith(" ") || full.length === 0;
    for (let i = 0; i < raw.length; i++) {
      let ch = raw[i]
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[   ​]/g, " ");
      if (/\s/.test(ch)) {
        if (lastWasSpace) continue;
        ch = " ";
        lastWasSpace = true;
      } else {
        lastWasSpace = false;
      }
      norm += ch.toLowerCase();
      map.push(i);
    }
    if (!norm) continue;
    nodes.push(t);
    starts.push(full.length);
    rawMaps.push(map);
    full += norm;
    // Node boundaries act as whitespace between blocks.
    if (!full.endsWith(" ")) full += " ";
  }
  const locate = (normOffset: number) => {
    // Binary search for the node containing this normalized offset.
    let lo = 0, hi = nodes.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = starts[mid];
      const end = start + rawMaps[mid].length;
      if (normOffset < start) hi = mid - 1;
      else if (normOffset >= end) lo = mid + 1;
      else { found = mid; break; }
    }
    if (found < 0) return null;
    return { node: nodes[found], offset: rawMaps[found][normOffset - starts[found]] };
  };
  return { nodes, full, starts, locate };
}

/** Finds `needle` in the index and returns a DOM Range, or null. */
function findRange(index: TextIndex, needle: string): Range | null {
  const q = normalize(needle).trim();
  if (q.length < 8) return null; // too short to anchor reliably
  const at = index.full.indexOf(q);
  if (at < 0) return null;
  const start = index.locate(at);
  const end = index.locate(at + q.length - 1);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

// ── highlight styles (registered once) ──────────────────────────────────────

const HIGHLIGHT_CSS = `
::highlight(dv-edit)     { background-color: rgba(139, 92, 246, 0.22); }
::highlight(dv-critical) { background-color: rgba(239, 68, 68, 0.28); }
::highlight(dv-high)     { background-color: rgba(249, 115, 22, 0.26); }
::highlight(dv-medium)   { background-color: rgba(234, 179, 8, 0.28); }
::highlight(dv-info)     { background-color: rgba(59, 130, 246, 0.20); }
::highlight(dv-active)   { background-color: rgba(139, 92, 246, 0.45); }
`;

function ensureHighlightStyles() {
  if (document.getElementById("doc-viewer-highlight-styles")) return;
  const el = document.createElement("style");
  el.id = "doc-viewer-highlight-styles";
  el.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(el);
}

const supportsHighlightApi = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof (window as any).Highlight === "function"; // eslint-disable-line @typescript-eslint/no-explicit-any

// ── component ────────────────────────────────────────────────────────────────

export function DocViewer({
  fileUrl,
  fallbackText,
  highlights = [],
  activeId,
  onSelect,
  onAnchorStatus,
  className,
}: DocViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "docx" | "text" | "error">("loading");
  const [rendered, setRendered] = useState(0); // bumps when docx render completes
  const rangesRef = useRef<Map<string, Range>>(new Map());
  const naturalPageWidthRef = useRef<number | null>(null);

  // Zoom-to-fit: Word pages have a fixed CSS width (A4 ≈ 794px). In narrow
  // panes (the peek dialog, side-by-side compare) that fixed width would force
  // horizontal overflow and crop siblings — instead scale the whole render
  // down with CSS zoom so the page always fits the pane.
  const applyFit = useCallback(() => {
    const el = containerRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const section = el.querySelector("section.docx") as HTMLElement | null;
    if (!section) return;
    if (naturalPageWidthRef.current === null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el.style as any).zoom = "1";
      naturalPageWidthRef.current = section.offsetWidth || null;
    }
    const natural = naturalPageWidthRef.current;
    if (!natural) return;
    const avail = root.clientWidth - 24; // breathing room
    const scale = Math.min(1, Math.max(0.35, avail / natural));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el.style as any).zoom = String(scale);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => applyFit());
    ro.observe(root);
    return () => ro.disconnect();
  }, [applyFit]);

  // 1 — fetch + render the DOCX (client-only dynamic import; SSR-safe).
  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!fileUrl || !/\.docx($|\?)/i.test(fileUrl)) {
        setPhase(fallbackText ? "text" : "error");
        return;
      }
      try {
        const [{ renderAsync }, res] = await Promise.all([
          import("docx-preview"),
          fetch(fileUrl),
        ]);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = "";
        await renderAsync(buf, containerRef.current, undefined, {
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
          experimental: true,
        });
        if (cancelled) return;
        naturalPageWidthRef.current = null;
        setPhase("docx");
        setRendered((v) => v + 1);
        requestAnimationFrame(() => applyFit());
      } catch (e) {
        console.warn("DocViewer: docx render failed, falling back to text:", (e as Error)?.message);
        if (!cancelled) setPhase(fallbackText ? "text" : "error");
      }
    }
    setPhase("loading");
    render();
    return () => { cancelled = true; };
  }, [fileUrl, fallbackText]);

  // 2 — anchor highlights over the rendered content (Custom Highlight API).
  useEffect(() => {
    if (phase !== "docx" || !containerRef.current) return;
    if (!supportsHighlightApi()) {
      onAnchorStatus?.(Object.fromEntries(highlights.map((h) => [h.id, false])));
      return;
    }
    ensureHighlightStyles();
    const index = buildTextIndex(containerRef.current);
    const byKind = new Map<string, Range[]>();
    const ranges = new Map<string, Range>();
    const status: AnchorStatus = {};
    for (const h of highlights) {
      const range = findRange(index, h.text);
      status[h.id] = !!range;
      if (!range) continue;
      ranges.set(h.id, range);
      const kind = `dv-${h.kind}`;
      byKind.set(kind, [...(byKind.get(kind) ?? []), range]);
    }
    rangesRef.current = ranges;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const H = (window as any).Highlight;
    for (const [kind, rs] of byKind) CSS.highlights.set(kind, new H(...rs));
    onAnchorStatus?.(status);
    return () => {
      for (const kind of byKind.keys()) CSS.highlights.delete(kind);
      CSS.highlights.delete("dv-active");
    };
    // highlights identity: cheap join key avoids re-anchoring on unrelated renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, rendered, highlights.map((h) => h.id + h.kind).join("|")]);

  // 3 — active item: stronger highlight + scroll into view.
  useEffect(() => {
    if (phase !== "docx" || !supportsHighlightApi()) return;
    CSS.highlights.delete("dv-active");
    if (!activeId) return;
    const range = rangesRef.current.get(activeId);
    if (!range) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const H = (window as any).Highlight;
    CSS.highlights.set("dv-active", new H(range));
    const el = range.startContainer.parentElement;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeId, phase, rendered]);

  // 4 — click a highlighted region → select its item.
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onSelect || rangesRef.current.size === 0) return;
      // caretRangeFromPoint is WebKit/Blink; Firefox has caretPositionFromPoint.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = document as any;
      let sel: { startContainer: Node; startOffset: number } | null = null;
      if (typeof doc.caretRangeFromPoint === "function") {
        sel = doc.caretRangeFromPoint(e.clientX, e.clientY);
      } else if (typeof doc.caretPositionFromPoint === "function") {
        const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
        if (pos) sel = { startContainer: pos.offsetNode, startOffset: pos.offset };
      }
      if (!sel) return;
      for (const [id, range] of rangesRef.current) {
        try {
          if (
            range.comparePoint(sel.startContainer, sel.startOffset) === 0
          ) {
            onSelect(id);
            return;
          }
        } catch { /* different roots — ignore */ }
      }
    },
    [onSelect],
  );

  return (
    <div ref={rootRef} className={cn("relative h-full overflow-y-auto overflow-x-hidden bg-muted/40", className)}>
      {phase === "loading" && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Rendering document…
          </div>
        </div>
      )}
      {/* docx-preview target — keep mounted so the ref exists during render */}
      <div
        ref={containerRef}
        onClick={handleClick}
        className={cn("doc-viewer-pages py-6 [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-0 [&_.docx-wrapper>section.docx]:shadow-md [&_.docx-wrapper>section.docx]:mx-auto [&_.docx-wrapper>section.docx]:mb-6", phase !== "docx" && "hidden")}
      />
      {phase === "text" && (
        <div className="mx-auto max-w-3xl bg-card border rounded-xl shadow-sm my-6 p-8">
          <pre className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-foreground">
            {fallbackText}
          </pre>
        </div>
      )}
      {phase === "error" && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-6" />
            <p>The document preview is unavailable.</p>
            {fileUrl && (
              <a href={fileUrl} className="text-primary underline" target="_blank" rel="noreferrer">
                Download the original file
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
