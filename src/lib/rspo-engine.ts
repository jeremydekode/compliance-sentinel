// The checklist runner: PRISMA + certificate + audit report → one result per
// applicable checklist item.
//
// Split of labour, enforced structurally rather than by prompt:
//   - presence/exact/date items are evaluated in CODE, after normalisation —
//     a certificate number either matches or it doesn't, no model involved.
//   - structural items are pure functions over the audit extraction.
//   - consistency items (fuzzy names/addresses/scope wording) go to ONE
//     batched AI call — but the engine attaches the verbatim source values to
//     every result BEFORE the call, so an AI verdict can never exist without
//     its evidence, and the model only ever answers "same thing or not", never
//     supplies a value.
//   - anything unverifiable from text (signatures) is needs_review by design.

import { generateWithFallback } from "./gemini";
import {
  RSPO_CHECKLIST, applicableItems, normalizeDate, normalizeScm, normalizeId, normalizeName,
  type RspoChecklistItem, type RspoItemResult, type RspoItemStatus, type RspoSource,
  type RspoSourceValue, type RspoCertType, type RspoArea, RSPO_AREAS,
} from "./rspo-checklist";
import type { PrismaApplication } from "./rspo-prisma";
import type { CertificateExtraction, AuditReportExtraction, Leaf } from "./rspo-extract";
import { type TokenUsage, EMPTY_USAGE, addUsage } from "./pricing";

export interface RspoRunContext {
  prisma: PrismaApplication;
  certificate: CertificateExtraction;
  audit: AuditReportExtraction;
  certType: RspoCertType;
  /** Names of the uploaded files, for the file_attached checks. */
  uploadedFiles: { certificateName: string | null; auditReportName: string | null };
}

// ── Path resolution ─────────────────────────────────────────────────────────

/** Resolve "a.b.c" or "sites[].name" against a source object. Array segments
 *  map over the array and join distinct values. Leaf objects ({v,p,q}) resolve
 *  to their value, and the page/quote ride along when available. */
function resolvePath(root: unknown, path: string): { value: string | null; page: number | null; quote?: string } {
  const segs = path.split(".");
  let nodes: unknown[] = [root];
  for (const seg of segs) {
    const mapped: unknown[] = [];
    for (const n of nodes) {
      if (n == null) continue;
      if (seg.endsWith("[]")) {
        const arr = (n as Record<string, unknown>)[seg.slice(0, -2)];
        if (Array.isArray(arr)) mapped.push(...arr);
      } else {
        mapped.push((n as Record<string, unknown>)[seg]);
      }
    }
    nodes = mapped;
  }
  const values: string[] = [];
  let page: number | null = null;
  let quote: string | undefined;
  for (const n of nodes) {
    if (n == null) continue;
    if (typeof n === "object" && "v" in (n as object)) {
      const leaf = n as Leaf;
      if (leaf.v != null && String(leaf.v).trim()) {
        values.push(String(leaf.v).trim());
        if (page == null && leaf.p != null) page = leaf.p;
        if (!quote && leaf.q) quote = leaf.q;
      }
    } else if (typeof n === "string" || typeof n === "number" || typeof n === "boolean") {
      const s = String(n).trim();
      if (s) values.push(s);
    } else if (Array.isArray(n)) {
      for (const x of n) {
        const s = String(x ?? "").trim();
        if (s) values.push(s);
      }
    }
  }
  const distinct = [...new Set(values)];
  if (!distinct.length) return { value: null, page: null };
  return { value: distinct.slice(0, 12).join("; ") + (distinct.length > 12 ? ` … (+${distinct.length - 12} more)` : ""), page, quote };
}

function sourceRoot(ctx: RspoRunContext, source: RspoSource): unknown {
  if (source === "prisma") return ctx.prisma;
  if (source === "certificate") return ctx.certificate;
  return ctx.audit;
}

function readValues(ctx: RspoRunContext, item: RspoChecklistItem): Partial<Record<RspoSource, RspoSourceValue>> {
  const out: Partial<Record<RspoSource, RspoSourceValue>> = {};
  for (const source of item.sources) {
    const paths = item.fields?.[source];
    if (!paths) continue;
    const list = Array.isArray(paths) ? paths : [paths];
    const parts: string[] = [];
    let page: number | null = null;
    let quote: string | undefined;
    for (const p of list) {
      const r = resolvePath(sourceRoot(ctx, source), p);
      if (r.value != null) {
        parts.push(list.length > 1 ? `${lastSeg(p)}: ${r.value}` : r.value);
        if (page == null) page = r.page;
        if (!quote) quote = r.quote;
      }
    }
    out[source] = { value: parts.length ? parts.join(" · ") : null, page, quote };
  }
  return out;
}

function lastSeg(path: string): string {
  const s = path.split(".").pop() ?? path;
  return s.replace("[]", "");
}

// ── Deterministic comparison ────────────────────────────────────────────────

function normalizeFor(kind: "exact" | "date", item: RspoChecklistItem, v: string | null): string | null {
  if (v == null) return null;
  if (kind === "date") return normalizeDate(v) ?? v.trim().toLowerCase();
  // exact: SCM fields get set-normalisation, everything else ID-normalisation
  const isScm = JSON.stringify(item.fields ?? {}).toLowerCase().includes("supplychainmodel");
  return isScm ? normalizeScm(v) : normalizeId(v);
}

function evalDeterministic(item: RspoChecklistItem, values: Partial<Record<RspoSource, RspoSourceValue>>): RspoItemResult {
  const present = item.sources.filter((s) => values[s]?.value != null);
  const absent = item.sources.filter((s) => values[s]?.value == null);

  if (item.kind === "presence") {
    const src = item.sources[0];
    const has = values[src]?.value != null;
    if (has) {
      return { itemId: item.id, status: "pass", method: "deterministic", values, reason: "Recorded." };
    }
    if (item.optional) {
      return { itemId: item.id, status: "pass", method: "deterministic", values, reason: "None declared — this field is not mandatory." };
    }
    return { itemId: item.id, status: "missing", method: "deterministic", values, reason: `Not found in ${SOURCE_LABELS[src]}.` };
  }

  // exact / date
  if (absent.length) {
    if (item.optional && !present.length) {
      return { itemId: item.id, status: "pass", method: "deterministic", values, reason: "None declared in any source." };
    }
    return {
      itemId: item.id, status: "missing", method: "deterministic", values,
      reason: `Missing from ${absent.map((s) => SOURCE_LABELS[s]).join(" and ")} — cannot cross-check.`,
    };
  }
  const kind = item.kind === "date" ? "date" : "exact";
  const normalized = present.map((s) => ({ s, n: normalizeFor(kind, item, values[s]!.value) }));

  // Supply-chain-model checks are CONTAINMENT, not equality: the certificate
  // states every model the CB certified, while a licence/site may use a
  // subset. PRISMA and the audit report must agree with each other, and both
  // must be covered by the certificate's models.
  const isScm = kind === "exact" && JSON.stringify(item.fields ?? {}).toLowerCase().includes("supplychainmodel");
  if (isScm && normalized.some((x) => x.s === "certificate")) {
    const certModels = new Set((normalized.find((x) => x.s === "certificate")!.n ?? "").split("+"));
    const others = normalized.filter((x) => x.s !== "certificate");
    const othersDistinct = [...new Set(others.map((x) => x.n))];
    const othersAgree = othersDistinct.length <= 1;
    const covered = others.every((x) => (x.n ?? "").split("+").every((mdl) => !mdl || certModels.has(mdl)));
    if (othersAgree && covered) {
      const extra = [...certModels].filter((mdl) => mdl && !(othersDistinct[0] ?? "").split("+").includes(mdl));
      return {
        itemId: item.id, status: "pass", method: "deterministic", values,
        reason: extra.length
          ? `Models agree; the certificate additionally covers ${extra.join(", ")}, which this licence doesn't use.`
          : "Supply chain models agree across all sources.",
      };
    }
    return {
      itemId: item.id, status: "mismatch", method: "deterministic", values,
      reason: !othersAgree
        ? present.filter((s) => s !== "certificate").map((s) => `${SOURCE_LABELS[s]}: "${values[s]!.value}"`).join(" vs ")
        : `The licence uses a model the certificate does not cover (certificate: ${[...certModels].join("+")}).`,
    };
  }

  const distinct = [...new Set(normalized.map((x) => x.n))];
  if (distinct.length === 1) {
    return {
      itemId: item.id, status: "pass", method: "deterministic", values,
      reason: `${present.map((s) => SOURCE_LABELS[s]).join(", ")} agree${kind === "date" ? ` (${distinct[0]})` : ""}.`,
    };
  }
  return {
    itemId: item.id, status: "mismatch", method: "deterministic", values,
    reason: present.map((s) => `${SOURCE_LABELS[s]}: "${values[s]!.value}"`).join(" vs "),
  };
}

const SOURCE_LABELS: Record<RspoSource, string> = {
  prisma: "PRISMA",
  certificate: "Certificate",
  audit_report: "Audit report",
};

// ── Per-entity fan-out (site tables) ────────────────────────────────────────

interface EntityView {
  name: string;
  values: Partial<Record<RspoSource, RspoSourceValue>>;
}

function entityRowsFor(ctx: RspoRunContext, item: RspoChecklistItem): RspoItemResult["entityRows"] {
  // Join PRISMA sites to cert/audit site tables by loose name key.
  const prismaSites = ctx.prisma.sites;
  const certRows = item.fields?.certificate?.toString().includes("groupMembers")
    ? ctx.certificate.groupMembers
    : ctx.certificate.sites;
  const auditRows = ctx.audit.sites;

  const byKey = new Map<string, EntityView>();
  const put = (source: RspoSource, name: string | null, value: string | null, page?: number | null) => {
    const key = normalizeName(name ?? "");
    if (!key) return;
    let e = byKey.get(key);
    if (!e) { e = { name: name ?? key, values: {} }; byKey.set(key, e); }
    e.values[source] = { value, page: page ?? null };
  };

  const describePrisma = (s: PrismaApplication["sites"][number]) =>
    [s.businessId, s.businessType, s.supplyChainModels, s.tradingAccountId, s.address]
      .filter(Boolean).join(" · ") || "(listed)";
  for (const s of prismaSites) put("prisma", s.name, describePrisma(s));

  if (item.sources.includes("certificate")) {
    for (const r of certRows) {
      const desc = [r.address?.v, (r as { supplyChainModel?: Leaf }).supplyChainModel?.v]
        .filter(Boolean).join(" · ") || "(listed)";
      put("certificate", r.name?.v ?? null, desc, r.name?.p);
    }
  }
  if (item.sources.includes("audit_report")) {
    for (const r of auditRows) {
      const desc = [r.address?.v, r.businessType?.v, r.supplyChainModel?.v, r.tradingId?.v, r.audited?.v ? `audited: ${r.audited.v}` : null]
        .filter(Boolean).join(" · ") || "(listed)";
      put("audit_report", r.name?.v ?? null, desc, r.name?.p);
    }
  }

  const rows: NonNullable<RspoItemResult["entityRows"]> = [];
  for (const e of byKey.values()) {
    const missingFrom = item.sources.filter((s) => !e.values[s]);
    let status: RspoItemStatus;
    let reason: string;
    if (!missingFrom.length) {
      status = "needs_review";
      reason = "Listed in every source — confirm the details line up.";
    } else {
      status = "mismatch";
      reason = `Not found in ${missingFrom.map((s) => SOURCE_LABELS[s]).join(", ")}.`;
    }
    rows.push({ entity: e.name, status, values: e.values, reason });
  }
  rows.sort((a, b) => (a.status === b.status ? a.entity.localeCompare(b.entity) : a.status === "mismatch" ? -1 : 1));
  return rows.slice(0, 400);
}

// ── Structural checks ───────────────────────────────────────────────────────

function evalStructural(ctx: RspoRunContext, item: RspoChecklistItem): RspoItemResult {
  const a = ctx.audit;
  const base = { itemId: item.id, method: "structural" as const };
  const noValues: Partial<Record<RspoSource, RspoSourceValue>> = {};

  switch (item.structuralCheck) {
    case "section_present": {
      const want = (item.section ?? "").toLowerCase();
      const hit = a.sectionsFound.find((s) =>
        s.section.toLowerCase() === want ||
        s.section.toLowerCase().startsWith(want) ||
        (want.startsWith("appendix") && s.section.toLowerCase().includes(want)));
      if (hit) {
        return {
          ...base, status: "pass",
          values: { audit_report: { value: `${hit.section} ${hit.title}`.trim(), page: hit.pages[0] ?? null } },
          reason: `Section present${hit.pages.length ? ` (p.${hit.pages[0]})` : ""}.`,
        };
      }
      return {
        ...base, status: item.optional ? "needs_review" : "missing", values: noValues,
        reason: item.optional
          ? `Section ${item.section} not found — confirm it is genuinely not applicable for this audit.`
          : `Section ${item.section} not found in the report.`,
      };
    }

    case "file_attached": {
      const expected = item.id === "LA-11" ? ctx.prisma.certificate.fileName : ctx.prisma.certificate.auditReportFileName;
      const uploaded = item.id === "LA-11" ? ctx.uploadedFiles.certificateName : ctx.uploadedFiles.auditReportName;
      const values: Partial<Record<RspoSource, RspoSourceValue>> = {
        prisma: { value: expected ?? null },
      };
      if (!expected) {
        return { ...base, status: "missing", values, reason: "No file recorded against the application in PRISMA." };
      }
      return {
        ...base, status: "needs_review", values,
        reason: uploaded
          ? `PRISMA records "${expected}"; uploaded here as "${uploaded}" — confirm they are the same document.`
          : `PRISMA records "${expected}" — confirm it matches the reviewed document.`,
      };
    }

    case "nc_totals_match": {
      const stated = a.findingsSummary.totalNCs;
      const counted = a.ncs.length;
      const values: Partial<Record<RspoSource, RspoSourceValue>> = {
        audit_report: {
          value: `Summary states ${stated ?? "?"} NC(s); register lists ${counted}`,
          page: a.findingsSummary.page,
        },
      };
      if (stated == null) {
        return { ...base, status: "needs_review", values, reason: "The findings summary total could not be read — verify §3.5 against §3.4/§3.6 manually." };
      }
      if (stated === counted) {
        return { ...base, status: "pass", values, reason: `Totals agree (${counted}).` };
      }
      return { ...base, status: "mismatch", values, reason: `Summary says ${stated} but the register lists ${counted}.` };
    }

    case "all_ncs_closed": {
      if (!a.ncs.length) {
        const zeroStated = a.findingsSummary.totalNCs === 0;
        return {
          ...base,
          status: zeroStated ? "pass" : "needs_review",
          values: { audit_report: { value: zeroStated ? "No nonconformities raised" : "NC register empty", page: a.findingsSummary.page } },
          reason: zeroStated
            ? "No NCs were raised in this audit."
            : "No NC register was read but the summary total isn't confirmed as zero — verify §3.6.",
        };
      }
      const open = a.ncs.filter((n) => !/clos|complete|accept/i.test(n.status ?? ""));
      const values: Partial<Record<RspoSource, RspoSourceValue>> = {
        audit_report: {
          value: a.ncs.map((n) => `${n.ref}: ${n.status ?? "status unreadable"}`).slice(0, 15).join("; "),
          page: a.ncs[0]?.page ?? null,
        },
      };
      if (!open.length) {
        return { ...base, status: "pass", values, reason: `All ${a.ncs.length} NC(s) recorded as closed.` };
      }
      return {
        ...base, status: "mismatch", values,
        reason: `${open.length} NC(s) not recorded as closed: ${open.map((n) => `${n.ref} (${n.status ?? "no status"})`).join(", ")}.`,
      };
    }

    case "all_sections_marked": {
      const c = a.conclusion;
      const values: Partial<Record<RspoSource, RspoSourceValue>> = {
        audit_report: { value: c.sectionsMarked == null ? null : c.sectionsMarked ? "All conclusion sections completed" : `Unmarked: ${c.missing.join(", ") || "(unspecified)"}`, page: c.page },
      };
      if (c.sectionsMarked === true) return { ...base, status: "pass", values, reason: "Conclusion and recommendation sections are completed." };
      if (c.sectionsMarked === false) return { ...base, status: "mismatch", values, reason: `Conclusion has unmarked sections: ${c.missing.join(", ") || "(unspecified)"}.` };
      return {
        ...base, status: "needs_review",
        values: { audit_report: { value: null, page: c.page } },
        reason: `Tick-box completion can't be verified from text alone — check §4 directly${c.page ? ` (p.${c.page})` : ""}.`,
      };
    }

    case "signatures_captured": {
      // Signatures are IMAGES — text extraction cannot honestly confirm them.
      // The check's job is to take the reviewer to the right page, never to
      // fake a pass.
      const sigs = a.signOff.signatures;
      const values: Partial<Record<RspoSource, RspoSourceValue>> = {
        audit_report: {
          value: sigs.length
            ? sigs.map((s) => `${s.role}: ${s.name ?? "?"}${s.signedEvidence ? ` (${s.signedEvidence})` : ""}`).join("; ")
            : null,
          page: a.signOff.page ?? sigs[0]?.page ?? null,
        },
      };
      const page = a.signOff.page ?? sigs[0]?.page;
      return {
        ...base, status: "needs_review", values,
        reason: `Signature images can't be verified from extracted text — inspect the sign-off page${page ? ` (p.${page})` : ""} directly.`,
      };
    }

    case "volumes_captured": {
      const ap = a.appendix1;
      const values: Partial<Record<RspoSource, RspoSourceValue>> = {
        audit_report: {
          value: ap.volumes.length
            ? ap.volumes.slice(0, 10).map((v) => `${v.product}${v.model ? ` [${v.model}]` : ""}: ${v.volume ?? "?"}`).join("; ")
            : null,
          page: ap.page,
        },
      };
      if (ap.volumes.length || ap.volumesCaptured === true) {
        return { ...base, status: "pass", values, reason: `Volume summary captured (${ap.volumes.length} line(s)).` };
      }
      return { ...base, status: "missing", values, reason: "No volume summary found in Appendix 1." };
    }

    case "io_inputs_match":
    case "io_outputs_match":
    case "io_products_match": {
      const dir = item.structuralCheck === "io_inputs_match" ? "inputs" : item.structuralCheck === "io_outputs_match" ? "outputs" : "both";
      const prismaIn = new Set(ctx.prisma.sites.flatMap((s) => s.inputs).map(productKey));
      const prismaOut = new Set(ctx.prisma.sites.flatMap((s) => s.outputs).map(productKey));
      const auditIn = new Set(a.appendix3.inputs.map(productKey));
      const auditOut = new Set(a.appendix3.outputs.map(productKey));

      const compare = (pSet: Set<string>, aSet: Set<string>, label: string) => {
        const missingInAudit = [...pSet].filter((x) => !aSet.has(x));
        const missingInPrisma = [...aSet].filter((x) => !pSet.has(x));
        return { label, missingInAudit, missingInPrisma, agree: !missingInAudit.length && !missingInPrisma.length };
      };
      const cmps = dir === "inputs" ? [compare(prismaIn, auditIn, "inputs")]
        : dir === "outputs" ? [compare(prismaOut, auditOut, "outputs")]
        : [compare(prismaIn, auditIn, "inputs"), compare(prismaOut, auditOut, "outputs")];

      const values: Partial<Record<RspoSource, RspoSourceValue>> = {
        prisma: { value: summarizeSet(dir, prismaIn, prismaOut) },
        audit_report: { value: summarizeSet(dir, auditIn, auditOut), page: a.appendix3.page },
      };
      const anyEmpty = cmps.some((c) => {
        const p = c.label === "inputs" ? prismaIn : prismaOut;
        const au = c.label === "inputs" ? auditIn : auditOut;
        return !p.size || !au.size;
      });
      if (anyEmpty) {
        return {
          ...base, status: "needs_review", values,
          reason: "One side has no product list to compare — verify Appendix 3 against the PRISMA product list manually.",
        };
      }
      if (cmps.every((c) => c.agree)) {
        return { ...base, status: "pass", values, reason: "Product lists align between PRISMA and Appendix 3." };
      }
      const bits: string[] = [];
      for (const c of cmps) {
        if (c.missingInAudit.length) bits.push(`${c.label} in PRISMA but not the report: ${c.missingInAudit.slice(0, 8).join(", ")}`);
        if (c.missingInPrisma.length) bits.push(`${c.label} in the report but not PRISMA: ${c.missingInPrisma.slice(0, 8).join(", ")}`);
      }
      return { ...base, status: "mismatch", values, reason: bits.join(" · ") };
    }
  }

  return { ...base, status: "needs_review", values: noValues, reason: "Unknown structural check." };
}

function productKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function summarizeSet(dir: string, inputs: Set<string>, outputs: Set<string>): string | null {
  const parts: string[] = [];
  if (dir !== "outputs") parts.push(`${inputs.size} input(s)`);
  if (dir !== "inputs") parts.push(`${outputs.size} output(s)`);
  return parts.join(", ") || null;
}

// ── AI consistency batch ────────────────────────────────────────────────────

const CONSISTENCY_PROMPT = `You are helping a licence reviewer decide whether values from different sources refer to the same thing.

For each item you get the checklist question and the verbatim values read from each source (the PRISMA system, the certificate PDF, the audit report PDF). Judge whether they are CONSISTENT — the same entity/fact, allowing formatting differences, abbreviations, address line ordering, translations of legal forms (B.V./Sdn Bhd/GmbH), and partial addresses that clearly refer to the same place.

Verdicts:
- "consistent"   — same thing beyond reasonable doubt
- "inconsistent" — a real difference a reviewer must look at (different company, different address, different scope)
- "uncertain"    — cannot tell from these values alone

Be strict about substance, lenient about format. Never mark "consistent" because values are merely similar in kind — "Engineering Services Ltd" and "Engineering Solutions Ltd" are DIFFERENT companies.

Return ONLY JSON: {"verdicts":[{"id":"<itemId>","verdict":"consistent|inconsistent|uncertain","confidence":<0..1>,"reason":"<one short clause citing the decisive detail>"}]}`;

async function runConsistencyBatch(
  items: Array<{ item: RspoChecklistItem; values: Partial<Record<RspoSource, RspoSourceValue>> }>,
): Promise<{ verdicts: Map<string, { verdict: string; confidence: number; reason: string }>; usage: TokenUsage; model: string }> {
  if (!items.length) return { verdicts: new Map(), usage: EMPTY_USAGE, model: "" };

  const payload = items.map(({ item, values }) => ({
    id: item.id,
    question: item.label || item.group,
    values: Object.fromEntries(
      Object.entries(values).map(([s, v]) => [s, (v as RspoSourceValue).value]),
    ),
  }));

  const response = await generateWithFallback(
    {
      contents: [{ role: "user", parts: [{ text: `${CONSISTENCY_PROMPT}\n\nITEMS:\n${JSON.stringify(payload, null, 1)}` }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 32768, temperature: 0 },
    },
    { tier: "quality" },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = ((response as any).usageMetadata ?? {}) as any;
  const usage: TokenUsage = {
    inputTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    thinkingTokens: m.thoughtsTokenCount ?? 0,
    calls: 1,
  };
  const model = (response as { modelVersion?: string }).modelVersion ?? "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = {};
  try { parsed = JSON.parse((response as { text?: string }).text ?? "{}"); } catch {
    const mm = ((response as { text?: string }).text ?? "").match(/\{[\s\S]*\}/);
    if (mm) { try { parsed = JSON.parse(mm[0]); } catch { /* keep {} */ } }
  }
  const verdicts = new Map<string, { verdict: string; confidence: number; reason: string }>();
  for (const v of Array.isArray(parsed.verdicts) ? parsed.verdicts : []) {
    const id = String(v?.id ?? "");
    if (!id) continue;
    verdicts.set(id, {
      verdict: String(v?.verdict ?? "uncertain"),
      confidence: typeof v?.confidence === "number" ? Math.max(0, Math.min(1, v.confidence)) : 0.5,
      reason: String(v?.reason ?? "").slice(0, 240),
    });
  }
  return { verdicts, usage, model };
}

// ── The runner ──────────────────────────────────────────────────────────────

export async function runRspoChecks(ctx: RspoRunContext): Promise<{
  results: RspoItemResult[];
  usage: TokenUsage;
  model: string;
}> {
  const hasMill = ctx.prisma.sites.some((s) => /mill/i.test(s.businessType ?? ""));
  const hasNonMill = ctx.prisma.sites.some((s) => !/mill/i.test(s.businessType ?? ""));
  const { applicable, excluded } = applicableItems(ctx.certType, {
    hasMill, hasNonMill, sitesKnown: ctx.prisma.sites.length > 0,
  });

  const results = new Map<string, RspoItemResult>();

  // not_applicable results keep the export template-complete.
  for (const item of excluded) {
    results.set(item.id, {
      itemId: item.id, status: "not_applicable", method: "deterministic", values: {},
      reason: item.appliesTo && !item.appliesTo.includes(ctx.certType)
        ? `Not applicable for ${ctx.certType.replace("_", " ")} certification.`
        : "No site of this business type in the application.",
    });
  }

  const consistencyQueue: Array<{ item: RspoChecklistItem; values: Partial<Record<RspoSource, RspoSourceValue>> }> = [];

  for (const item of applicable) {
    if (item.kind === "structural") {
      results.set(item.id, evalStructural(ctx, item));
      continue;
    }
    const values = readValues(ctx, item);
    if (item.kind === "consistency") {
      const present = item.sources.filter((s) => values[s]?.value != null);
      if (present.length < 2) {
        results.set(item.id, {
          itemId: item.id,
          status: item.optional && !present.length ? "pass" : "missing",
          method: "deterministic",
          values,
          reason: item.optional && !present.length
            ? "None declared in any source."
            : `Only ${present.length ? SOURCE_LABELS[present[0]] : "no source"} holds a value — nothing to cross-check.`,
        });
        continue;
      }
      consistencyQueue.push({ item, values });
      continue;
    }
    const r = evalDeterministic(item, values);
    if (item.perEntity && (ctx.certType !== "single_site" || item.kind !== "exact")) {
      r.entityRows = entityRowsFor(ctx, item);
    }
    results.set(item.id, r);
  }

  // One batched AI call for the fuzzy comparisons.
  let usage: TokenUsage = EMPTY_USAGE;
  let model = "";
  try {
    const batch = await runConsistencyBatch(consistencyQueue);
    usage = batch.usage;
    model = batch.model;
    for (const { item, values } of consistencyQueue) {
      const v = batch.verdicts.get(item.id);
      const status: RspoItemStatus =
        v?.verdict === "consistent" ? "pass" : v?.verdict === "inconsistent" ? "mismatch" : "needs_review";
      const r: RspoItemResult = {
        itemId: item.id, status, method: "ai", values,
        reason: v?.reason || "The comparison could not be judged — review the values side by side.",
        aiConfidence: v?.confidence,
      };
      if (item.perEntity) r.entityRows = entityRowsFor(ctx, item);
      results.set(item.id, r);
    }
  } catch (e) {
    // The AI batch failing must not kill the run — those items become
    // needs_review with their evidence intact.
    for (const { item, values } of consistencyQueue) {
      results.set(item.id, {
        itemId: item.id, status: "needs_review", method: "ai", values,
        reason: `Automated comparison unavailable (${e instanceof Error ? e.message.slice(0, 80) : "error"}) — review the values side by side.`,
      });
    }
  }

  // Catalogue order.
  const ordered = RSPO_CHECKLIST.map((i) => results.get(i.id)).filter((r): r is RspoItemResult => !!r);
  return { results: ordered, usage: addUsage(EMPTY_USAGE, usage), model };
}

// ── Summaries & diffs ───────────────────────────────────────────────────────

export function summarizeResults(results: RspoItemResult[]): Record<RspoArea, Record<RspoItemStatus, number>> {
  const areaOf = new Map(RSPO_CHECKLIST.map((i) => [i.id, i.area]));
  const out = {} as Record<RspoArea, Record<RspoItemStatus, number>>;
  for (const a of RSPO_AREAS) {
    out[a] = { pass: 0, mismatch: 0, missing: 0, not_applicable: 0, needs_review: 0 };
  }
  for (const r of results) {
    const area = areaOf.get(r.itemId);
    if (area) out[area][r.status] += 1;
  }
  return out;
}

export function diffRuns(
  prev: RspoItemResult[],
  curr: RspoItemResult[],
): Record<string, { from: RspoItemStatus; to: RspoItemStatus }> {
  const prevBy = new Map(prev.map((r) => [r.itemId, r.status]));
  const out: Record<string, { from: RspoItemStatus; to: RspoItemStatus }> = {};
  for (const r of curr) {
    const p = prevBy.get(r.itemId);
    if (p && p !== r.status) out[r.itemId] = { from: p, to: r.status };
  }
  return out;
}
