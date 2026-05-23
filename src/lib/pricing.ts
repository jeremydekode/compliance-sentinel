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
 * Gemini price per 1,000,000 tokens, in USD.
 *
 * ⚠️ ASSUMPTION — these are the rates for `gemini-3.5-flash`. If the actual
 * rate differs, edit HERE — the whole app reads the price from this one place.
 * Output rate also covers reasoning ("thinking") tokens.
 */
export const GEMINI_PRICE = {
  model: "gemini-3.5-flash",
  inputUsdPer1M: 0.3,
  outputUsdPer1M: 2.5,
};

/** A token-usage record costed out into dollars. */
export interface RunCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  calls: number;
  inputUsd: number;
  outputUsd: number;
  usd: number;
}

/** Converts metered token usage into a full costed breakdown. */
export function computeCost(usage: TokenUsage): RunCost {
  const billedOutput = usage.outputTokens + usage.thinkingTokens;
  const inputUsd = (usage.inputTokens / 1_000_000) * GEMINI_PRICE.inputUsdPer1M;
  const outputUsd = (billedOutput / 1_000_000) * GEMINI_PRICE.outputUsdPer1M;
  return {
    model: GEMINI_PRICE.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    calls: usage.calls,
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
