import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
// Vite resolves ?url to the emitted asset URL (same pattern as styles.css?url in
// __root.tsx). Just a string — safe at module load / SSR; pdf.js itself is
// dynamically imported below so its code never runs on the server.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// ============================================================================
// PdfHighlight — renders one page of a PDF to a canvas and draws highlight
// boxes over the text that matches `quote`, located via the pdf.js text layer.
// pdf.js is dynamically imported (client-only) so it never runs during SSR.
// Falls back to the browser's native PDF viewer (iframe) if anything fails.
// ============================================================================

type Rect = { left: number; top: number; width: number; height: number };

function norm(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchItems(items: any[], quote: string): number[] {
  let joined = "";
  const spans: { start: number; end: number; i: number }[] = [];
  items.forEach((it, i) => {
    const n = norm(it.str);
    if (!n) return;
    const start = joined.length;
    joined += n + " ";
    spans.push({ start, end: joined.length, i });
  });
  const nq = norm(quote);
  if (nq.length < 8) return [];
  const needle = nq.slice(0, 60);
  const at = joined.indexOf(needle);
  if (at >= 0) {
    const end = at + nq.length;
    return spans.filter((s) => s.start < end && s.end > at).map((s) => s.i);
  }
  // token fallback — items sharing ≥1 long token with the quote
  const toks = [...new Set(nq.split(" ").filter((t) => t.length > 4))];
  if (!toks.length) return [];
  return items
    .map((_, i) => i)
    .filter((i) => {
      const n = norm(items[i].str);
      return toks.some((t) => n.includes(t));
    });
}

export function PdfHighlight({
  url,
  page,
  quote,
  className,
  height = 360,
}: {
  url: string;
  page?: number;
  quote: string;
  className?: string;
  height?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [rects, setRects] = useState<Rect[]>([]);
  const pageNum = Math.max(1, page || 1);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let renderTask: any;
    (async () => {
      try {
        setStatus("loading");
        setRects([]);
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

        const doc = await pdfjs.getDocument({ url }).promise;
        if (cancelled) return;
        const pg = await doc.getPage(Math.min(pageNum, doc.numPages));
        const base = pg.getViewport({ scale: 1 });
        const cssWidth = scrollRef.current?.clientWidth || 480;
        const scale = cssWidth / base.width;
        const dpr = window.devicePixelRatio || 1;
        const vp = pg.getViewport({ scale });

        const canvas = canvasRef.current!;
        const stage = stageRef.current!;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${vp.height}px`;
        stage.style.width = `${cssWidth}px`;
        stage.style.height = `${vp.height}px`;
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);
        renderTask = pg.render({ canvasContext: ctx, viewport: vp });
        await renderTask.promise;
        if (cancelled) return;

        const tc = await pg.getTextContent();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = (tc.items as any[]).filter((it) => typeof it.str === "string" && it.str.trim());
        const idx = matchItems(items, quote);
        const rs: Rect[] = idx.map((i) => {
          const it = items[i];
          const tx = pdfjs.Util.transform(vp.transform, it.transform);
          const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
          return { left: tx[4], top: tx[5] - fontHeight - 1, width: (it.width || 0) * scale, height: fontHeight + 3 };
        });
        if (cancelled) return;
        setRects(rs);
        setStatus("ready");
        if (rs.length && scrollRef.current) {
          scrollRef.current.scrollTo({ top: Math.max(0, rs[0].top - 70), behavior: "smooth" });
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        /* noop */
      }
    };
  }, [url, pageNum, quote]);

  if (status === "error") {
    return (
      <iframe
        src={`${url}#page=${pageNum}`}
        title="source document"
        className={cn("w-full bg-muted/20", className)}
        style={{ height, border: 0 }}
      />
    );
  }

  return (
    <div ref={scrollRef} className={cn("relative overflow-auto bg-muted/10", className)} style={{ height }}>
      <div ref={stageRef} className="relative mx-auto">
        <canvas ref={canvasRef} className="block" />
        {rects.map((r, i) => (
          <div
            key={i}
            className="absolute rounded-[2px] pointer-events-none"
            style={{
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
              background: "rgba(250, 204, 21, 0.42)",
              mixBlendMode: "multiply",
            }}
          />
        ))}
      </div>
      {status === "loading" && (
        <div className="absolute inset-0 grid place-items-center bg-card/60 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading source page…
          </span>
        </div>
      )}
    </div>
  );
}
