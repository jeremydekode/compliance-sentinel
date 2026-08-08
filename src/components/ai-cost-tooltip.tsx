import { useState } from "react";
import { Sparkles } from "lucide-react";
import { formatUsd, formatTokens, resolveModelPrice } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/** One metered model call, as written to summary_json.costLog. */
interface CostLogEntry {
  op: string;
  usd: number;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  pricedAs?: string;
  priceIsEstimated?: boolean;
  inputUsd?: number;
  outputUsd?: number;
  at?: string;
}

/** Human labels for the op keys written by the server functions. */
const OP_LABELS: Record<string, string> = {
  mbrs_extract: "Read statements (text layer)",
  mbrs_extract_ocr: "Read statements (OCR — scanned pages)",
  mbrs_narratives: "Narrative disclosures",
  mbrs_xbrl: "XBRL generation",
};

function opLabel(op: string): string {
  return OP_LABELS[op] ?? op.replace(/_/g, " ");
}

/**
 * Hover chip showing exactly what a filing cost in AI spend, itemised per
 * model call: input vs output tokens, the model that actually answered, and
 * the rate each was billed at.
 *
 * Deliberately reads from `costLog` (every metered call, appended as it
 * happens) rather than the rolled-up `usage` total — a run that fell back to a
 * different model mid-way is billed at two different rates, and only the log
 * preserves that. Falls back to the rolled-up total when no log exists (rows
 * extracted before the log carried model info).
 */
export function AiCostTooltip({
  costLog,
  fallbackUsd,
  ocrUsed,
  className,
}: {
  costLog?: CostLogEntry[];
  /** Rolled-up total for rows with no itemised log. */
  fallbackUsd?: number;
  ocrUsed?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const entries = Array.isArray(costLog) ? costLog : [];
  const total = entries.length
    ? entries.reduce((n, e) => n + (Number(e.usd) || 0), 0)
    : Number(fallbackUsd) || 0;

  if (!(total > 0)) return null;

  const totalIn = entries.reduce((n, e) => n + (e.inputTokens ?? 0), 0);
  const totalOut = entries.reduce((n, e) => n + (e.outputTokens ?? 0), 0);
  const totalCalls = entries.reduce((n, e) => n + (e.calls ?? 1), 0);
  const anyEstimated = entries.some((e) => e.priceIsEstimated);
  const itemised = entries.length > 0 && totalIn + totalOut > 0;

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        tabIndex={0}
        role="button"
        aria-label={`AI cost ${formatUsd(total)} — hover for the breakdown`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground hover:text-foreground hover:border-border transition-colors cursor-default focus:outline-none focus:ring-2 focus:ring-teal-500/30"
      >
        <Sparkles className="size-3" />
        {formatUsd(total)}
      </span>

      {open && (
        // Fixed-position-free: the row isn't overflow-clipped, and right-0
        // keeps a wide panel inside the card on narrow screens.
        <div className="absolute right-0 top-full z-40 mt-1.5 w-[22rem] rounded-lg border bg-popover text-popover-foreground shadow-lg p-3 text-left cursor-default">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-bold">AI cost for this filing</span>
            <span className="text-sm font-bold tabular-nums">{formatUsd(total)}</span>
          </div>

          {itemised ? (
            <>
              <table className="mt-2.5 w-full text-[11px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left font-medium pb-1">Step</th>
                    <th className="text-right font-medium pb-1">In</th>
                    <th className="text-right font-medium pb-1">Out</th>
                    <th className="text-right font-medium pb-1">Cost</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {entries.map((e, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="py-1 pr-2 text-foreground/90">{opLabel(e.op)}</td>
                      <td className="py-1 text-right text-muted-foreground">{formatTokens(e.inputTokens ?? 0)}</td>
                      <td className="py-1 text-right text-muted-foreground">{formatTokens(e.outputTokens ?? 0)}</td>
                      <td className="py-1 pl-2 text-right">{formatUsd(e.usd)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border">
                    <td className="pt-1.5 font-semibold">Total · {totalCalls} call{totalCalls === 1 ? "" : "s"}</td>
                    <td className="pt-1.5 text-right font-semibold">{formatTokens(totalIn)}</td>
                    <td className="pt-1.5 text-right font-semibold">{formatTokens(totalOut)}</td>
                    <td className="pt-1.5 pl-2 text-right font-semibold">{formatUsd(total)}</td>
                  </tr>
                </tbody>
              </table>

              <div className="mt-2.5 pt-2 border-t border-border/50 space-y-1 text-[11px] text-muted-foreground">
                {[...new Set(entries.map((e) => e.model || e.pricedAs).filter(Boolean))].map((m) => {
                  const price = resolveModelPrice(m as string);
                  return (
                    <div key={m as string} className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[10px] text-foreground/80 truncate">{m as string}</span>
                      {price && (
                        <span className="shrink-0 tabular-nums">
                          ${price.inputUsdPer1M}/M in · ${price.outputUsdPer1M}/M out
                        </span>
                      )}
                    </div>
                  );
                })}
                {ocrUsed && (
                  <p className="pt-1 leading-snug">
                    Scanned report — the PDF pages were sent as images for OCR, so their
                    image tokens are counted inside the input figure above.
                  </p>
                )}
                <p className="pt-1 leading-snug">
                  Token counts are metered exactly by the API. Output includes reasoning
                  tokens, billed at the output rate.
                  {anyEstimated && " Rate assumed for an unrecognised model."}
                </p>
              </div>
            </>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground leading-snug">
              Recorded before per-step metering was added, so only the total is
              available. Re-extract to get the itemised breakdown.
            </p>
          )}
        </div>
      )}
    </span>
  );
}
