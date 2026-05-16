import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

export function exportExcel(report: any, changes: any[], impacts: any[]) {
  const wb = XLSX.utils.book_new();

  const changesSheet = XLSX.utils.json_to_sheet(
    changes.map((c) => ({
      Chapter: c.chapter_ref,
      "Old Requirement": c.old_requirement,
      "New Requirement": c.new_requirement,
      "Change Summary": c.change_summary,
      Impact: c.impact?.toUpperCase(),
      "Tone Shift": c.tone_shift,
    }))
  );
  XLSX.utils.book_append_sheet(wb, changesSheet, "Regulatory Changes");

  const impactsSheet = XLSX.utils.json_to_sheet(
    impacts.map((i) => ({
      SOP: i.sop_title,
      "Change Type": i.change_type,
      Chapter: i.chapter,
      Page: i.page,
      Lines: i.line_range,
      Paragraph: i.paragraph,
      Find: i.find_text,
      "Replace / Insert": i.edited_text ?? i.replace_text,
      Status: i.status,
      Warning: i.warning,
    }))
  );
  XLSX.utils.book_append_sheet(wb, impactsSheet, "SOP Impacts");

  const fname = `${report.policy_name.replace(/\s+/g, "_")}_Gap_Analysis.xlsx`;
  XLSX.writeFile(wb, fname);
}

function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function mdInline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function diffLabels(c: any, policyName?: string) {
  const src = c?.diff_source ?? "document";
  const doc = policyName || "this regulatory document";
  if (src === "new") {
    return {
      kind: "new" as const,
      showBefore: false,
      beforeLabel: "",
      afterLabel: "New requirement",
      footer: `New mandate introduced by ${doc} — no prior wording exists.`,
      comparedAgainst: [] as string[],
    };
  }
  if (src === "kb") {
    return {
      kind: "kb" as const,
      showBefore: true,
      beforeLabel: "Current state (per Knowledge Base)",
      afterLabel: `New requirement (per ${doc})`,
      footer: `Reconstructed by comparing ${doc} against your Knowledge Base.`,
      comparedAgainst: (c?.compared_against ?? []) as string[],
    };
  }
  return {
    kind: "document" as const,
    showBefore: true,
    beforeLabel: `Previous wording (per ${doc})`,
    afterLabel: `Updated wording (per ${doc})`,
    footer: `Diff is stated directly inside ${doc}.`,
    comparedAgainst: [] as string[],
  };
}

function impactColor(i: string) {
  return i === "high" ? "#b91c1c" : i === "medium" ? "#b45309" : "#15803d";
}

function buildPresentation(report: any, changes: any[], impacts: any[]) {
  const s: any = report.summary_json ?? {};
  const counts = {
    high: changes.filter((c) => c.impact === "high").length,
    medium: changes.filter((c) => c.impact === "medium").length,
    low: changes.filter((c) => c.impact === "low").length,
  };

  const impactsForChange = (chapter_ref: string): any[] => {
    if (!chapter_ref || !impacts?.length) return [];
    const norm = chapter_ref.toLowerCase().replace(/\s+/g, " ").trim();
    const out: any[] = [];
    for (const imp of impacts) {
      const ic = String(imp.chapter ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (ic && (ic === norm || ic.includes(norm) || norm.includes(ic))) {
        out.push(imp);
      }
    }
    return out;
  };
  const formatLoc = (imp: any) => [
    imp.paragraph,
    imp.page ? `p. ${imp.page}` : null,
    imp.line_range ? `ll. ${imp.line_range}` : null,
  ].filter(Boolean).join(" · ");

  const slides: string[] = [];

  slides.push(`
    <h1>Executive Summary</h1>
    <div class="body">
      <div class="stats-row">
        <div class="stat-box"><div class="stat-l">Clauses Before</div><div class="stat-n">${esc(s.before_count ?? "—")}</div></div>
        <div class="stat-box"><div class="stat-l">Clauses After</div><div class="stat-n">${esc(s.after_count ?? "—")}</div></div>
        <div class="stat-box"><div class="stat-l">Effective Date</div><div class="stat-n">${esc(s.effective_date ?? "—")}</div></div>
      </div>
      <div class="exec-box">${mdInline(s.executive ?? "")}</div>
      ${(s.immediate_actions ?? []).length ? `
        <div><h2>Immediate Actions</h2>
          <ol class="actions">${(s.immediate_actions ?? []).map((a: string) => `<li>${mdInline(a)}</li>`).join("")}</ol>
        </div>` : ""}
    </div>
  `);

  const chunkChanges: any[][] = [];
  for (let i = 0; i < changes.length; i += 4) chunkChanges.push(changes.slice(i, i + 4));
  (chunkChanges.length ? chunkChanges : [[]]).forEach((group, gi) => {
    slides.push(`
      <h1>Key Changes & Tone Shift${chunkChanges.length > 1 ? ` (${gi + 1}/${chunkChanges.length})` : ""}</h1>
      <div class="body">
        <div class="changes-grid">
          ${group.map((ch) => {
            const matched = impactsForChange(ch.chapter_ref);
            const labels = diffLabels(ch, report?.policy_name);
            const beforeBlock = labels.showBefore
              ? `<div class="ba-l">${esc(labels.beforeLabel)}</div><div class="ba-old">${mdInline(ch.old_requirement ?? "")}</div>`
              : "";
            const cmp = labels.kind === "kb" && labels.comparedAgainst.length
              ? `<div class="ba-cmp"><strong>Compared against:</strong> ${labels.comparedAgainst.map(esc).join(" · ")}</div>`
              : "";
            const sopsBlock = matched.length
              ? `<div class="sops"><div class="ba-l">Affected SOP file(s)</div><ul>${matched.map((m: any) => {
                  const loc = formatLoc(m);
                  return `<li><strong>${esc(m.sop_title)}</strong>${loc ? ` — <span style="color:#64748b">${esc(loc)}</span>` : ""}</li>`;
                }).join("")}</ul></div>`
              : `<div class="sops"><em style="color:#94a3b8">No matching SOP found in your Knowledge Base.</em></div>`;
            return `
            <div class="change-card">
              <div class="change-head">
                <div class="change-ref">${mdInline(ch.chapter_ref)}</div>
                <span class="impact-pill" style="background:${impactColor(ch.impact)}">${esc(ch.impact?.toUpperCase())}</span>
              </div>
              ${beforeBlock}
              <div class="ba-l">${esc(labels.afterLabel)}</div><div class="ba-new">${mdInline(ch.new_requirement ?? "")}</div>
              <div class="ba-foot">${esc(labels.footer)}${cmp}</div>
              ${sopsBlock}
            </div>`;
          }).join("")}
        </div>
      </div>
    `);
  });

  slides.push(`
    <h1>Structural Changes</h1>
    <div class="body">
      <div class="three-col">
        <div class="struct green"><div class="struct-tag">NEW SECTIONS</div><ul>${(s.structural?.added ?? []).map((x: string) => `<li>${mdInline(x)}</li>`).join("") || "<li><em>None</em></li>"}</ul></div>
        <div class="struct blue"><div class="struct-tag">RENAMED</div><ul>${(s.structural?.renamed ?? []).map((x: string) => `<li>${mdInline(x)}</li>`).join("") || "<li><em>None</em></li>"}</ul></div>
        <div class="struct amber"><div class="struct-tag">RESTRUCTURED</div><ul>${(s.structural?.restructured ?? []).map((x: string) => `<li>${mdInline(x)}</li>`).join("") || "<li><em>None</em></li>"}</ul></div>
      </div>
    </div>
  `);

  slides.push(`
    <h1>Impact Breakdown</h1>
    <div class="body">
      <div class="three-col">
        <div class="big-stat" style="background:${impactColor("high")}"><div class="big-n">${counts.high}</div><div class="big-l">High Impact</div></div>
        <div class="big-stat" style="background:${impactColor("medium")}"><div class="big-n">${counts.medium}</div><div class="big-l">Medium Impact</div></div>
        <div class="big-stat" style="background:${impactColor("low")}"><div class="big-n">${counts.low}</div><div class="big-l">Low Impact</div></div>
      </div>
    </div>
  `);

  const rowsPerSlide = 10;
  const rowChunks: any[][] = [];
  for (let i = 0; i < changes.length; i += rowsPerSlide) rowChunks.push(changes.slice(i, i + rowsPerSlide));
  (rowChunks.length ? rowChunks : [[]]).forEach((rows, gi) => {
    slides.push(`
      <h1>Impact Assessment Summary${rowChunks.length > 1 ? ` (${gi + 1}/${rowChunks.length})` : ""}</h1>
      <div class="body">
        <table class="impact-table">
          <thead><tr><th>Chapter</th><th>Affected SOP file(s)</th><th style="width:140px">Impact</th></tr></thead>
          <tbody>
            ${rows.map((ch) => {
              const matched = impactsForChange(ch.chapter_ref);
              return `<tr>
                <td>${mdInline(ch.chapter_ref)}</td>
                <td>${matched.length ? matched.map((m: any) => {
                  const loc = formatLoc(m);
                  return `<div><strong>${esc(m.sop_title)}</strong>${loc ? `<div style="color:#64748b;font-size:11px">${esc(loc)}</div>` : ""}</div>`;
                }).join("") : "<em style='color:#94a3b8'>—</em>"}</td>
                <td><span class="impact-pill" style="background:${impactColor(ch.impact)}">${esc(ch.impact?.toUpperCase())}</span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    `);
  });

  slides.push(`
    <h1>Recommended Next Steps</h1>
    <div class="body">
      <div class="three-col">
        ${(s.timeline ?? []).map((p: any, i: number) => `
          <div class="phase">
            <div class="phase-num">${i + 1}</div>
            <h2>${mdInline(p.phase ?? "")}</h2>
            <div class="phase-sub">${mdInline(p.window ?? "")}</div>
            ${p.focus ? `<p>${mdInline(p.focus)}</p>` : ""}
            ${Array.isArray(p.bullets) && p.bullets.length
              ? `<ul class="phase-bullets">${p.bullets.map((b: string) => `<li>${mdInline(b)}</li>`).join("")}</ul>`
              : ""}
          </div>
        `).join("")}
      </div>
    </div>
  `);

  const css = `
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#e2e8f0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a}
    .toolbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:#0f172a;color:#fff}
    .toolbar h1{margin:0;font-size:14px;font-weight:600}
    .toolbar button{cursor:pointer;padding:8px 16px;border-radius:6px;border:0;background:#4f46e5;color:#fff;font-weight:600;font-size:13px}
    .deck{display:flex;flex-direction:column;align-items:center;padding:24px;gap:24px}
    .slide{width:1280px;height:720px;background:#fff;padding:44px 64px 56px;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.12);position:relative;overflow:hidden;display:flex;flex-direction:column}
    .slide h1{font-size:28px;font-weight:800;margin:0;padding-bottom:12px;border-bottom:3px solid #0f172a}
    .slide h2{font-size:16px;font-weight:700;margin:0 0 6px}
    .slide p{margin:0 0 8px;font-size:14px;line-height:1.5}
    .body{flex:1;min-height:0;padding-top:18px;padding-bottom:24px;display:flex;flex-direction:column;gap:14px;overflow:hidden}
    .stats-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
    .stat-box{border:1px solid #e2e8f0;border-radius:8px;padding:14px}
    .stat-l{font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:.05em}
    .stat-n{font-size:26px;font-weight:700;margin-top:6px}
    .exec-box{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px;font-size:14px;line-height:1.5}
    .actions{margin:0;padding-left:20px;font-size:14px;line-height:1.6}
    .changes-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;flex:1;min-height:0;overflow:hidden}
    .change-card{border:1px solid #e2e8f0;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:4px;overflow:hidden;font-size:12px}
    .change-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
    .change-ref{font-weight:700;font-size:13px}
    .ba-l{font-size:10px;text-transform:uppercase;color:#64748b;margin-top:4px}
    .ba-old{background:#f1f5f9;padding:6px 8px;border-radius:4px;font-size:12px}
    .ba-new{background:#eff6ff;border:1px solid #bfdbfe;padding:6px 8px;border-radius:4px;font-size:12px}
    .sops ul{margin:2px 0 0;padding-left:16px;font-size:11px}
    .impact-pill{color:#fff;padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.04em}
    .three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;flex:1;min-height:0}
    .struct{border-radius:8px;padding:14px;border:1.5px solid;overflow:hidden;display:flex;flex-direction:column}
    .struct.green{background:#dcfce7;border-color:#15803d} .struct.blue{background:#dbeafe;border-color:#1d4ed8} .struct.amber{background:#fef3c7;border-color:#b45309}
    .struct-tag{font-weight:700;font-size:11px;margin-bottom:8px;letter-spacing:.05em}
    .struct ul{margin:0;padding-left:18px;font-size:13px;line-height:1.5}
    .big-stat{color:#fff;border-radius:10px;padding:24px;display:flex;flex-direction:column;justify-content:center;align-items:center}
    .big-n{font-size:64px;font-weight:800;line-height:1}
    .big-l{margin-top:8px;font-size:14px;font-weight:600}
    .impact-table{width:100%;border-collapse:collapse;font-size:13px}
    .impact-table th{background:#0f172a;color:#fff;padding:10px;text-align:left}
    .impact-table td{padding:8px 10px;border-top:1px solid #e2e8f0;vertical-align:top}
    .phase{border:1.5px solid #e2e8f0;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:6px;overflow:hidden}
    .phase-num{width:36px;height:36px;border-radius:50%;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
    .phase-sub{font-size:11px;color:#64748b}
    .phase p{font-size:12px;color:#475569;line-height:1.5;margin:4px 0 0}
    .phase-bullets{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.55}
    .phase-bullets li{margin-bottom:4px}
    .ba-foot{margin-top:6px;font-size:10.5px;color:#475569;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:5px 7px;line-height:1.4}
    .ba-cmp{margin-top:3px;color:#0f172a}
    .footer{position:absolute;left:64px;right:64px;bottom:20px;display:flex;justify-content:space-between;font-size:11px;color:#64748b}
    @media print{
      @page{size:1280px 720px;margin:0}
      html,body{background:#fff}
      .toolbar{display:none!important}
      .deck{padding:0;gap:0}
      .slide{box-shadow:none;border-radius:0;page-break-after:always;break-after:page}
      .slide:last-child{page-break-after:auto}
    }
  `;

  const total = slides.length;
  const slidesHtml = slides.map((b, i) => `
    <section class="slide">
      ${b}
      <div class="footer"><span>${esc(report.title ?? "Compliance Gap Analysis")} · Confidential</span><span>${i + 1} / ${total}</span></div>
    </section>
  `).join("\n");

  return { css, slidesHtml, slides, total, title: report.title ?? "Compliance Gap Analysis" };
}

export function exportHtmlPresentation(report: any, changes: any[], impacts: any[]) {
  const { css, slidesHtml, title } = buildPresentation(report, changes, impacts);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=1320"/>
<title>${esc(title)} — Presentation</title>
<style>${css}</style></head>
<body>
<div class="toolbar"><h1>${esc(title)} · Presentation</h1>
<button onclick="window.print()">Print / Save as PDF</button></div>
<div class="deck">${slidesHtml}</div>
</body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportPresentationPDF(report: any, changes: any[], impacts: any[], filename: string) {
  const { css, slidesHtml, title } = buildPresentation(report, changes, impacts);

  // Render into an offscreen iframe so we capture the clean presentation styles
  // (only safe hex colors — no oklch from the app theme).
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:1320px;height:800px;border:0;visibility:hidden;";
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"/><title>${esc(title)}</title><style>${css}</style></head><body><div class="deck">${slidesHtml}</div></body></html>`);
    doc.close();

    // Wait for fonts/layout
    await new Promise((r) => setTimeout(r, 300));
    if ((doc as any).fonts?.ready) {
      try { await (doc as any).fonts.ready; } catch {}
    }

    const slideEls = Array.from(doc.querySelectorAll<HTMLElement>(".slide"));
    if (!slideEls.length) throw new Error("No slides to export");

    // Slides are 1280x720 — use landscape A4.
    const pdf = new jsPDF("l", "mm", "a4");
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    for (let i = 0; i < slideEls.length; i++) {
      const canvas = await html2canvas(slideEls[i], {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        windowWidth: 1280,
        windowHeight: 720,
      });
      const img = canvas.toDataURL("image/png");
      // Fit slide into page preserving aspect ratio, centered.
      const slideRatio = canvas.width / canvas.height;
      const pageRatio = pageW / pageH;
      let w = pageW, h = pageH;
      if (slideRatio > pageRatio) { h = pageW / slideRatio; } else { w = pageH * slideRatio; }
      const x = (pageW - w) / 2;
      const y = (pageH - h) / 2;
      if (i > 0) pdf.addPage();
      pdf.addImage(img, "PNG", x, y, w, h);
    }

    pdf.save(filename);
  } finally {
    iframe.remove();
  }
}

export async function exportPDF(elementId: string, filename: string) {
  const el = document.getElementById(elementId);
  if (!el) throw new Error(`Export target #${elementId} not found`);

  // html2canvas can't parse oklch(); resolve every element's computed colors
  // to RGB on the cloned DOM so it stays visually identical without crashing.
  const COLOR_PROPS = [
    "color",
    "backgroundColor",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
    "outlineColor",
    "fill",
    "stroke",
    "textDecorationColor",
    "caretColor",
    "columnRuleColor",
  ] as const;

  const toRgb = (value: string) => {
    const match = value.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)/i);
    if (!match) return value;
    const l = match[1].endsWith("%") ? parseFloat(match[1]) / 100 : parseFloat(match[1]);
    const c = parseFloat(match[2]);
    const h = (parseFloat(match[3]) * Math.PI) / 180;
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;
    const L = l_ ** 3;
    const M = m_ ** 3;
    const S = s_ ** 3;
    const linR = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
    const linG = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
    const linB = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;
    const gamma = (x: number) => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(gamma(x) * 255)));
    const alpha = match[4] ? (match[4].endsWith("%") ? parseFloat(match[4]) / 100 : parseFloat(match[4])) : 1;
    return alpha < 1 ? `rgba(${clamp(linR)}, ${clamp(linG)}, ${clamp(linB)}, ${alpha})` : `rgb(${clamp(linR)}, ${clamp(linG)}, ${clamp(linB)})`;
  };
  const stripOklch = (value: string) => {
    if (!value || !value.includes("oklch")) return value;
    return value.replace(/oklch\([^)]*\)/g, (match) => toRgb(match) || "rgb(0, 0, 0)");
  };

  const canvas = await html2canvas(el, {
    scale: 2,
    useCORS: true,
    backgroundColor: "#ffffff",
    onclone: (clonedDoc) => {
      const liveRoot = el;
      const clonedRoot = clonedDoc.getElementById(elementId);
      if (!clonedRoot) return;

      const liveAll = [liveRoot, ...Array.from(liveRoot.querySelectorAll<HTMLElement>("*"))];
      const cloneAll = [clonedRoot, ...Array.from(clonedRoot.querySelectorAll<HTMLElement>("*"))];
      const len = Math.min(liveAll.length, cloneAll.length);

      for (let i = 0; i < len; i++) {
        const liveEl = liveAll[i];
        const cloneEl = cloneAll[i] as HTMLElement;
        const cs = window.getComputedStyle(liveEl);
        for (const prop of COLOR_PROPS) {
          const v = cs[prop];
          if (v) {
            try { (cloneEl.style as any)[prop] = stripOklch(v); } catch {}
          }
        }
        // Box-shadow / background-image may contain oklch via gradients — convert tokens, don't drop styling.
        const bg = cs.backgroundImage;
        if (bg && bg !== "none") {
          cloneEl.style.backgroundImage = stripOklch(bg);
        }
        const bs = cs.boxShadow;
        if (bs && bs !== "none") {
          cloneEl.style.boxShadow = stripOklch(bs);
        }
      }
    },
  });

  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF("p", "mm", "a4");
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const imgW = pageWidth;
  const imgH = (canvas.height * imgW) / canvas.width;
  let heightLeft = imgH;
  let position = 0;
  pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
  heightLeft -= pageHeight;
  while (heightLeft > 0) {
    position -= pageHeight;
    pdf.addPage();
    pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
    heightLeft -= pageHeight;
  }
  pdf.save(filename);
}

export function exportInstructionMemo(report: any, impacts: any[]) {
  const approved = (impacts ?? []).filter((i) => i.status === "approved" || i.status === "routed");
  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  const rows = approved.map((i, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${esc(i.sop_title)}<div class="muted">${esc(i.chapter ?? "")} · p.${i.page ?? "—"} · L${esc(i.line_range ?? "—")}</div></td>
      <td>${esc(i.change_type)}</td>
      <td><pre class="find">${esc(i.find_text ?? "—")}</pre></td>
      <td><pre class="repl">${esc(i.edited_text ?? i.replace_text ?? "—")}</pre></td>
      <td>${esc(i.status)}</td>
    </tr>`).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Instruction Memo — ${esc(report.title)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111;max-width:1100px;margin:30px auto;padding:0 24px;}
    h1{font-size:22px;margin:0 0 4px;} h2{font-size:14px;color:#555;margin:0 0 24px;font-weight:500;}
    .meta{display:flex;gap:24px;font-size:12px;color:#555;margin-bottom:24px;border-top:1px solid #ddd;border-bottom:1px solid #ddd;padding:10px 0;}
    table{width:100%;border-collapse:collapse;font-size:11px;}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top;}
    th{background:#f4f4f5;font-size:10px;text-transform:uppercase;letter-spacing:.04em;}
    pre{margin:0;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:10px;}
    .find{background:#fef2f2;color:#7f1d1d;padding:6px;border-radius:3px;}
    .repl{background:#ecfdf5;color:#064e3b;padding:6px;border-radius:3px;}
    .muted{color:#888;font-size:10px;margin-top:2px;}
    .toolbar{position:sticky;top:0;background:#fff;padding:10px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;}
    button{padding:6px 14px;border:1px solid #111;background:#111;color:#fff;border-radius:4px;cursor:pointer;}
    .note{background:#fffbeb;border:1px solid #fde68a;padding:12px;border-radius:6px;font-size:12px;margin:16px 0;color:#78350f;}
  </style></head><body>
  <div class="toolbar"><strong>Instruction Memo</strong><button onclick="window.print()">Print / Save as PDF</button></div>
  <h1>${esc(report.title)}</h1>
  <h2>Manual Execution Instruction Memo</h2>
  <div class="meta"><div><strong>Issued:</strong> ${today}</div><div><strong>Status:</strong> Pending Manual Execution</div><div><strong>Items:</strong> ${approved.length}</div></div>
  <div class="note">The following Find &amp; Replace blocks have been approved and signed-off. Please apply each change to the indicated SOP at the precise location, then confirm completion in the system.</div>
  <table><thead><tr><th>#</th><th>Target SOP / Location</th><th>Change Type</th><th>Find</th><th>Replace / Insert</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:#888;padding:20px;">No approved changes.</td></tr>`}</tbody></table>
  </body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
