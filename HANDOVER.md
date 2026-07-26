# Handover — Document AI Sandbox

_Last updated: 2026-07-26. Supersedes the "RHB demo week" handover (its items were verified closed: all flagged server fns now carry tenant checks, layout is tenant-scoped, everything is committed and deployed). Covers: the OnlyOffice reachability saga, the React #185 crash, the AI-cost work, and the full bug-audit sweep (commit `83911a1`)._

**Next step (owner): manual debug pass — checklist in §6.**

---

## 1. System snapshot

- **App:** TanStack Start on Vercel — stable alias **documentai-sandbox.vercel.app**. Deploy: `npx vercel --prod --yes`, then `npx vercel alias set <deployment-url> documentai-sandbox.vercel.app`.
- **DB/storage:** Supabase — **one shared database for local and prod**. Migrations hit both at once; apply via SQL editor paste, guard with `to_regclass`.
- **AI:** Gemini via `generateWithFallback` (`src/lib/gemini.ts`; quality chain led by the admin-picked model), priced in `src/lib/pricing.ts`, metered into `summary_json.costLog` via `appendCostLog` (`compliance.functions.ts` top).
- **Exact editor:** OnlyOffice Document Server on Railway (project `impartial-fascination`), served at **https://docs.vertexagrowth.com** through a **Cloudflare Tunnel**: a `cloudflared` service inside the same Railway project → `http://documentserver.railway.internal:80` (private networking, never Railway's public edge). App reads `ONLYOFFICE_URL` (Vercel Production env + local `.env`). Save-back webhook: `api/onlyoffice-callback.js` (vercel.json rewrite carve-out).
- **Active demo workspaces:** Simplify v2 (`/simplify2/…`, modes `recommend_edit` / `simplify`) and Legal CMS. Also live: v1 simplify, regulatory (RMiT/FATF), forms, credit-risk, layout.

## 2. What went wrong → lessons

### 2.1 React #185 crash (review page)
- **What went wrong:** two confident wrong fixes first — a hooks-order cleanup, then removing recharts — neither reproduced nor resolved the crash. Both were plausible pattern-matches, not diagnoses.
- **What found it:** forcing a React dev build (`define: NODE_ENV`, `minify:false`) + a temporary class ErrorBoundary printing `errorInfo.componentStack` → named `RestructurePanel → Tooltip → Popper`. Radix Tooltip's floating-ui reposition loop inside the PDF+grid layout.
- **Fix:** native `title` attributes in `RestructurePanel` (no Radix Tooltip there).
- **Lessons:** (1) Never claim a fix you haven't reproduced — the componentStack was the first real evidence. (2) A "still broken" report after a deploy may be a **cached build**; ask for a hard refresh before re-diagnosing.

### 2.2 Editor unreachable — the Maxis saga
- **Layer 1 — DNS:** Maxis (user's ISP) **blocks all `railway.app`/`railway.com` hostnames**. Server perfectly healthy; the user's resolver simply never answered. (Hotspot worked → the tell.)
- **Layer 2 — concurrency:** first fix (Cloudflare orange-proxy on `docs.dekode.ai` → Railway) passed every single-request test, yet the editor stayed blank with **HTTP 525** on core assets. The editor fires ~50 parallel requests; Railway's public edge drops concurrent TLS handshakes (measured **15/40** through the proxy, 0/40 direct). It had only ever worked because a lone browser multiplexes one HTTP/2 connection.
- **Fix:** Cloudflare **Tunnel** — `cloudflared` inside Railway, traffic over its persistent connection, OnlyOffice reached via Railway **private networking**. Measured **40/40** after.
- **Railway deploy gotchas (cost three failed deploys):**
  1. Custom Start Command **replaces the entrypoint** → must start with the binary: `cloudflared tunnel --no-autoupdate run …`.
  2. Railway does **not expand `$VAR`** in start commands → `--token $TUNNEL_TOKEN` passes the literal string ("Provided Tunnel token is not valid"). Paste the token literally.
- **Lessons:** (1) "200 from my machine" says nothing about the user's network path — have the user run the probe (`/healthcheck` in their browser); suspect ISP DNS when hotspot≠wifi. (2) **Single-request healthchecks lie about concurrency** — burst-test (40 parallel curls) before declaring infrastructure fixed. (3) When a proxy leg is flaky, remove the leg (tunnel) rather than tuning it (cache rules).

### 2.3 What the audit sweep caught (commit `83911a1`)
Three parallel reviewers (client / v2 server / docx+AI pipeline) + a manual AI-cost trace; every finding verified against code before fixing. The classes, with their standing lessons:

| Class | Worst instance | Standing rule |
|---|---|---|
| **Lost-update races** | Auto-fired exec summary wrote a pre-AI snapshot back, silently reverting an Accept made during generation | Any write after an `await` gap must re-read via `freshSj()` (next to `appendCostLog`) and spread the fresh copy |
| **Destructive docx handling** | `comments.xml` rebuilt from id 0 — source documents' own comments deleted, surviving markers re-bound to wrong comments | Engine now merges via `existingComments()` and seeds comment/revision ids past the source's; keep any new part-writer merge-aware |
| **Matcher divergence** | Validator proved anchors unique with exact matching; apply engine located them with loose prefix matching and took first hit → content inserted after lookalike paragraphs | Validator and apply engine must share matching semantics (`locateAnchorParagraph`: exact-first, loose only if unambiguous, ambiguous → honest skip) |
| **Unmetered / uncached AI** | "Regenerate redraft" re-billed the priciest op for identical inputs; chat resent the whole summary blob every message, never metered | Every expensive op needs a sig cache (inputs that change output, client/server identical, bumps that don't force paid rebuilds) and a ledger entry — **including failure paths** (cost captured right after the AI call) |
| **Stale client cache** | Simplify rail accept didn't invalidate → old final doc served labeled "up to date" | Every decision mutation invalidates `["report", reportId]` |

Full fix list: commit message `83911a1`.

## 3. What worked — keep doing these

- **Evidence-first debugging:** componentStack for the crash; `dig @1.1.1.1` to bypass local DNS cache; 40-parallel curl bursts for the 525s; a synthetic-docx engine test (10/10 checks) proving the OOXML fixes. Each replaced a guess with a measurement.
- **Deterministic verification around the AI:** unique-anchor validation, per-edit application reports, verification gates. AI proposes; deterministic code decides what lands; ambiguity is reported, never guessed.
- **Tracked changes on the ORIGINAL docx** as the reliable final-document path (fidelity by construction). The full redraft exists but is the riskier path.
- **Cost transparency as a product feature:** the ledger, "opens instantly — no AI cost" labels, the deliberate amber "Re-run (uses AI)" button. This is what the client notices.
- **Parallel scoped review + adversarial verification before fixing** — two reviewer claims were already-fixed/moot; verification caught that instead of double-fixing.
- **Download-to-Word as the firewall-proof fallback** — carried every demo while the editor was unreachable.
- **Conditional cache-key components** (e.g. author folds into the sig only when non-default) — lets behavior change without invalidating everyone's paid caches.

## 4. Gaps found and how they were solved

1. **Editor unreachable on client networks** → Cloudflare Tunnel + private networking (§2.2). Ongoing check: tunnel `onlyoffice` in Cloudflare Zero Trust should show HEALTHY.
2. **Re-opening the final document billed AI** → sig-cached three-state UX: never-built = build (1 run) / current = open free / stale = choose "open last built (free)" vs amber "re-run (billed)".
3. **Email address as tracked-change author** → fixed "AI Doc Reviewer" server-side default; caches bumped (v6 salt, `v2:` apply prefix) so the change actually surfaced.
4. **Ledger blind spots** → chat, brief-generation, and all failure paths now metered; `gemini-2.0-flash` priced.
5. **Documents-with-comments corruption, wrong-paragraph insertions, races, stale client cache** → §2.3 table.

## 5. Open debt (deliberate, ranked)

1. **Legal CMS is unmetered** — 11 AI call sites (review, markup comparison, intake triage, clause refine, amended version…), no cost ledger. All user-triggered (no waste), just invisible spend. Port `appendCostLog` if wanted.
2. **`summary_json` concurrency narrowed, not atomic** — `freshSj()` shrinks the lost-update window to ms. Complete fix = `jsonb_set` RPC per key; parked because migrations hit the shared local+prod DB.
3. **Orphaned storage objects** — uploads (`upsert:false`, timestamped names) that succeed before a later failure are never referenced or cleaned. Slow unbounded growth in `policies` bucket.
4. **v1 Simplify workspace still live** with the near-duplicate heavier pipeline; hide via workspace visibility if unused, or fold into v2.
5. **Tier-2 RLS** (DB-level tenant wall) still deferred — Tier-1 (server-fn guards, now comprehensive) is the enforcement layer; direct-client reads rely on route-level filters.
6. **`match_sop_chunks` RPC is global** (app-level tenant post-filter) — fine at current scale, watch as tenants/chunks grow.
7. **Cosmetic:** `docs.dekode.ai` leftovers (Cloudflare CNAME + TXT, Railway custom domain) can be deleted; editor-saved source copies don't refresh the "Exact" PDF (keyed to `source_file_url`).
8. **Existing cached final docs predate the engine fixes** — served as-is by design (no forced re-billing); any decision change + re-run rebuilds on the fixed engine.

## 6. Debug checklist — the owner's next pass

Hard-refresh (Cmd-Shift-R) before starting. Each item names the exact promise a recent fix makes.

**A. Cost / caching**
1. Open a previously built report → **Open final document** → opens instantly, **no new ledger entry**.
2. Change one decision → amber **"Re-run to apply your latest changes"** appears; **"Open last built version"** still opens free.
3. Re-run once → exactly **one** new "Final document build" ledger entry.
4. **Generate redraft** twice, nothing changed between → second click: instant, "already up to date — no AI cost" toast, no ledger entry.
5. Send a chat message on a regulatory report → **"Report chat"** ledger entry appears.
6. Revisit the R&E dashboard several times → no repeat "Executive summary" entries.

**B. Correctness**
7. Simplify mode: accept one edit in the rail → "Open final document" reacts **immediately** (no manual refresh); build it, then accept one more → the button must show **stale**, not "up to date", and the stale copy must not be silently served as current.
8. Upload a docx that **already has Word comments** → R&E → build final doc → download: original comments intact, new "AI Doc Reviewer" comments alongside, no Word repair prompt.
9. In Word: tracked changes authored **"AI Doc Reviewer"**; change-history row dated **today (MYT)**; inserted rows/paragraphs in the right places (glossary rows in the glossary table).
10. Type a decision value, navigate away within a second, return → value persisted.
11. On first dashboard load (exec summary still generating), quickly Accept a finding → reload → the Accept **sticks**.

**C. Infrastructure**
12. On Maxis (no hotspot/VPN): `https://docs.vertexagrowth.com/healthcheck` → `true`; in-app editor renders a document (no blank canvas, no 525s in the Network tab).
13. Edit in the editor → close → reopen → the edit persisted (save-back + forcesave path).

**When something misbehaves, capture three things:** browser console (red errors), the failing Network request (domain + status), and the report's cost ledger. Those localize almost everything from this handover.
