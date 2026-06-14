// ============================================================================
// Credit Risk Alert — .docx export
// ----------------------------------------------------------------------------
// Builds a genuine Word .docx (WordprocessingML) from a CreditRiskAnalysis,
// entirely client-side. The credit application is a PDF, so there's no source
// .docx to amend (unlike the simplify path) — we assemble a minimal-but-valid
// OOXML package by hand with PizZip (already a dependency).
//
// Real numbered/bulleted lists need numbering.xml + relationships; to keep the
// package to the 3 essential parts we render bullets/numbers as literal text
// prefixes with a hanging indent. Word opens this cleanly.
// ============================================================================

import { CREDIT_RISK_SEGMENTS, type CreditRiskAnalysis, type CreditRiskIndicator } from "./gemini";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Traffic-light meta — text colour only (no fills), mirrored from the in-app UI.
const IND: Record<CreditRiskIndicator, { label: string; color: string }> = {
  high: { label: "HIGH", color: "B91C1C" },
  probe: { label: "PROBE", color: "B45309" },
  low: { label: "LOW", color: "15803D" },
};

// ── XML primitives ───────────────────────────────────────────────────────────

function xml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A run. Multi-line text is split on \n and rejoined with <w:br/>. sz is half-points. */
function run(
  text: string,
  o: { b?: boolean; i?: boolean; color?: string; sz?: number } = {},
): string {
  const rpr =
    [
      o.b ? "<w:b/>" : "",
      o.i ? "<w:i/>" : "",
      o.color ? `<w:color w:val="${o.color}"/>` : "",
      o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : "",
    ].join("") || "";
  const t = String(text ?? "")
    .split("\n")
    .map((p, i) => `${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${xml(p)}</w:t>`)
    .join("");
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}${t}</w:r>`;
}

/** Like run(), but bolds any occurrence of the match terms within the text. */
function runsHighlighted(
  text: string,
  terms: string[] | undefined,
  base: { i?: boolean; color?: string; sz?: number } = {},
): string {
  const clean = (terms ?? []).map((t) => t.trim()).filter((t) => t.length >= 2);
  if (clean.length === 0) return run(text, base);
  const escaped = clean
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return String(text ?? "")
    .split(re)
    .filter((p) => p !== "")
    .map((p) =>
      clean.some((t) => t.toLowerCase() === p.toLowerCase()) ? run(p, { ...base, b: true }) : run(p, base),
    )
    .join("");
}

function para(
  runsXml: string,
  o: {
    spaceBefore?: number;
    spaceAfter?: number;
    align?: "left" | "center" | "right";
    indentLeft?: number;
    hanging?: number;
    shd?: string;
    keepNext?: boolean;
  } = {},
): string {
  const spacing =
    o.spaceBefore != null || o.spaceAfter != null
      ? `<w:spacing${o.spaceBefore != null ? ` w:before="${o.spaceBefore}"` : ""}${
          o.spaceAfter != null ? ` w:after="${o.spaceAfter}"` : ""
        }/>`
      : "";
  const ind =
    o.indentLeft != null || o.hanging != null
      ? `<w:ind${o.indentLeft != null ? ` w:left="${o.indentLeft}"` : ""}${
          o.hanging != null ? ` w:hanging="${o.hanging}"` : ""
        }/>`
      : "";
  const ppr =
    [
      spacing,
      ind,
      o.align ? `<w:jc w:val="${o.align}"/>` : "",
      o.shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>` : "",
      o.keepNext ? "<w:keepNext/>" : "",
    ].join("") || "";
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${runsXml}</w:p>`;
}

const EMPTY_PARA = "<w:p/>";

/** Inline markdown → runs: bolds **wrapped** segments. */
function mdRuns(text: string, base: { sz?: number; color?: string } = {}): string {
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((p, i) => (p ? run(p, { ...base, b: i % 2 === 1 }) : ""))
    .join("");
}

function heading(text: string, o: { sz?: number; color?: string; spaceBefore?: number } = {}): string {
  return para(run(text, { b: true, sz: o.sz ?? 26, color: o.color ?? "0F172A" }), {
    spaceBefore: o.spaceBefore ?? 280,
    spaceAfter: 100,
    keepNext: true,
  });
}

function bullet(text: string, prefix = "•  "): string {
  return para(run(`${prefix}${text}`, { sz: 21 }), { indentLeft: 360, hanging: 240, spaceAfter: 40 });
}

// ── table primitives ──────────────────────────────────────────────────────────

function cell(
  contentXml: string,
  o: { w: number; fill?: string; valign?: "top" | "center" } = { w: 1000 },
): string {
  const tcpr = [
    `<w:tcW w:w="${o.w}" w:type="dxa"/>`,
    o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : "",
    `<w:vAlign w:val="${o.valign ?? "top"}"/>`,
    `<w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar>`,
  ].join("");
  return `<w:tc><w:tcPr>${tcpr}</w:tcPr>${contentXml}</w:tc>`;
}

function table(rowsXml: string, colWidths: number[]): string {
  const grid = colWidths.map((w) => `<w:gridCol w:w="${w}"/>`).join("");
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D1D9E0"/>`)
    .join("");
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${rowsXml}</w:tbl>`
  );
}

// ── document assembly ──────────────────────────────────────────────────────────

export interface CreditDocxMeta {
  borrowerName: string;
  sourceFilename?: string;
  generatedAt: string; // preformatted date string from the caller
}

function buildDocumentXml(analysis: CreditRiskAnalysis, meta: CreditDocxMeta): string {
  const body: string[] = [];

  // Title block.
  body.push(
    para(run("Credit Risk Alert", { b: true, sz: 44, color: "0F172A" }), { spaceAfter: 40 }),
    para(run(meta.borrowerName || "Credit Application", { b: true, sz: 30, color: "B91C1C" }), {
      spaceAfter: 60,
    }),
    para(
      run(
        [
          meta.sourceFilename ? `Source: ${meta.sourceFilename}` : null,
          `Generated: ${meta.generatedAt}`,
        ]
          .filter(Boolean)
          .join("    ·    "),
        { sz: 18, color: "64748B" },
      ),
      { spaceAfter: 40 },
    ),
  );

  // Overall risk.
  const ov = IND[analysis.overallRisk] ?? IND.probe;
  body.push(
    para(
      run("Overall risk:  ", { b: true, sz: 22, color: "0F172A" }) +
        run(ov.label, { b: true, sz: 22, color: ov.color }),
      { spaceAfter: 80 },
    ),
  );

  // Executive summary.
  body.push(heading("Executive Summary"));
  body.push(para(run(analysis.applicationSummary || "—", { sz: 22 }), { spaceAfter: 80 }));

  // Risk Radar — the 8-segment table, always in canonical order.
  body.push(heading("Risk Radar — 8 Dimensions"));
  body.push(
    para(
      run(
        "Risk highlighting only. Every finding is traced to a historical post-mortem case in the knowledge base.",
        { i: true, sz: 18, color: "64748B" },
      ),
      { spaceAfter: 80 },
    ),
  );

  const COLS = [1500, 1000, 4100, 2760];
  const byKey = new Map(analysis.riskTable.map((f) => [f.segment, f] as const));

  const headerCells =
    cell(para(run("Dimension", { b: true, color: "FFFFFF", sz: 18 })), { w: COLS[0], fill: "0F172A" }) +
    cell(para(run("Risk", { b: true, color: "FFFFFF", sz: 18 })), { w: COLS[1], fill: "0F172A" }) +
    cell(para(run("Finding", { b: true, color: "FFFFFF", sz: 18 })), { w: COLS[2], fill: "0F172A" }) +
    cell(para(run("KB Reference & Lesson", { b: true, color: "FFFFFF", sz: 18 })), {
      w: COLS[3],
      fill: "0F172A",
    });

  const dataRows = CREDIT_RISK_SEGMENTS.map(({ key, label }, idx) => {
    const f = byKey.get(key);
    const ind = IND[f?.indicator ?? "low"];
    const zebra = idx % 2 === 1 ? "F8FAFC" : undefined;
    const casePage = f?.evidence?.casePage;
    const refHead = f?.traceReference
      ? `${f.traceReference}${casePage != null ? `  ·  p.${casePage}` : ""}`
      : "";
    const refContent = f?.traceReference
      ? para(run(refHead, { b: true, sz: 18, color: "1D4ED8" }), { spaceAfter: 20 }) +
        para(runsHighlighted(f.traceExcerpt || "", f.matchTerms, { i: true, sz: 16, color: "475569" }))
      : para(run("No close historical precedent.", { i: true, sz: 16, color: "94A3B8" }));
    const riskCell =
      para(run(ind.label, { b: true, sz: 18, color: ind.color })) +
      (typeof f?.confidence === "number"
        ? para(run(`${f.confidence}% conf`, { sz: 14, color: "64748B" }), { spaceBefore: 10 })
        : "");
    return `<w:tr>${
      cell(para(run(label, { b: true, sz: 18 })), { w: COLS[0], fill: zebra }) +
      cell(riskCell, { w: COLS[1], fill: zebra }) +
      cell(
        (f?.headline ? para(run(f.headline, { b: true, sz: 18 }), { spaceAfter: 24 }) : "") +
          para(
            f
              ? runsHighlighted(f.finding, f.matchTerms, { sz: 18 })
              : run("No KB-referenced concern surfaced for this dimension.", { sz: 18 }),
          ),
        { w: COLS[2], fill: zebra },
      ) +
      cell(refContent, { w: COLS[3], fill: zebra })
    }</w:tr>`;
  }).join("");

  body.push(table(`<w:tr>${headerCells}</w:tr>${dataRows}`, COLS));
  body.push(EMPTY_PARA);

  // Policy & credit-note alerts.
  body.push(heading("Policy & Credit-Note Alerts"));
  if (analysis.policyAlerts.length === 0) {
    body.push(para(run("No specific policy alerts were raised.", { sz: 21, color: "64748B" }), { spaceAfter: 80 }));
  } else {
    for (const a of analysis.policyAlerts) {
      const st = (a.status === "pass" ? IND.low : a.status === "fail" ? IND.high : IND.probe);
      const stLabel = a.status === "pass" ? "PASS" : a.status === "fail" ? "FAIL" : "PROBE";
      body.push(
        para(
          run(`[${stLabel}] `, { b: true, sz: 21, color: st.color }) +
            run(a.reference ? `${a.reference} — ` : "", { b: true, sz: 21 }) +
            run(a.description || "", { sz: 21 }),
          { indentLeft: 360, hanging: 240, spaceAfter: 60 },
        ),
      );
    }
  }

  // Edge cases.
  const { assumptions, ambiguities } = analysis.edgeCases;
  if (assumptions.length || ambiguities.length) {
    body.push(heading("Edge Cases & Caveats"));
    if (assumptions.length) {
      body.push(para(run("Assumptions made", { b: true, sz: 21, color: "0F172A" }), { spaceAfter: 40 }));
      for (const a of assumptions) body.push(bullet(a));
    }
    if (ambiguities.length) {
      body.push(
        para(run("Ambiguities / missing data", { b: true, sz: 21, color: "0F172A" }), {
          spaceBefore: 80,
          spaceAfter: 40,
        }),
      );
      for (const a of ambiguities) body.push(bullet(a));
    }
  }

  // Probe questions.
  if (analysis.probeQuestions.length) {
    body.push(heading("Questions for the CD Manager"));
    analysis.probeQuestions.forEach((q, i) => body.push(bullet(q, `${i + 1}.  `)));
  }

  // References used.
  if (analysis.referencesUsed.length) {
    body.push(heading("References Used"));
    body.push(
      para(run(analysis.referencesUsed.join("    ·    "), { sz: 20, color: "1D4ED8" }), {
        spaceAfter: 120,
      }),
    );
  }

  // Overall recap — the executive brief (markdown → prose + bold bullets), as a closing summary.
  if (analysis.riskNarrative && analysis.riskNarrative.trim()) {
    body.push(heading("Overall Recap"));
    for (const raw of analysis.riskNarrative.split(/\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const b = line.match(/^[-*]\s+(.*)$/);
      if (b) {
        body.push(
          para(run("•  ", { sz: 21 }) + mdRuns(b[1], { sz: 21 }), {
            indentLeft: 360,
            hanging: 240,
            spaceAfter: 40,
          }),
        );
      } else {
        body.push(para(mdRuns(line, { sz: 22 }), { spaceAfter: 60 }));
      }
    }
  }

  // Disclaimer footer.
  body.push(
    para(
      run(
        "Risk highlighting only — this report does not constitute an approve/reject decision. " +
          "Each finding mirrors a historical case in the internal knowledge base; verify against source documents before acting.",
        { i: true, sz: 16, color: "94A3B8" },
      ),
      { spaceBefore: 200 },
    ),
  );

  const sectPr =
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}${sectPr}</w:body></w:document>`
  );
}

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

const RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

/** Build the .docx as a Blob. PizZip is lazy-imported to keep it out of the initial bundle. */
export async function buildCreditRiskDocx(
  analysis: CreditRiskAnalysis,
  meta: CreditDocxMeta,
): Promise<Blob> {
  const PizZip = (await import("pizzip")).default;
  const zip = new PizZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", buildDocumentXml(analysis, meta));
  const buf = zip.generate({ type: "arraybuffer", compression: "DEFLATE" });
  return new Blob([buf], { type: DOCX_MIME });
}

/** Build and trigger a browser download of the .docx. */
export async function downloadCreditRiskDocx(
  analysis: CreditRiskAnalysis,
  meta: CreditDocxMeta,
): Promise<void> {
  const blob = await buildCreditRiskDocx(analysis, meta);
  const safe = (meta.borrowerName || "credit-risk").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Credit Risk Alert - ${safe || "report"}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
