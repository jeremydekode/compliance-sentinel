// The completed checklist, exported in the CLIENT'S OWN template shape —
// header block, then No. | Area | Information | Checklist | Review | Remarks,
// one row per catalogue item in sheet order. A second "Evidence" sheet carries
// the full machine record (per-source values, pages, methods, verdicts) for
// audit-trail purposes.
//
// Client-side on purpose (same pattern as lib/exports.ts): the browser already
// holds the full report row, and no server round-trip means no second load of
// a 300KB summary_json.

import * as XLSX from "xlsx";
import {
  RSPO_CHECKLIST, CERT_TYPE_LABELS,
  type RspoItemResult, type RspoSource,
} from "./rspo-checklist";

const SOURCE_LABELS: Record<RspoSource, string> = {
  prisma: "PRISMA",
  certificate: "Certificate",
  audit_report: "Audit report",
};

const STATUS_LABELS: Record<string, string> = {
  pass: "Pass",
  mismatch: "Mismatch",
  missing: "Missing",
  needs_review: "Needs review",
  not_applicable: "N/A",
};

interface StoredVerdict {
  verdict?: "accepted" | "flagged" | null;
  remarks?: string;
  by?: string | null;
  at?: string;
}

export function exportRspoChecklist(report: {
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary_json: any;
}): void {
  const sj = report.summary_json ?? {};
  const results: RspoItemResult[] = sj.rspo_results ?? [];
  const verdicts: Record<string, StoredVerdict> = sj.rspo_verdicts ?? {};
  const resultBy = new Map(results.map((r) => [r.itemId, r]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = (sj.rspo_prisma_apps ?? {})[sj.rspo_application_number] as any;
  const certTypeLabel =
    CERT_TYPE_LABELS[sj.rspo_cert_type as keyof typeof CERT_TYPE_LABELS] ?? String(sj.rspo_cert_type ?? "");

  function remarksFor(itemId: string): string {
    const r = resultBy.get(itemId);
    const v = verdicts[itemId];
    const bits: string[] = [];
    if (r && r.status !== "pass" && r.status !== "not_applicable") {
      bits.push(`AI: ${STATUS_LABELS[r.status] ?? r.status} — ${r.reason}`);
    }
    if (v?.verdict || v?.remarks) {
      const who = v.by ? ` (${v.by})` : "";
      const what = v.verdict === "flagged" ? "Flagged" : v.verdict === "accepted" ? "Accepted" : "";
      bits.push(`Reviewer${who}: ${[what, v.remarks].filter(Boolean).join(" — ")}`);
    }
    return bits.join(" | ");
  }

  function reviewCell(itemId: string): boolean {
    const r = resultBy.get(itemId);
    const v = verdicts[itemId];
    if (v?.verdict === "flagged") return false;
    if (v?.verdict === "accepted") return true;
    return r?.status === "pass";
  }

  // ── Sheet 1: the client's checklist layout ────────────────────────────────
  const aoa: unknown[][] = [
    [],
    ["SCC License  Review Checklist"],
    [],
    ["Management Unit Name", app?.legalEntity?.name ?? report.title ?? ""],
    ["License type", certTypeLabel],
    ["License Request ID", sj.rspo_application_number ?? ""],
    ["Type of Assessment", app?.audit?.assessmentTypeCode ?? ""],
    ["Name of Certification Body", app?.audit?.certificationBody ?? ""],
    ["Review Date", new Date().toISOString().slice(0, 10)],
    [],
    ["No.", "Area", "Information", "Checklist", "Review", "Remarks"],
  ];

  let lastArea = "";
  let lastGroup = "";
  let areaNo = 0;
  for (const item of RSPO_CHECKLIST) {
    const r = resultBy.get(item.id);
    const areaCell = item.area !== lastArea ? (areaNo += 1, item.area) : "";
    if (item.area !== lastArea) { lastArea = item.area; lastGroup = ""; }
    const groupCell = item.group && item.group !== lastGroup ? item.group : "";
    if (item.group) lastGroup = item.group;
    const naText = r?.status === "not_applicable" ? `N/A — ${r.reason}` : "";
    aoa.push([
      areaCell ? String(areaNo) : "",
      areaCell,
      groupCell,
      item.label,
      r ? (r.status === "not_applicable" ? "N/A" : reviewCell(item.id)) : "",
      naText || remarksFor(item.id),
    ]);
  }

  const main = XLSX.utils.aoa_to_sheet(aoa);
  main["!cols"] = [{ wch: 5 }, { wch: 20 }, { wch: 38 }, { wch: 72 }, { wch: 10 }, { wch: 80 }];

  // ── Sheet 2: evidence trail ───────────────────────────────────────────────
  const evidence = results.map((r) => {
    const item = RSPO_CHECKLIST.find((i) => i.id === r.itemId);
    const v = verdicts[r.itemId];
    const row: Record<string, unknown> = {
      Item: r.itemId,
      Area: item?.area ?? "",
      Checklist: item?.label || item?.group || "",
      Status: STATUS_LABELS[r.status] ?? r.status,
      Method: r.method,
      Reason: r.reason,
    };
    for (const s of ["prisma", "certificate", "audit_report"] as RspoSource[]) {
      const val = r.values[s];
      row[SOURCE_LABELS[s]] = val?.value ?? "";
      row[`${SOURCE_LABELS[s]} page`] = val?.page ?? "";
    }
    row["Reviewer verdict"] = v?.verdict ?? "";
    row["Reviewer remarks"] = v?.remarks ?? "";
    row["Reviewed by"] = v?.by ?? "";
    row["Reviewed at"] = v?.at ?? "";
    return row;
  });
  const ev = XLSX.utils.json_to_sheet(evidence);
  ev["!cols"] = [
    { wch: 8 }, { wch: 18 }, { wch: 50 }, { wch: 12 }, { wch: 12 }, { wch: 60 },
    { wch: 40 }, { wch: 8 }, { wch: 40 }, { wch: 8 }, { wch: 40 }, { wch: 8 },
    { wch: 12 }, { wch: 40 }, { wch: 22 }, { wch: 20 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, main, "Checklist");
  XLSX.utils.book_append_sheet(wb, ev, "Evidence");

  const safe = (report.title ?? "review").replace(/[^\w-]+/g, "_").slice(0, 60);
  const appNo = String(sj.rspo_application_number ?? "").replace(/[^\w-]+/g, "_");
  XLSX.writeFile(wb, `${safe}_SCC_License_Review${appNo ? `_${appNo}` : ""}.xlsx`);
}
