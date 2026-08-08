// Cost metering for Gemini model runs.
//
// Token counts come straight from the API's `usageMetadata` — they are EXACT,
// not estimates. The per-token PRICE is the only assumption: it lives in one
// constant below, so when Google's pricing changes (or the real rate is
// confirmed) it is a single-line edit.

/** Tokens consumed by one or more model calls. */
export interface TokenUsage {
  /** promptTokenCount — what we sent. */
  inputTokens: number;
  /** candidatesTokenCount — the model's answer. */
  outputTokens: number;
  /** thoughtsTokenCount — reasoning tokens; billed at the output rate on Gemini 2.5+. */
  thinkingTokens: number;
  /** number of model calls aggregated. */
  calls: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  calls: 0,
};

/** Sums two usage records. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    calls: a.calls + b.calls,
  };
}

/**
 * Gemini price per 1,000,000 tokens, in USD, per model. Output rate also
 * covers reasoning ("thinking") tokens.
 *
 * ⚠️ ASSUMPTION — edit HERE when Google's pricing changes; the whole app reads
 * prices from this one map.
 */
export const MODEL_PRICES: Record<string, { inputUsdPer1M: number; outputUsdPer1M: number }> = {
  "gemini-2.5-pro":        { inputUsdPer1M: 1.25, outputUsdPer1M: 10.0 },
  "gemini-3.5-flash":      { inputUsdPer1M: 0.3,  outputUsdPer1M: 2.5 },
  "gemini-2.5-flash":      { inputUsdPer1M: 0.3,  outputUsdPer1M: 2.5 },
  "gemini-3.1-flash-lite": { inputUsdPer1M: 0.1,  outputUsdPer1M: 0.4 },
  "gemini-2.0-flash":      { inputUsdPer1M: 0.1,  outputUsdPer1M: 0.4 },
};

/** Legacy single-rate constant — kept for old call sites; rates = 3.5-flash. */
export const GEMINI_PRICE = {
  model: "gemini-3.5-flash",
  inputUsdPer1M: 0.3,
  outputUsdPer1M: 2.5,
};

/** A token-usage record costed out into dollars. */
export interface RunCost {
  /** The model actually reported by the API, verbatim. */
  model: string;
  /** The MODEL_PRICES key its rate came from (may be a prefix of `model`). */
  pricedAs: string;
  /** True when the model was unknown and the legacy rate was assumed. */
  priceIsEstimated: boolean;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  calls: number;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  inputUsd: number;
  outputUsd: number;
  usd: number;
}

/**
 * Resolves a model id to its price row. The API reports the model it actually
 * answered with (`modelVersion`), which is often a dated/preview variant like
 * "gemini-2.5-pro-preview-06-05" — an exact-key lookup misses those and would
 * silently fall back to the wrong rate, so match the longest known prefix too.
 * Returns null when the model is genuinely unknown, so callers can say so
 * rather than quietly reporting a made-up number.
 */
export function resolveModelPrice(
  model?: string | null,
): { key: string; inputUsdPer1M: number; outputUsdPer1M: number } | null {
  if (!model) return null;
  const exact = MODEL_PRICES[model];
  if (exact) return { key: model, ...exact };
  const prefix = Object.keys(MODEL_PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? { key: prefix, ...MODEL_PRICES[prefix] } : null;
}

/**
 * Converts metered token usage into a full costed breakdown, priced at the
 * given model's rate. When the model is unknown or unspecified this falls back
 * to the legacy 3.5-flash rate and flags the result as `priceIsEstimated`, so
 * the UI can mark it rather than present a guess as fact.
 */
export function computeCost(usage: TokenUsage, model?: string): RunCost {
  const resolved = resolveModelPrice(model);
  const price = resolved ?? GEMINI_PRICE;
  const billedOutput = usage.outputTokens + usage.thinkingTokens;
  const inputUsd = (usage.inputTokens / 1_000_000) * price.inputUsdPer1M;
  const outputUsd = (billedOutput / 1_000_000) * price.outputUsdPer1M;
  return {
    model: model ?? GEMINI_PRICE.model,
    pricedAs: resolved?.key ?? GEMINI_PRICE.model,
    priceIsEstimated: !resolved,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    calls: usage.calls,
    inputUsdPer1M: price.inputUsdPer1M,
    outputUsdPer1M: price.outputUsdPer1M,
    inputUsd,
    outputUsd,
    usd: inputUsd + outputUsd,
  };
}

/** Formats a USD amount — small run costs need more precision than $0.01. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Compact token formatting — 12,345 -> "12.3K". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
