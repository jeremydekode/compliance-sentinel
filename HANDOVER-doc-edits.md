# Handover — Doc-editing fidelity (Legal CMS + Simplify v2) + UX fixes

**Paste this whole file into a fresh chat to continue.** The next job is in **§7 — Next task**. Everything before it is context to do that job correctly instead of re-deriving it. (The older `HANDOVER.md` still holds the multi-session foundation context — tenant scoping, Rudy.ai, RLS tiers; this file supersedes it for the doc-editing work.)

Branch: `main` · **Everything here is deployed to production** (`npx vercel --prod` → aliased `https://documentai-sandbox.vercel.app`) but **nothing is committed to git** — all changes are uncommitted working-tree edits. `npx tsc --noEmit` and `npm run build` are clean as of the last check.

---

## 1. TL;DR of current state

Two workspaces were worked on:
- **Simplify v2** — "audit / simplify / redraft a document" (`/simplify2/$reportId`).
- **Legal CMS** — contract review (`/legal`, `/legal/review/$documentId`, `/legal/$matterId`).

The unifying theme is **in-place document editing that preserves the original file's exact formatting** — the **"RHB method"** (RHB is the demo bank; the technique makes previews/downloads look byte-identical to the original except for changed clauses).

The RHB method = one function: **`applySimplificationToDocx()` in `src/lib/docx-editor.ts`**. It edits only the matched paragraph runs inside `word/document.xml`, leaving headers/logo/styles/tables untouched. Modes: `clean`, `redline` (Word tracked changes), `highlight`.

---

## 2. Direct answer: was the RHB method affected?

**No — the RHB in-place engine itself was not touched (git-confirmed).** In `docx-editor.ts` the only change was *appending* a new function (`buildRedlineDocx`, §5.D). `applySimplificationToDocx` / `applyEditsToDocx` / their helpers were **not modified**.

- **RHB in-place engine (`applySimplificationToDocx`)** → untouched. RHB demo docs run through Simplify v2 "simplify" mode, which calls it unchanged.
- **Simplify v2** → changed (new features + bug fixes). The only change on the RHB export path (`applySimplifyV2Report`) is a backward-compatible metadata tweak (a `sig` fingerprint that drops a stale cross-mode download URL when the accepted set changed). The produced document is identical logic to before.
- **Legal CMS** → changed: the in-place method was newly *applied here* (it previously produced an ugly HTML `.doc`), plus bug fixes + UX.

So your understanding is correct: **only Simplify v2 and Legal CMS were affected; the RHB in-place mechanism's output is unchanged.**

---

## 3. Issues we were facing (the "why")

Reported on the **Legal CMS Document Review** screen, mostly on a **PDF** contract (`Generic_Non-Disclosure_Agreement_Anonymised_Final.pdf`):

1. **Comments button didn't work** — the "Comment on selection" composer was a `sticky bottom-3` panel whose *Add comment* button rendered below the window edge → unclickable.
2. **No highlights / couldn't tell where a suggestion came from** — highlighter used exact `text.indexOf(excerpt)`; PDF extraction changes whitespace, so most clauses never matched/highlighted.
3. **AI not helping with proposed changes** — you could only hand-edit a suggested redline; no "ask AI to improve this."
4. **Format can't be shown to client** — for a PDF source the amended version fell back to an HTML `.doc` (Times New Roman, control-char redlines, notice banner) — not client-ready.
5. **Clicking a clause card didn't jump to the text** — it only ringed the highlight on hover; never scrolled the document.

---

## 4. What's already done this session

All **implemented, deployed, tsc+build clean** — but see §8: **none were click-tested in the live authenticated UI** (Google sign-in blocks the automated browser).

**Legal CMS Document Review (the 5 issues):**
1. Comment composer → centered modal `Dialog` (always reachable; ⌘/Ctrl+Enter submits).
2. Highlighter → whitespace-normalized matching mapped back to original offsets → clauses reliably highlight on PDF text.
3. New **"✨ Improve with AI"** per clause → `refineClauseSuggestion` rewrites that clause's redline from a free-text instruction.
4. Amended export: **DOCX source → in-place edit (RHB method, tracked changes)**; **PDF/text → new clean rebuilt `.docx`** with real Word tracked changes (`buildRedlineDocx`) — no banner, Calibri, 1" margins.
5. Clause card header is a button → selects **and** smooth-scrolls the document to the highlight; toasts if the clause couldn't be located.

**Simplify v2 (earlier):**
- New **"Edit with AI"** on the document view (`requestTargetedEdit`).
- New **"Apply in place"** for Recommend & Edit (`applyFindingsInPlaceV2Report`) — RHB method alternative to full redraft; skips findings it can't cleanly swap (incompleteness / multi-evidence / empty-fix) and lists them for manual review.
- Bug fixes: empty-`suggestedFix` no longer silently deletes a clause; `apply`/`restructure` cleared after Edit-with-AI; stale cross-mode URL fixed via `sig`; annotated re-apply guarded on `accepted===0`.

**Legal CMS bug fixes (earlier):**
- Orphaned-matter-on-retry in `openRequest` fixed (matter created first, upload failures collected, still land on the matter → no duplicate).
- Missing tenant guard added to `recordShareDownload`.
- `escalate.isPending` added to `busy` (was double-submittable).
- `genVersion` invalidates matter queries.

**Other UX (earlier):** hid DMS workspace/"viewing as" bar inside Legal CMS; clause-card restructure (risk reason → details → suggested edit); intake description hint (needs ≥10 chars).

---

## 5. Key files & functions

**A. `src/lib/docx-editor.ts`**
- `applySimplificationToDocx(buffer, edits: SimplifyDocxEdit[], {author, mode, redlineComments})` — **THE RHB METHOD.** `SimplifyDocxEdit = {before, after, rationale?, ...}`. **Untouched this session.**
- `buildRedlineDocx(redline, {author})` — **NEW.** From-scratch clean `.docx` (real `<w:ins>`/`<w:del>`) from a redline string using control-char markers (`\x01 del \x02`, `\x03 ins \x04`). Only for PDF/text (no source DOCX). Unit-tested (valid zip, mammoth parses).
- `rebuildDocxBody(...)` — full body regenerate (Simplify recommend_edit "Generate redraft"); loses per-run fidelity by design.

**B. `src/lib/compliance.functions.ts`** (Simplify v2)
- `applySimplifyV2Report` — Simplify-mode export (RHB path); got the `sig` stale-URL fix.
- `applyFindingsInPlaceV2Report` — **NEW.** Recommend&Edit in-place export (RHB method).
- `requestTargetedEdit` — **NEW.** Edit-with-AI.
- `generateRestructuredV2Document` — full-redraft path (unchanged).
- `readV2Source(url)` → `{text, units, structure, isDocx, buffer}`.

**C. `src/lib/legal.functions.ts`** (Legal CMS) — **main file for the next task**
- `createAmendedVersion` — **HEAVILY CHANGED.** DOCX source → `applySimplificationToDocx` (RHB); PDF/text → `buildRedlineDocx`. Writes a synthetic `ai_review` so the draft opens in-app.
- `reviewLegalDocument` / `reviewCounterpartyMarkup` — produce `ai_review.clauses[]`: `{ref, excerpt, originalExcerpt?, severity, category, comment, suggestion, accepted}`. **`excerpt` = "before", `suggestion` = "after".**
- `refineClauseSuggestion` — **NEW.** Per-clause AI redraft.
- `acceptClauseSuggestion` — persists `accepted` + wording overrides.
- `addDocumentAnnotation` / `deleteDocumentAnnotation` — highlight-to-comment.

**D. Routes**
- `src/routes/legal.review.$documentId.tsx` — review UI (`HighlightedContract`, clause cards, comment `Dialog`, AI-refine, `focusClause` click-to-scroll).
- `src/routes/simplify2.$reportId.tsx` — Simplify v2 doc view (`EditWithAiButton`).
- `src/components/simplify-findings.tsx` — `RestructurePanel` (Apply-in-place + Generate-redraft).

---

## 6. Mapping notes for in-place edits

- **Legal (our-paper):** source = `doc.file_url`. `before = clause.excerpt`, `after = clause.suggestion`, gate on `clause.accepted`.
- **Legal (counterparty):** `clause.excerpt` is verbatim from the counterparty file (`doc.file_url`); `clause.originalExcerpt` is from our original. Editing `doc.file_url` in place → `before = excerpt`. `originalExcerpt` may be empty (new content) → can't in-place-replace.
- **Match failures:** `applySimplificationToDocx` matches `before` **within a single paragraph** (quote-normalized, case-insensitive fallback). A `before` crossing a paragraph/table-cell boundary won't anchor → lands in `result.skipped`. **This is the main fidelity risk.**

---

## 7. NEXT TASK — perform the doc edits exactly like RHB

**Goal:** make Legal CMS "Generate amended version" (and, if in scope, Simplify v2 Recommend&Edit "Apply in place") produce edits with the **exact same fidelity and behavior as the RHB/Simplify in-place export** — verified end-to-end on a real document.

Steps:
1. **Test on a real DOCX in Legal CMS** (not a PDF). Run the review, accept a few clauses, click **Generate amended version**, download, open in Word. Confirm: original formatting/headers/logo preserved; accepted clauses appear as **tracked changes** with the rationale comment; `result.skipped` clauses are surfaced clearly (they currently appear in the synthetic change list as `located:false`).
2. **Compare against RHB/Simplify parity.** RHB docs go through `applySimplifyV2Report`; Legal now calls the same `applySimplificationToDocx`. Diff the two call sites — same `mode`/`redlineComments`/`author` conventions? Anything Legal is missing?
3. **Consider clean/annotated choice for Legal** like Simplify has (Simplify offers "Tracked changes" + "Clean copy"; Legal currently produces one tracked-changes docx). Decide with the user.
4. **Improve match rate** — the biggest fidelity gap vs RHB is clauses that fail single-paragraph matching. Consider feeding tolerant located spans into the DOCX editor. Note: `createAmendedVersion` already has server-side tolerant locate (`buildNormMap`/`locateClauseSpan`) used for the PDF text redline — that logic could inform a better DOCX match.
5. **PDF path** — confirm `buildRedlineDocx` output opens cleanly in Word and reads well (user approved "clean rebuilt Word .docx" for PDFs — no original layout to preserve).

**Verification the next session MUST do (this session could not):** drive the authenticated UI end-to-end. Google OAuth blocks the automated browser here, so all of §4 is build-verified only.

---

## 8. What is / isn't proven

- **Proven:** `tsc` clean, `npm run build` clean, dev boots with no console/server errors, prod 200 on `/legal` and `/reports`, `buildRedlineDocx` unit-tested (valid zip, tracked changes present, mammoth parses).
- **NOT proven:** any click-through of the live authenticated flows — comments, AI-refine, click-to-scroll, and **especially the amended-version DOCX opening correctly in Word.** #1 thing to verify next.

---

## 9. Standing constraints & environment

- Local + prod Supabase share **one** database — a migration hits both at once.
- Migration SQL as fenced ` ```sql ` blocks in chat — never `pbcopy`.
- Never print service-role/secret keys. Read-only scratch scripts via `node --env-file=.env` (service role) are an accepted pattern — never echo the key.
- **Deploy** = `npx vercel --prod` (Vercel is git-disconnected; ships local disk regardless of commit state). Aliased URL `https://documentai-sandbox.vercel.app`.
- Only commit/deploy when the user asks. Nothing is committed; everything is deployed.
- RLS is Tier-1 only (app-level `assertRowTenant`/`getCallerTenant`); DB-level tenant RLS (Tier 2) deferred.
- Demo account seen: `dabraj3@gmail.com` (was `viewer`; promoted to `member` so uploads to the `policies` storage bucket work — that bucket's insert policy requires `super_admin`/`member`).
