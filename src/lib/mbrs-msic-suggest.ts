// AI-suggested MSIC codes for an MBRS filing.
//
// A cosec firm files a different company every time, so "what you used last"
// is worthless — the useful help is "which codes plausibly fit THIS company".
//
// The whole design exists to keep one specific failure closed. An earlier
// version inferred the MSIC code from the audited report and auto-entered it;
// on a real filing that produced 47912 (internet retail) for an engineering
// firm whose actual filing declares 71102 / 71109 / 62099. Two rules follow
// from that, and both are enforced here rather than left to the prompt:
//
//   1. GROUNDED — the model never emits a code from memory. It is given a
//      shortlist drawn from the official list and may only choose within it,
//      and every code it returns is re-checked against the list before the
//      filer ever sees it. An invented code cannot survive that.
//   2. NEVER AUTHORITATIVE — these are candidates the filer picks from, shown
//      beside the report wording they came from, and the field stays flagged
//      as outstanding until a human chooses. Nothing here fills a field.

import { generateWithFallback } from "./gemini";
import { prefilterMsic, isRealMsic, msicLabel } from "./msic";
import { type TokenUsage, EMPTY_USAGE } from "./pricing";

export interface MsicSuggestion {
  code: string;
  label: string;
  /** One short line on why this code fits — shown to the filer, not stored. */
  reason: string;
}

export interface MsicSuggestResult {
  suggestions: MsicSuggestion[];
  usage: TokenUsage;
  model: string;
  /** Why there are no suggestions, when there are none. */
  note?: string;
}

const SYSTEM = `You help a Malaysian company secretary choose MSIC 2008 codes for an SSM MBRS filing.

You are given a company's principal activities as printed in its audited report, and a CANDIDATE LIST of official MSIC codes. Choose the codes from the candidate list that best match the stated activities.

RULES
- Choose ONLY from the candidate list. Never output a code that is not in it.
- Order by how well the code fits the stated activities, best first.
- Return at most 5. Return FEWER if only a few genuinely fit — a short honest list is more useful than a padded one.
- If nothing in the list plausibly matches, return an empty array.
- Judge on the substance of the activity, not on word overlap. "Provision of engineering consultancy" is engineering services even if the label shares no words with it.
- The reason must cite what in the stated activities supports the code, in one short clause. Do not speculate beyond what is stated.

Return ONLY JSON, no markdown fence:
{"suggestions":[{"code":"71102","reason":"states engineering consultancy services"}]}`;

/**
 * Proposes up to 5 MSIC codes for a company from its own principal-activities
 * wording. Returns an empty list (with a note) rather than guessing when the
 * report never states its activities — which is common, and is exactly the
 * case where a guess would be most misleading.
 */
export async function suggestMsicForActivities(
  principalActivities: string,
): Promise<MsicSuggestResult> {
  const text = (principalActivities ?? "").trim();
  if (text.length < 12) {
    return {
      suggestions: [],
      usage: EMPTY_USAGE,
      model: "",
      note: "The report does not state the company's principal activities, so there is nothing to base a suggestion on. Take the codes from the company's SSM registration record.",
    };
  }

  const candidates = prefilterMsic(text, 60);
  if (!candidates.length) {
    return {
      suggestions: [],
      usage: EMPTY_USAGE,
      model: "",
      note: "No MSIC code resembles the activities stated in the report. Search the full list, or take the codes from the SSM registration record.",
    };
  }

  const prompt = [
    SYSTEM,
    "",
    `PRINCIPAL ACTIVITIES AS PRINTED IN THE REPORT:\n${text}`,
    "",
    `CANDIDATE LIST (choose only from these):\n${candidates.map((c) => `${c.code}  ${c.label}`).join("\n")}`,
  ].join("\n");

  const response = await generateWithFallback(
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 2048 },
    },
    { tier: "fast" },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (response.usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    thinkingTokens: m.thoughtsTokenCount ?? 0,
    calls: 1,
  };
  const model = (response as { modelVersion?: string }).modelVersion ?? "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  try {
    parsed = JSON.parse(response.text ?? "{}");
  } catch {
    const mm = (response.text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { parsed = JSON.parse(mm[0]); } catch { /* keep {} */ } }
  }

  // The gate: a proposed code counts only if it is really in the official list
  // AND was on the shortlist we offered. Anything else is dropped silently —
  // it is a hallucination, and showing it to a filer is the whole failure mode.
  const offered = new Set(candidates.map((c) => c.code));
  const seen = new Set<string>();
  const suggestions: MsicSuggestion[] = [];
  for (const raw of Array.isArray(parsed.suggestions) ? parsed.suggestions : []) {
    const code = String(raw?.code ?? "").trim();
    if (!code || seen.has(code)) continue;
    if (!offered.has(code) || !isRealMsic(code)) continue;
    seen.add(code);
    suggestions.push({
      code,
      label: msicLabel(code) ?? "",
      reason: String(raw?.reason ?? "").trim().slice(0, 160),
    });
    if (suggestions.length === 5) break;
  }

  return {
    suggestions,
    usage,
    model,
    note: suggestions.length
      ? undefined
      : "Nothing in the official list confidently matches the stated activities. Search the full list, or take the codes from the SSM registration record.",
  };
}
