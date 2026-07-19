# Handover — RHB demo week: tenant scoping, Simplify v2, Rudy.ai

Branch: `feat/auth-login-rls-policy-workflow` · **Nothing committed** — every change below is an uncommitted working-tree edit · `npx tsc --noEmit` clean and `npm run build` passes as of last check.

Paste this whole file into a new chat to pick up where this session left off. The next session's job is stated in **§6 — what to do next**; everything before that is context to make those fixes correctly instead of re-discovering this from scratch.

---

## 1. Why this happened

Client demo for **RHB** (a Malaysian bank) on **Friday 24 Jul**. Across several sessions this grew from "reskin the app for RHB" into: a real multi-tenant system (so other banks can be demoed without ever seeing RHB's files), a rebuilt "Simplify v2" workspace (audit / simplify / redraft an existing doc, or draft a new one from a brief), "Rudy.ai" — a chat concierge that routes requests to the right workflow, and a full code-review pass that found and fixed 8 confirmed bugs. **None of this has been used by a real signed-in human yet** — verification so far is typecheck + prod build + one $0.05 automated pipeline test + read-only DB checks. See §5 for exactly what is and isn't proven.

Standing constraints (still binding, carried from the project's memory):
- Local + prod Supabase share **one** database — every migration pasted into the SQL editor hits both at once, immediately.
- Give migration SQL as fenced ` ```sql ` blocks in chat — never `pbcopy`.
- Never print service-role/secret keys. Scratch scripts using the service role (via `node --env-file=.env`) for read-only verification or seeding are an established, fine pattern this session — just never echo the key itself.
- Only commit or deploy when the user explicitly asks. Nothing this session has been committed or deployed.
- `.env` and `scratch/` are gitignored.

---

## 2. What was built, in order

### A. Multi-tenant document scoping (the foundation everything else sits on)
Every document (`analysis_reports`, `sop_documents`, `legal_matters`, `legal_kb_entries`) now belongs to a tenant. A DB trigger (`stamp_tenant_id`, in `20260720_tenant_scoping.sql`) auto-stamps `tenant_id` on every insert from the caller's `profiles.tenant_id` — can't be forgotten. Server functions resolve the caller's tenant via `getCallerTenant(userId)` (`src/lib/tenant.functions.ts`) and filter reads by it. Tenants also carry a `features text[]` column (workspace ids + `legal_cms`/`rudy`/`create_document`) that gates the sidebar, workspace switcher, and Rudy per tenant (Settings → Tenants → checkboxes).

**This is Tier 1 (application-level) enforcement only.** RLS is still role-only (`using(true)` for any approved user) — a real DB-level tenant boundary (Tier 2) was explicitly deferred to after the demo. This matters a lot for §6.

Two tenants exist today: `rhb` (real content, backfilled) and `acme` ("Document Demo" — generic branding, seeded with a full clone of RHB's library for showing other prospects without exposing RHB's name/files).

### B. The clone/seed tool
`clone_demo_to_tenant` Postgres function (`20260721_clone_demo_tool.sql`) copies reports + KB docs **with their embedding chunks** into another tenant, entirely in Postgres (no re-upload, no re-embedding — files are shared by URL). Exposed as **Settings → Tenants → "Seed demos"** — a popup listing RHB's library with checkboxes, calling `listSeedableContent`/`seedTenantDemo` (`compliance.functions.ts`). This button was found broken (state set, nothing rendered) and fixed in the last exchange — untested since the fix, worth a click-through.

### C. Simplify v2 — new workspace, three modes
Lives in `src/routes/simplify2.$reportId.tsx` + `src/components/simplify-v2-upload-dialog.tsx`, `simplify-findings.tsx`, `simplify-health.tsx`, `doc-viewer.tsx`, engine in `src/lib/recommend.ts`. **The old Simplify workspace (`simplify.$reportId.tsx` etc.) is completely untouched** — kept as a working backup.

- **Simplify** — same per-paragraph rewrite engine as v1, new document-centric UI.
- **Recommendation** — a 6-pass audit pipeline (`runAuditPipeline`): claim extraction → cross-section clustering → consistency check → completeness check → dual-gate verification (deterministic quote-match + evidence-only LLM re-check). Produces `Finding[]` across 9 categories (contradiction, incompleteness, ambiguous_actor, undefined_term, stale_reference, redundancy, sequencing, structural, non_verifiable), each with verbatim evidence and a confidence score. Two categories (`stale_reference`, `undefined_term`) are found by **deterministic code**, not AI.
- **Recommend & Edit** — audit, then (after a human reviews findings) `generateRestructured`: outline pass → per-section regeneration → bidirectional content-preservation check (claims extracted from the output must trace back to the source or an accepted finding) with a capped 2-iteration repair loop. Output is written back into the **original DOCX package** via `rebuildDocxBody` (`docx-editor.ts`) — logo/headers/styles survive; only the body is regenerated.

**Intake is scan-first**: upload → `scanDocumentV2` (cheap, ~15s, ~pennies) returns stats + observations + a recommended action → user picks Find gaps / Light simplify / Max simplify (aggressive page-reduction profile) / Full redraft, only then does the expensive pipeline run.

**Dashboards** (`simplify-health.tsx`): every report lands on a full-width card-grid dashboard (severity tiles, category bars, a section "heat map", clean-sections list) instead of the raw findings list. Each card has three actions: 👁 **View** (popup: document scrolled to the highlight, with a reason/evidence/suggested-fix rail beside it), ✓ **Accept**, ✎ **Edit** (refine the suggested fix/replacement text — persisted via `updateV2FindingFix`/`updateV2ActionAfter`, and what the restructure stage actually implements).

**Export**: clean copy (no markup) or annotated copy (Word tracked-changes + comments for Simplify mode; anchored Word comments per change for restructures, since tracked-changes is unreadable on a whole-document rewrite).

### D. Rudy.ai
`src/lib/rudy.functions.ts` + `src/components/rudy-chat.tsx`. Floating chat button on every page (tenant-branded, hidden if the tenant lacks the `rudy` feature). Interviews the user, can accept an uploaded document and answer "how does this impact us" against the tenant's KB (RAG via `match_sop_chunks`), then proposes **one** action as a confirmation card (`{reply, action}` JSON contract) — the model never triggers anything; the user must click Confirm. Routes to: `simplify_v2` (any of the 3 modes), `redraft` (auto-chain: audit → auto-accept *verified-only* findings → generate, with a progress banner in the simplify2 header), `regulatory`, `create_document`.

### E. Model picker
Settings → AI Model: pick the app-wide default (gemini-2.5-pro / 3.5-flash / 2.5-flash / 3.1-flash-lite). It leads the "quality" tier's fallback chain; on failure (any error, not just capacity) it falls through to the standard chain rather than aborting. Fast-tier (mechanical batch calls) is untouched by this picker. Cost is priced per-model (`pricing.ts` `MODEL_PRICES` map) — **but only at the v2 call sites**; see §6.

### F. Create document from brief
Settings-free: New Analysis → "Create new document" → title/type/brief + a "donor" doc (any tenant-scoped DOCX) whose package the draft wears. `generateDocumentFromBrief` (`recommend.ts`) plans an outline (house skeleton: Purpose/Scope/Definitions/Policy Statements/Procedures/Roles/Escalation/Review Cycle/Appendices), generates each section, marks unknowns as `[OWNER TO CONFIRM: ...]` instead of inventing specifics.

### G. Code-review pass (8 confirmed bugs, all fixed)
A 5-angle multi-agent review of the whole diff found ~30 candidates; 8 were verified as real bugs and fixed:
1. **By-id server functions had no tenant check** — a report/matter UUID from another tenant could be read/re-run/exported/deleted cross-tenant. Fixed via `assertRowTenant(rowTenant, callerTenant)` on `deleteReport`, `runSimplifyV2Report`, `setV2FindingDecision`, `updateV2FindingFix`, `bulkSetV2FindingDecision`, `applySimplifyV2Report`, `generateRestructuredV2Document`, and `getLegalMatter`. **This fix is NOT applied everywhere — see §6.a, it's the top item.**
2. `getCallerTenant` failed open on any DB error (wrong-tenant fallback + bypassed feature gates) — now throws on real errors, only a genuinely-missing profile falls back to `default`.
3. Rudy's redraft auto-chain accepted every non-quarantined finding, including unverified (`review`-status) ones — now verified-only.
4. Simplify-mode highlight ids were built from a filtered array index while the rail used the original index — clicking a card could highlight the wrong text once anything was quarantined. Fixed.
5. Re-running a v2 report left stale `apply`/`restructure` outputs next to the fresh results (and blocked the redraft auto-chain forever). Runs now null both out.
6. `detectStaleCrossRefs` false-positived on documents with unnumbered headings + one appendix. Fixed (each namespace guards its own emptiness).
7. Rudy could silently substitute a stale chat attachment for the wrong indexed document. Fixed (attachment only stands in when the action explicitly targets `"uploaded"`).
8. Plus: v1 simplify cost was mis-priced at a flat rate regardless of the picked model (partially fixed, see §6); the admin-picked model could abort a whole run on an incompatible-config error instead of falling back (fixed); legal KB seed dedupe wasn't tenant-scoped (fixed); a Firefox click-to-select fallback was missing (fixed); several duplicated constants/dead helpers were consolidated (`ALL_FEATURES`, `SIMPLIFY_TYPE_LABEL`, Rudy's workflow registry now derives from one `CATALOG` array instead of four hand-synced lists).

Plus a layout pass: the "View in document" popup was cropping its right-hand rail (fixed-width Word pages forced grid overflow). Fixed with `minmax(0,1fr)` grid tracks + `min-w-0` everywhere the doc viewer sits, plus a **zoom-to-fit** mechanism in `doc-viewer.tsx` that scales the rendered page down to whatever pane it's in.

---

## 3. Data model reference

| Migration (all applied to the live shared DB) | What it does |
|---|---|
| `20260716_tenant_branding.sql` | `tenants` table (slug, name, tagline, logo_url, 4 color columns) |
| `20260720_tenant_scoping.sql` | `tenants.features`, `tenant_id` on the 4 document tables, `stamp_tenant_id` trigger, backfill to `'rhb'`, `app_settings` table (holds the model-picker value) |
| `20260721_clone_demo_tool.sql` | `clone_demo_to_tenant(report_ids, sop_ids, target)` — service-role only |

`analysis_reports.summary_json` (jsonb) is where almost everything lives for v2 reports — no dedicated tables. Key shape by `workflow_mode`:
- `"simplify"`: `actions[]` (VerifiedAction), `apply: {cleanUrl?, annotatedUrl?}`
- `"recommend"` / `"recommend_edit"`: `findings[]` (Finding), `claims[]`, `audit: {counts}`, `structure`, and for R&E after generation: `restructure: {downloadUrl, annotatedUrl, changeReport[], preservation}`
- `"create"`: `created: {downloadUrl, outline}`, `doc_brief: {title, docType, brief, donorReportId}`

`analysis_guidance` table holds editable prompts, keyed by a string (workspace id, or `"simplify_v2_recommend"` for the audit-mode prompt) — shared across tenants, not tenant-scoped.

---

## 4. Key files

| Area | File |
|---|---|
| Tenant resolution + guards | `src/lib/tenant.functions.ts` (server), `src/lib/tenant.ts` (client, `ALL_FEATURES` single source) |
| Audit + restructure + create-from-brief engine | `src/lib/recommend.ts` |
| All v2 server functions | `src/lib/compliance.functions.ts` (search `Simplify V2`, `Rudy`, `Demo seeding`, `AI model settings`) |
| Rudy | `src/lib/rudy.functions.ts`, `src/components/rudy-chat.tsx` |
| Document rendering + highlight/zoom-fit | `src/components/doc-viewer.tsx` |
| Dashboards | `src/components/simplify-health.tsx` |
| Findings/actions review rail | `src/components/simplify-findings.tsx` |
| Simplify v2 route (all 3 modes + create) | `src/routes/simplify2.$reportId.tsx` |
| Upload/scan/intent dialog | `src/components/simplify-v2-upload-dialog.tsx` |
| DOCX mutation (clean/redline/rebuild) | `src/lib/docx-editor.ts` |
| Model pricing + fallback chain | `src/lib/pricing.ts`, `src/lib/gemini.ts` |
| Tenants admin + model picker UI | `src/routes/settings.tsx` |
| Deploy config (Vercel fn timeout) | `vercel.json` — `"functions": {"api/server.js": {"maxDuration": 300}}` |

---

## 5. What's actually been verified vs. not

**Verified**: `npx tsc --noEmit` clean, `npm run build` passes, dev server loads with no console errors, a per-workspace/per-tenant data-isolation query matrix (zero cross-tenant leakage, zero stranded null-tenant rows), and **one** real pipeline run: the full 6-pass audit executed on a **25k-character truncated slice** of a real SOP (not the whole document), cost $0.049, took 28s, produced plausible findings with the verification gate correctly rejecting one.

**Not verified — this is the gap**: no human has clicked through Rudy, the scan→intent→run flow, the redraft auto-chain, create-from-brief, or the export/download paths in a real browser session (Google OAuth blocks automation, so an agent can't sign in). More importantly: **no workflow has been run on a full-size real document** — only the truncated slice. The 6-pass audit, the restructure generation (outline + N section-generation calls + repair loop), and create-from-brief have an unknown wall-clock time at real scale.

---

## 6. What to do next (the actual ask)

Go through the code thoroughly for bugs, wrong-altitude architecture, timeout risk, and prompt/tool quality. Concretely:

### a. Finish the by-id tenant-check pass (highest priority — security gap, not just perf)
The 8 v2 functions + `getLegalMatter` got `assertRowTenant`/inline tenant checks. **These did not**, and carry the identical class of bug (any signed-in user who has/guesses a report ID can read/mutate it regardless of tenant):
- v1 Simplify: `setSimplificationDecision`, `bulkSetSimplificationDecision`, `applySimplificationReport`, `runSimplificationReport`, `createSimplificationReport`'s downstream reads.
- Regulatory/RMiT/FATF/Forms/Policy: `startRegulatoryRerun`, `mapRegulatoryChange`, `analyzeRegulatorySop`, `finalizeRegulatoryReport`, `chatWithReport`, `updateImpact`, `markPendingManual`, `confirmManualCompletion`, `generateDocumentPreview`, `finalizeDocumentAmendment`, `createFormUpdateReport`/`rerunFormUpdateReport`.
- Credit Risk: everything in `credit.$reportId.tsx`'s backing functions (`analyzeCreditRisk`, `askCreditRisk`, mitigation/anomaly/adverse-news functions).
- Legal: `requestLegalSignOff`, `finalizeLegalSignOff`, `attachLegalDocument`, `createAmendedVersion`, `publishToKnowledgeBase`.
- Layout: the entire `layout.functions.ts` / `layout_jobs` table has **no `tenant_id` column at all** — it was outside the audited read-path inventory. Either add the column + stamping trigger + checks, or (faster) untick "Retail Layout Planner" in the feature checkboxes for any non-`rhb` tenant so the gap is unreachable.

Pattern to reuse: `getCallerTenant(context.userId)` → `assertRowTenant(row.tenant_id, tenantId)` (both in `tenant.functions.ts`), same shape as the fixed functions.

### b. Timeout / architecture risk — nothing has been load-tested
- `vercel.json` sets `maxDuration: 300` for `api/server.js`. **Confirm this matches the actual Vercel plan tier** (Hobby/Pro/Enterprise have different real ceilings and some require Fluid Compute or an Enterprise plan to reach 300s/5min — verify against current Vercel docs and the account's plan, don't assume the config value is honored).
- Run the **full, untruncated** audit pipeline (`runAuditPipeline`) on a real 100+ page SOP and measure wall-clock. It's 6 sequential-ish passes with internal concurrency (batches of 50 units at concurrency 4 for claims; concurrency 4 for cluster-consistency; concurrency 3 for completeness chunks) — on a large enough document this could plausibly approach or exceed 300s. If it does, the fix is architectural, not a tweak: split the pipeline across multiple serverFn calls (e.g. claims-extraction as call 1, clustering+consistency as call 2, completeness+verification as call 3), have the client chain them with a status field in `summary_json` between calls, so no single request needs the whole budget and partial progress survives a timeout.
- Same concern for `generateRestructured` (outline + concurrency-3 per-section generation + up to 2 repair iterations) and `generateDocumentFromBrief` — more outline sections = more sequential-ish LLM calls.
- Rudy's uploaded-document path (`rudyChat` with `fileUrl` set) does a fresh download + text extraction + embedding + `match_sop_chunks` RPC **on every chat message** while the attachment stays set (not cached) — for a large attached file, latency and embedding spend scale with conversation length instead of once per attachment. Worth fixing regardless of timeout risk (it's also a cost bug).
- Supabase side: `match_sop_chunks` is a **global, non-tenant-scoped** RPC — every caller over-fetches across all tenants' chunks and relies on an app-level id-set post-filter. Fine at today's scale (a few thousand chunks); worth watching as more tenants/documents accumulate (both for correctness — a tenant with more KB docs than the id-set's row cap could get incomplete RAG — and for the query's own latency).
- Every Accept/Reject/Edit click does a **whole-`summary_json`-blob** read-modify-write (no JSONB path update, no version check) — on a large report (100+ findings/actions) this is a lot of data moved per click, and two fast clicks can race (last write wins, silently reverting the earlier one). Not urgent, but real.

### c. Prompt/quality tuning — needs a real document, not the truncated slice
`DEFAULT_RECOMMEND_GUIDANCE` and the pass-level prompts in `recommend.ts` (extractClaims, checkClusterConsistency, checkCompleteness, planOutline, generateSection, generateDocumentFromBrief's outline/section prompts) were designed but only exercised against a 25k-char slice. Run each mode against a full real RHB SOP and judge: are findings actually useful (not noisy), is severity calibration sane, does Max Simplify actually hit the ~30% reduction target, does a redraft's preservation score stay high on a real document. Tune the guidance text (editable live in Settings, or the `DEFAULT_*` constants) based on what you see — this is the "right tools/prompts for optimal results" part of the ask.

### d. Known, deliberately-deferred or lower-priority debt (don't need to fix unless you have time)
- Tier 2 RLS (a real DB-level tenant wall) — deferred by design, not a bug.
- `computeCost` still prices at the flat 3.5-flash rate (ignoring the picked model) at the credit-risk, layout, and legal call sites — only the v1/v2 Simplify sites were fixed to pass the actual model.
- `SEVERITY_META`/`SEV_META` are duplicated between `simplify-findings.tsx` and `simplify-health.tsx` (same values, two places — a color/label tweak needs both). `parseRudyJson` duplicates existing JSON-salvage logic elsewhere in `gemini.ts`/`layout.functions.ts` rather than sharing it.
- v1 and v2 Simplify's analysis orchestration (`runSimplificationReport` vs the simplify-mode branch of `runSimplifyV2Report`) are near-identical copies, not a shared engine — a future fix to one won't propagate to the other.
- Rudy's document index caps at 60 reports / 200 KB docs (ordered by recency) — a tenant with more than that has an incomplete index with no search fallback.
- Document Demo (`acme`) has 0 legal matters — the clone tool only covers reports + KB docs, not legal.
- **Operational note, not a bug**: any *new* workspace added to `WORKSPACES` in `workspace.ts` in the future needs to be added to each tenant's `features` array (or the DB column default) or it silently won't appear for anyone.

---

## 7. Test accounts / tenants right now

- `rhb` — real content (162 reports, 121 KB docs), branded RHB, all features on.
- `acme` ("Document Demo") — full clone of RHB's library (163 reports incl. one leftover test report titled "Pipeline Test (small slice) — safe to delete", 121 KB docs), teal branding, all features on. Legal CMS is empty here (see §6.d).
- Profiles: `jeremy@dekode.ai`, `shann@dekode.ai`, `jeremy@cloud-space.co` → `acme`, super_admin. `dabraj2004@gmail.com` → `rhb`, member.
