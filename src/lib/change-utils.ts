// Shared helpers for sorting + presenting regulatory changes.

type ImpactLevel = "high" | "medium" | "low" | string;

/**
 * Sort changes for the report views:
 *   1. Has matched SOP in KB first, unmatched last (deprioritise no-SOP cards)
 *   2. Within matched: modifications (has old text) before new obligations
 *      (the user-asked "prioritise non-NEW tags first")
 *   3. Within each of those groups: HIGH → MEDIUM → LOW
 *   4. Within each tier: most affected SOPs first
 *   5. Final stable tiebreak: original AI position
 */
function isNewObligation(oldText?: string | null): boolean {
  const s = (oldText ?? "").trim().toLowerCase();
  return !s || s.includes("n/a") || s.includes("new requirement") || s.includes("no prior") || s === "none";
}

export function sortChangesByPriority<T extends {
  chapter_ref?: string | null;
  impact?: ImpactLevel;
  old_requirement?: string | null;
}>(
  changes: T[],
  impactsForChapter: (ref: string) => unknown[]
): T[] {
  const tier = (i?: ImpactLevel): number =>
    i === "high" ? 0 : i === "medium" ? 1 : i === "low" ? 2 : 3;
  // Only impacts that actually reference a KB document (sop_id present) count
  // as "matched" — impacts with sop_id=null are placeholders for "no SOP found"
  // and should NOT promote the card into the matched tier.
  const matchedCount = (ref: string): number =>
    impactsForChapter(ref).filter((imp: any) => !!imp?.sop_id).length;
  return [...changes]
    .map((c, i) => ({
      c, i,
      count: matchedCount(c.chapter_ref ?? ""),
      isNew: isNewObligation(c.old_requirement),
    }))
    .sort((a, b) => {
      // 1. Matched-SOP first (sop_id must be non-null)
      const aMatched = a.count > 0 ? 0 : 1;
      const bMatched = b.count > 0 ? 0 : 1;
      if (aMatched !== bMatched) return aMatched - bMatched;
      // 2. Modifications before new obligations
      const aNew = a.isNew ? 1 : 0;
      const bNew = b.isNew ? 1 : 0;
      if (aNew !== bNew) return aNew - bNew;
      // 3. Impact tier
      const t = tier(a.c.impact) - tier(b.c.impact);
      if (t !== 0) return t;
      // 4. SOP count desc
      const cnt = b.count - a.count;
      if (cnt !== 0) return cnt;
      // 5. Original position
      return a.i - b.i;
    })
    .map((x) => x.c);
}

// ── Word-level diff (LCS) ────────────────────────────────────────────────────
// Tokenises both strings into words+spaces, computes longest common subsequence,
// and returns an array of segments tagged as equal / added / removed.

export type DiffSegment = { type: "eq" | "add" | "del"; text: string };

function tokenise(s: string): string[] {
  // Split on word boundaries but keep delimiters so we can re-stitch with original spacing/punct.
  return (s ?? "").match(/\S+|\s+/g) ?? [];
}

export function diffWords(oldText: string, newText: string): DiffSegment[] {
  const a = tokenise(oldText);
  const b = tokenise(newText);
  const n = a.length;
  const m = b.length;
  // DP table for LCS lengths
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffSegment[] = [];
  let i = 0, j = 0;
  function push(type: DiffSegment["type"], text: string) {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("eq", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", a[i]); i++; }
    else { push("add", b[j]); j++; }
  }
  while (i < n) { push("del", a[i]); i++; }
  while (j < m) { push("add", b[j]); j++; }
  return out;
}

// ── Suggested action derivation ──────────────────────────────────────────────
// Rule-based pattern matcher that returns a short imperative action for common
// RMiT / FATF change archetypes. Falls back to the AI-generated change_summary
// (which is usually already serviceable) when no pattern matches.

const ACTION_PATTERNS: Array<{ match: RegExp; action: (txt: string) => string }> = [
  { match: /kill[\s-]?switch|customer.*(freeze|suspend)/i, action: () => "Implement customer self-service kill switch for account freeze/reactivation" },
  { match: /\bMFA\b|one[\s-]?time password|\bOTP\b|transaction[\s-]?bound/i, action: () => "Upgrade MFA — replace unencrypted SMS OTP with transaction-bound dynamic tokens" },
  { match: /SBOM|software bill of materials|shadow IT/i, action: () => "Adopt SBOM for third-party software inventory; tighten Shadow IT controls" },
  { match: /API.*(inventory|security|rate.?limit|gateway)|application programming interface/i, action: () => "Implement API security controls — inventory, rate limiting, token revocation" },
  { match: /stand[\s-]?in.*process|service continuity|failover/i, action: () => "Build stand-in processing architecture (transition deadline applies)" },
  { match: /uptime|availability.*disclos|public.*disclosure/i, action: () => "Publish quarterly service-availability disclosure" },
  { match: /cryptograph|encryption.*review|cipher/i, action: () => "Shift cryptographic standards review from triennial to annual cycle" },
  { match: /emerging.*tech|quantum|\bAI\b governance/i, action: () => "Establish emerging-technology governance — acceptance criteria + kill-switch readiness" },
  { match: /cloud.*exit|multi[\s-]?cloud|exit strategy/i, action: () => "Document and test cloud exit strategy with alternative-provider plan" },
  { match: /out[\s-]?of[\s-]?band|secure.*comms/i, action: () => "Establish secure out-of-band communications infrastructure" },
  { match: /cyber insurance|loss provision/i, action: () => "Review cyber insurance for conflicts with customer-interest obligations" },
  { match: /scope|applicab|merchant acqui|remittance institut/i, action: () => "Update applicability list — add new covered institution types" },
  { match: /board\b.*(allocate|discuss|oversight)/i, action: () => "Add new topic(s) to board agenda; update governance charter" },
  { match: /VAPT|vulnerab.*assess|penetration test/i, action: () => "Extend vulnerability assessment scope per new frequency mandate" },
  { match: /threat.*report|threat assessment|monthly.*report/i, action: () => "Expand monthly threat reporting scope to all entities" },
];

export function deriveSuggestedAction(change: {
  chapter_ref?: string | null;
  change_summary?: string | null;
  new_requirement?: string | null;
  tone_shift?: string | null;
  title?: string | null;
}): string {
  const haystack = [
    change.title ?? "",
    change.chapter_ref ?? "",
    change.change_summary ?? "",
    change.new_requirement ?? "",
    change.tone_shift ?? "",
  ].join(" \n ");
  for (const p of ACTION_PATTERNS) {
    if (p.match.test(haystack)) return p.action(haystack);
  }
  // Fallback: trim change_summary to one short sentence and ensure imperative tone.
  const summary = (change.change_summary ?? "").trim();
  if (!summary) return "Review and update affected SOPs to align with the new requirement";
  const firstSentence = summary.split(/(?<=[.!?])\s+/)[0] ?? summary;
  return firstSentence.length > 180 ? firstSentence.slice(0, 177) + "…" : firstSentence;
}
