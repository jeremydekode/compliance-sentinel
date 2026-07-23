// ============================================================================
// Exact in-app docx EDITOR — embeds OnlyOffice Document Server. Renders the
// document with Word-grade fidelity and edits save straight back to Supabase
// (via the /api/onlyoffice-callback webhook). Needs a running OnlyOffice server
// (ONLYOFFICE_URL) — see /onlyoffice/README.md to deploy one.
// ============================================================================

import { useEffect, useRef, useState, useId } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, ServerCrash } from "lucide-react";
import { cn } from "@/lib/utils";
import { getEditorConfig, forceSaveEditor } from "@/lib/compliance.functions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare global { interface Window { DocsAPI?: any } }

// Load the OnlyOffice api.js once; resolve when DocsAPI is available.
const scriptCache = new Map<string, Promise<void>>();
function loadDocsApi(apiUrl: string): Promise<void> {
  const src = `${apiUrl.replace(/\/$/, "")}/web-apps/apps/api/documents/api.js`;
  let p = scriptCache.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      if (window.DocsAPI) return resolve();
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error("Could not reach the OnlyOffice server."));
      document.head.appendChild(el);
    });
    scriptCache.set(src, p);
  }
  return p;
}

export interface EditorComment { id: string; quote: string; text: string }

// Inject findings as native comments + highlights once the document is ready,
// using OnlyOffice's connector (Document Builder API). Inject-once: if AI
// comments are already present (persisted from a prior open) we skip, so they
// never duplicate. Search misses are silent — worst case a flag just doesn't
// appear; it can never corrupt the document.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectComments(editor: any, comments: EditorComment[]) {
  if (!editor?.createConnection || !comments?.length) return;
  let connector: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { connector = editor.createConnection(); } catch { return; }
  const data = JSON.stringify(comments);
  const body = `
    var items = ${data};
    var oDocument = Api.GetDocument();
    var existing = [];
    try { existing = oDocument.GetAllComments() || []; } catch (e) {}
    var hasAI = false;
    for (var i = 0; i < existing.length; i++) {
      try { if (existing[i].GetAuthorName && existing[i].GetAuthorName() === "Compliance AI") { hasAI = true; break; } } catch (e) {}
    }
    if (!hasAI) {
      for (var j = 0; j < items.length; j++) {
        try {
          var ranges = oDocument.Search(items[j].quote, false);
          if (ranges && ranges.length) {
            ranges[0].AddComment(items[j].text, "Compliance AI");
            try { ranges[0].SetHighlight("yellow"); } catch (e) {}
          }
        } catch (e) {}
      }
    }
  `;
  try {
    // eslint-disable-next-line no-new-func
    connector.callCommand(new Function(body), function () { /* done */ });
  } catch { /* connector unavailable — editor still fully usable */ }
}

function Editor({ apiUrl, config, comments, className }: { apiUrl: string; config: unknown; comments?: EditorComment[]; className?: string }) {
  const holderId = `oo-${useId().replace(/[:]/g, "")}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let destroyed = false;
    loadDocsApi(apiUrl)
      .then(() => {
        if (destroyed || !window.DocsAPI) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg: any = { ...(config as any) };
        if (comments && comments.length) {
          cfg.events = {
            ...(cfg.events || {}),
            onDocumentReady: () => { try { injectComments(editorRef.current, comments); } catch { /* noop */ } },
          };
        }
        editorRef.current = new window.DocsAPI.DocEditor(holderId, cfg);
      })
      .catch(() => { if (!destroyed) setFailed(true); });
    return () => {
      destroyed = true;
      try { editorRef.current?.destroyEditor?.(); } catch { /* noop */ }
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, JSON.stringify(config)]);

  if (failed) {
    return (
      <div className={cn("grid place-items-center h-full", className)}>
        <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground text-center px-6">
          <ServerCrash className="size-6" />
          <p>Couldn't reach the exact editor.</p>
          <p className="text-xs">Check the OnlyOffice server is running and <code>ONLYOFFICE_URL</code> is set.</p>
        </div>
      </div>
    );
  }
  return <div className={cn("h-full", className)}><div id={holderId} className="h-full w-full" /></div>;
}

/**
 * Self-contained: fetches a signed editor config for the report's document and
 * mounts the OnlyOffice editor. `target` selects which docx to edit.
 */
export function ExactEditor({
  reportId, target = "redraft", className, onKey, onDocUrl, comments,
}: {
  reportId: string; target?: "redraft" | "source" | "final" | "apply"; className?: string;
  onKey?: (key: string) => void;
  /** Reports the URL of the document actually being edited (for Download). */
  onDocUrl?: (url: string) => void;
  comments?: EditorComment[];
}) {
  const getConfig = useServerFn(getEditorConfig);
  const forceSave = useServerFn(forceSaveEditor);
  const [cfg, setCfg] = useState<{ apiUrl: string; config: unknown } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Latest doc key — used to force-save on ANY unmount (nav, view switch, etc.),
  // not just the explicit close button, so edits are never left mid-save.
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCfg(null); setErr(null);
    getConfig({ data: { reportId, target, origin: window.location.origin } })
      .then((r) => {
        if (cancelled) return;
        setCfg(r); keyRef.current = r.key; onKey?.(r.key);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((r as any).docUrl) onDocUrl?.((r as any).docUrl);
      })
      .catch((e) => { if (!cancelled) setErr((e as Error)?.message ?? "Failed to open editor"); });
    return () => {
      cancelled = true;
      // Any exit path triggers an immediate save (fire-and-forget). The explicit
      // "Back to dashboard" button additionally waits for it to land.
      if (keyRef.current) forceSave({ data: { reportId, key: keyRef.current } }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, target, getConfig]);

  if (err) {
    return (
      <div className={cn("grid place-items-center h-full", className)}>
        <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground text-center px-6 max-w-sm">
          <ServerCrash className="size-6" />
          <p>{err}</p>
          <p className="text-xs">The exact editor needs a running OnlyOffice server. See <code>onlyoffice/README.md</code>.</p>
        </div>
      </div>
    );
  }
  if (!cfg) {
    return (
      <div className={cn("grid place-items-center h-full", className)}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Opening exact editor…
        </div>
      </div>
    );
  }
  return <Editor apiUrl={cfg.apiUrl} config={cfg.config} comments={comments} className={className} />;
}
