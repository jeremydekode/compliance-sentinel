// Deterministic MbrsExtraction → XBRL instance document generator.
//
// Every concept name, context id and unit ref comes from the template derived
// from a real SSM filing (mbrs-template.ts). Nothing here is model-generated,
// which is the whole point: an LLM asked to emit XBRL directly will invent
// plausible-looking tags that SSM silently rejects.

import { TEMPLATE_FACTS, TEMPLATE_CONTEXTS, type TemplateFact } from "./mbrs-template";
import { normalizeExtraction, type MbrsExtraction } from "./mbrs";

const XBRL_HEADER = `<?xml version="1.0" encoding="utf-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:ifrs-smes="https://xbrl.ifrs.org/taxonomy/2022-03-24/ifrs-smes" xmlns:ifrs-full="https://xbrl.ifrs.org/taxonomy/2022-03-24/ifrs-full" xmlns:ssmt-dei="http://xbrl.ssm.com.my/taxonomy/2022-12-31/ssmt-dei-core" xmlns:ssmt-dei-ee-mpers="http://xbrl.ssm.com.my/taxonomy/2022-12-31/ssmt-dei-ee-mpers" xmlns:ssmt-dei-ee-mfrs="http://xbrl.ssm.com.my/taxonomy/2022-12-31/ssmt-dei-ee-mfrs" xmlns:ssmt="http://xbrl.ssm.com.my/taxonomy/2022-12-31/ssmt-cor" xmlns:ssmt-mpers="http://xbrl.ssm.com.my/taxonomy/2022-12-31/ssmt-mpers-cor" xmlns:ssmt-mfrs="http://xbrl.ssm.com.my/taxonomy/2022-12-31/ssmt-mfrs-cor" id="MBRS_Preparation_Tool_2.2">
  <link:schemaRef xlink:type="simple" xlink:href="https://mbrs.ssm.com.my/taxonomy/SSMxT2022v1.0/rep/ssm/ca-2016/fs/mpers/ssmt-fs-mpers_2022-12-31_entry_point.xsd"/>`;

const UNITS = `  <xbrli:unit id="MYR">
    <xbrli:measure>iso4217:MYR</xbrli:measure>
  </xbrli:unit>
  <xbrli:unit id="PURE">
    <xbrli:measure>xbrli:pure</xbrli:measure>
  </xbrli:unit>
  <xbrli:unit id="share">
    <xbrli:measure>xbrli:shares</xbrli:measure>
  </xbrli:unit>`;

/** Escape for ELEMENT TEXT. Quotes are deliberately left literal — XML only
 *  requires them escaped inside attribute values, and the narrative blocks are
 *  quote-dense escaped HTML, so escaping them here diverges from what SSM's
 *  own tool emits. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape for ATTRIBUTE VALUES, where quotes must be encoded. */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** yyyy-mm-dd → yyyymmdd, the form used inside context ids. */
function compact(iso: string): string {
  return iso.replace(/-/g, "");
}

/** The instant one day before `iso` — the opening balance date for the
 *  comparative year's statement of changes in equity. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface TokenMap {
  [token: string]: string;
}

function buildTokens(x: MbrsExtraction): TokenMap {
  const cs = String(x.entity.currentPeriodStart ?? "").trim();
  const ce = String(x.entity.currentPeriodEnd ?? "").trim();
  const ps = String(x.entity.previousPeriodStart ?? "").trim();
  const pe = String(x.entity.previousPeriodEnd ?? "").trim();
  const ppe = ps ? dayBefore(ps) : "";
  return {
    "{CS}": compact(cs), "{CE}": compact(ce),
    "{PS}": compact(ps), "{PE}": compact(pe), "{PPE}": compact(ppe),
    "{CS-}": cs, "{CE-}": ce,
    "{PS-}": ps, "{PE-}": pe, "{PPE-}": ppe,
    "{ENTITY}": String(x.entity.registrationNumber ?? "").trim(),
  };
}

function resolveTokens(s: string, tokens: TokenMap): string {
  return s.replace(/\{[A-Z]+-?\}/g, (m) => tokens[m] ?? m);
}

/**
 * SSM's tool emits every narrative disclosure as a self-contained XHTML
 * document, and its validator expects that envelope. We were emitting bare
 * `<p>` fragments, which is structurally wrong even when the text is right.
 */
function wrapNarrative(body: string): string {
  if (!body.trim()) return "";
  if (body.trimStart().startsWith("<?xml")) return body;
  return [
    '<?xml version="1.0" ?>',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    "<head>",
    "<title></title>",
    "</head>",
    "<body style=\"font-family:'Arial';font-size:12pt;text-align:left;\">",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

function factValue(f: TemplateFact, x: MbrsExtraction): string | null {
  if (f.narrative) {
    const v = x.narratives?.[f.c];
    return typeof v === "string" ? wrapNarrative(v) : "";
  }
  if (f.field) {
    if (f.period) {
      const bag: Record<string, number | null> =
        f.period === "current" ? x.current : x.previous;
      const raw = bag?.[f.field];
      if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
      // Signs are carried in the canonical values exactly as the statement
      // prints them, so nothing is flipped here. Net-outflow lines stay
      // negative; gross "purchase of" lines stay positive.
      return String(raw);
    }
    const v = x.entity?.[f.field];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }
  // No field, no narrative and no literal: the box exists in the template but
  // nothing is bound to it yet. Skip it — an empty element is not a valid fact.
  return f.v ?? null;
}

function renderContexts(used: Set<string>, tokens: TokenMap): string {
  const out: string[] = [];
  for (const [tokId, def] of Object.entries(TEMPLATE_CONTEXTS)) {
    if (!used.has(tokId)) continue;
    const id = resolveTokens(tokId, tokens);
    const period = def.i
      ? `      <xbrli:instant>${resolveTokens(def.i, tokens)}</xbrli:instant>`
      : `      <xbrli:startDate>${resolveTokens(def.s ?? "", tokens)}</xbrli:startDate>\n` +
        `      <xbrli:endDate>${resolveTokens(def.e ?? "", tokens)}</xbrli:endDate>`;

    let scenario = "";
    const bits: string[] = [];
    for (const [axis, member] of def.dims ?? []) {
      bits.push(`      <xbrldi:explicitMember dimension="${axis}">${member}</xbrldi:explicitMember>`);
    }
    for (const [axis, el, val] of def.typed ?? []) {
      bits.push(
        `      <xbrldi:typedMember dimension="${axis}">\n` +
        `        <${el}>${esc(val)}</${el}>\n` +
        `      </xbrldi:typedMember>`,
      );
    }
    if (bits.length) {
      scenario = `\n    <xbrli:scenario>\n${bits.join("\n")}\n    </xbrli:scenario>`;
    }

    out.push(
      `  <xbrli:context id="${id}">\n` +
      `    <xbrli:entity>\n` +
      `      <xbrli:identifier scheme="https://www.ssm.com.my/">${escAttr(tokens["{ENTITY}"])}</xbrli:identifier>\n` +
      `    </xbrli:entity>\n` +
      `    <xbrli:period>\n${period}\n    </xbrli:period>${scenario}\n` +
      `  </xbrli:context>`,
    );
  }
  return out.join("\n");
}

export interface GenerateResult {
  xml: string;
  /** Facts actually written. */
  factCount: number;
  /** Template facts skipped because the extraction had no value for them. */
  skipped: string[];
}

export function generateMbrsXbrl(input: MbrsExtraction): GenerateResult {
  const x = normalizeExtraction(input);
  const tokens = buildTokens(x);

  const rendered: string[] = [];
  const usedContexts = new Set<string>();
  const skipped: string[] = [];

  for (const f of TEMPLATE_FACTS) {
    const value = factValue(f, x);
    if (value === null) {
      skipped.push(f.field ? `${f.c} (${f.field}/${f.period ?? "entity"})` : f.c);
      continue;
    }
    if (f.ctx) usedContexts.add(f.ctx);
    const attrs = [
      f.ctx ? `contextRef="${resolveTokens(f.ctx, tokens)}"` : "",
      f.u ? `unitRef="${f.u}"` : "",
      f.d ? `decimals="${f.d}"` : "",
    ].filter(Boolean).join(" ");
    const body = f.v !== undefined && !f.field && !f.narrative
      ? esc(resolveTokens(value, tokens))
      : esc(value);
    rendered.push(`  <${f.c} ${attrs}>${body}</${f.c}>`);
  }

  const xml = [
    XBRL_HEADER,
    renderContexts(usedContexts, tokens),
    UNITS,
    rendered.join("\n"),
    "</xbrli:xbrl>",
  ].join("\n");

  return { xml, factCount: rendered.length, skipped };
}

/** Filename SSM's portal expects: SSM_<submission>_<regno>_<yyyymmdd>.xml */
export function mbrsFilename(x: MbrsExtraction): string {
  const reg = String(x.entity.registrationNumber ?? "unknown").trim();
  const end = compact(String(x.entity.currentPeriodEnd ?? "").trim());
  return `SSM_FS-MPERS_${reg}_${end}.xml`;
}
