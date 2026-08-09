// The SCC License Review Checklist as a typed rule catalogue.
//
// Encoded 1:1 from the client's "SCC License Review Checklist.xlsx" — every
// row that carries a Review cell becomes an item here, INCLUDING the seven
// section-heading rows whose Checklist cell is blank (they are "does this
// section exist in the audit report" checks). 85 items total: 6 License
// Details, 36 License Application, 7 Application Phase, 12 Certificate,
// 24 Audit Report. Labels are verbatim from the sheet (the export writes them
// back out), ids are stable so reviewer verdicts survive re-runs.
//
// The catalogue only DESCRIBES checks; evaluation lives in rspo-engine.ts.
// Kinds:
//   presence     — the named source must hold a value (optional: absence OK)
//   exact        — values must match across sources after normalisation
//   date         — exact, but through date normalisation
//   consistency  — fuzzy text (names, addresses, scope wording); the AI
//                  proposes a verdict, the reviewer decides — verbatim values
//                  from every source always travel with the result
//   structural   — a pure function over the extractions (NCs closed, volumes
//                  captured, section present…)

export type RspoCertType = "single_site" | "multi_site" | "group";
export type RspoSource = "prisma" | "certificate" | "audit_report";
export type RspoCheckKind = "presence" | "exact" | "date" | "consistency" | "structural";
export type RspoArea =
  | "License Details"
  | "License Application"
  | "Application Phase"
  | "Certificate"
  | "Audit Report";

export type RspoStructuralCheck =
  | "section_present"
  | "file_attached"
  | "all_ncs_closed"
  | "nc_totals_match"
  | "all_sections_marked"
  | "signatures_captured"
  | "volumes_captured"
  | "io_inputs_match"
  | "io_outputs_match"
  | "io_products_match";

export interface RspoChecklistItem {
  /** Stable id (LD-01…AR-24) — verdicts are keyed on this across re-runs. */
  id: string;
  area: RspoArea;
  /** The sheet's "Information" column, verbatim (repeated groups collapse). */
  group: string;
  /** The sheet's "Checklist" column, verbatim. Empty for section-heading rows. */
  label: string;
  /** Omitted = applies to all three certification types. */
  appliesTo?: RspoCertType[];
  /** Gates the two per-business-type blocks: "mill" needs an Independent Palm
   *  Oil Mill site in PRISMA, "non_mill" needs at least one other site. */
  businessGate?: "mill" | "non_mill";
  sources: RspoSource[];
  kind: RspoCheckKind;
  /** Dotted paths into the normalized source shapes. "sites[].name" maps over
   *  an array. Multiple paths on one source = a compound value. */
  fields?: Partial<Record<RspoSource, string | string[]>>;
  structuralCheck?: RspoStructuralCheck;
  /** For section_present: the heading token to find in sectionsFound. */
  section?: string;
  /** Fan the comparison out per site / group member row. */
  perEntity?: "site" | "member";
  /** Absence is legitimate (no trainees, no outsourcing) — null passes with a
   *  "none declared" reason instead of flagging missing. */
  optional?: boolean;
  /** Sub-bullet reviewer guidance from the sheet, shown in the UI. */
  notes?: string;
}

export type RspoItemStatus = "pass" | "mismatch" | "missing" | "not_applicable" | "needs_review";

export interface RspoSourceValue {
  value: string | null;
  page?: number | null;
  quote?: string;
}

export interface RspoItemResult {
  itemId: string;
  status: RspoItemStatus;
  method: "deterministic" | "ai" | "structural";
  /** Always populated — the reviewer judges from these, never from a bare verdict. */
  values: Partial<Record<RspoSource, RspoSourceValue>>;
  reason: string;
  aiConfidence?: number;
  entityRows?: Array<{
    entity: string;
    status: RspoItemStatus;
    values: Partial<Record<RspoSource, RspoSourceValue>>;
    reason: string;
  }>;
}

// ── Normalizers (shared with the engine) ────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

/** Any printed date form → "yyyy-mm-dd", or null when unparseable. Handles
 *  "8 January 2025", "January 8, 2025", "08.01.2025", "08/01/2025" (d/m/y —
 *  the Malaysian/European convention these documents use), and ISO. */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().replace(/(\d+)(st|nd|rd|th)/gi, "$1");
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // d-m-y with dot, slash or dash separators ("25-07-2024") — checked AFTER
  // the ISO pattern above, so yyyy-mm-dd can never be misread as d-m-y.
  m = s.match(/(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

/** Supply-chain-model wording → canonical set, e.g. "Mass Balance and SG" →
 *  "MB+SG". Order-insensitive so {MB,SG} equals "SG / Mass Balance". */
export function normalizeScm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).toUpperCase();
  const models = new Set<string>();
  if (/MASS[\s_-]*BALANCE|\bMB\b/.test(s)) models.add("MB");
  if (/SEGREGAT|\bSG\b/.test(s)) models.add("SG");
  if (/IDENTITY[\s_-]*PRESERVED|\bIP\b/.test(s)) models.add("IP");
  if (!models.size) return s.trim() || null;
  return [...models].sort().join("+");
}

/** IDs (certificate numbers, membership numbers, trading IDs): case/space
 *  insensitive, keeps internal punctuation (dashes are significant). */
export function normalizeId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).toUpperCase().replace(/\s+/g, " ").trim();
  return s || null;
}

/** Loose name key for joining per-site rows across sources. */
export function normalizeName(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(sdn|bhd|pte|ltd|llc|inc|gmbh|co|company|the)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── The catalogue ───────────────────────────────────────────────────────────

const LD: RspoChecklistItem[] = [
  { id: "LD-01", area: "License Details", group: "License Information", label: "Audit ID",
    sources: ["prisma"], kind: "presence", fields: { prisma: "applicationNumber" } },
  { id: "LD-02", area: "License Details", group: "License Information", label: "Licence Start Date",
    sources: ["prisma"], kind: "presence", fields: { prisma: "license.startDate" } },
  { id: "LD-03", area: "License Details", group: "License Information", label: "Licence End Date",
    sources: ["prisma"], kind: "presence", fields: { prisma: "license.endDate" } },
  { id: "LD-04", area: "License Details", group: "License Information",
    label: "Name and address of the certified company consistent with the audit report and certificate.",
    sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    fields: {
      prisma: ["legalEntity.name", "legalEntity.address"],
      certificate: ["certifiedCompanyName", "address"],
      audit_report: ["organisation.managementUnitName", "organisation.address"],
    } },
  { id: "LD-05", area: "License Details", group: "License Information",
    label: "Name and address of the parent company consistent with the audit report and certificate.",
    sources: ["prisma", "certificate", "audit_report"], kind: "consistency", optional: true,
    fields: {
      prisma: "parentCompany.name",
      certificate: "parentCompanyName",
      audit_report: "membership.memberName",
    },
    notes: "The audit report states the RSPO member name (§2.2), which is normally the parent entity." },
  { id: "LD-06", area: "License Details", group: "License Information",
    label: "RSPO membership no. consistent with the audit report and certificate.",
    sources: ["prisma", "certificate", "audit_report"], kind: "exact",
    fields: {
      prisma: "membership.number",
      certificate: "membershipNumber",
      audit_report: "membership.number",
    } },
];

const LA: RspoChecklistItem[] = [
  { id: "LA-01", area: "License Application", group: "Closing Meeting", label: "Closing Meeting Date",
    sources: ["prisma", "audit_report"], kind: "date",
    fields: { prisma: "audit.closingMeetingDate", audit_report: "closingMeetingDate" } },
  { id: "LA-02", area: "License Application", group: "Central Office (applicable for multi-site certification)",
    label: "Central Office Name", appliesTo: ["multi_site"],
    sources: ["prisma"], kind: "presence", fields: { prisma: "centralOffice.name" } },
  { id: "LA-03", area: "License Application", group: "Group Manager Information (applicable for group certification)",
    label: "Group Manager Name", appliesTo: ["group"],
    sources: ["prisma"], kind: "presence", fields: { prisma: "groupManager.name" } },
  { id: "LA-04", area: "License Application", group: "Group Manager Information (applicable for group certification)",
    label: "Group Manager Email", appliesTo: ["group"],
    sources: ["prisma"], kind: "presence", fields: { prisma: "groupManager.email" } },
  { id: "LA-05", area: "License Application", group: "Management Unit", label: "MU ID",
    sources: ["prisma"], kind: "presence", fields: { prisma: "managementUnits[].id" } },
  { id: "LA-06", area: "License Application", group: "Management Unit", label: "MU Name",
    sources: ["prisma"], kind: "presence", fields: { prisma: "managementUnits[].name" } },
  { id: "LA-07", area: "License Application", group: "Management Unit", label: "Trading Account ID",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].tradingAccountId" } },
  { id: "LA-08", area: "License Application", group: "Certification Details", label: "Certificate No.",
    sources: ["prisma", "certificate", "audit_report"], kind: "exact",
    fields: {
      prisma: "certificate.number",
      certificate: "certificateNumber",
      audit_report: "certificateInfo.certificateNumber",
    } },
  { id: "LA-09", area: "License Application", group: "Certification Details", label: "Certificate Start Date",
    sources: ["prisma", "certificate", "audit_report"], kind: "date",
    fields: {
      prisma: "certificate.startDate",
      certificate: "certificateStartDate",
      audit_report: "certificateInfo.validityStart",
    } },
  { id: "LA-10", area: "License Application", group: "Certification Details", label: "Certificate End Date",
    sources: ["prisma", "certificate", "audit_report"], kind: "date",
    fields: {
      prisma: "certificate.endDate",
      certificate: "certificateEndDate",
      audit_report: "certificateInfo.validityEnd",
    } },
  { id: "LA-11", area: "License Application", group: "Certification Details", label: "Certificate file",
    sources: ["prisma"], kind: "structural", structuralCheck: "file_attached",
    fields: { prisma: "certificate.fileName" } },
  { id: "LA-12", area: "License Application", group: "Certification Details", label: "Audit report file",
    sources: ["prisma"], kind: "structural", structuralCheck: "file_attached",
    fields: { prisma: "certificate.auditReportFileName" } },
  { id: "LA-13", area: "License Application", group: "Audit Team", label: "Lead Auditor Name",
    sources: ["prisma", "audit_report"], kind: "consistency",
    fields: { prisma: "audit.leadAuditor", audit_report: "auditTeam.leadAuditor" } },
  { id: "LA-14", area: "License Application", group: "Audit Team", label: "Auditor Name",
    sources: ["audit_report"], kind: "presence", optional: true,
    fields: { audit_report: "auditTeam.auditors" },
    notes: "The PRISMA export carries only the lead auditor; other team members are read from the report." },
  { id: "LA-15", area: "License Application", group: "Audit Team", label: "Trainee Auditor / Trainee Lead Auditor",
    sources: ["audit_report"], kind: "presence", optional: true, fields: { audit_report: "auditTeam.trainees" } },
  { id: "LA-16", area: "License Application", group: "Audit Team", label: "Translators",
    sources: ["audit_report"], kind: "presence", optional: true, fields: { audit_report: "auditTeam.translators" } },
  { id: "LA-17", area: "License Application", group: "Audit Team", label: "Observers",
    sources: ["audit_report"], kind: "presence", optional: true, fields: { audit_report: "auditTeam.observers" } },

  // Business Types block — every site that is NOT an independent palm oil mill.
  { id: "LA-18", area: "License Application",
    group: "Business Types (Product Manufacturer/Refinery/Crusher/\nTrader/Distributor/Oleochemical/Food Service Companies/Retailer/Bulking Station)",
    label: "Site Business ID", businessGate: "non_mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].businessId" }, perEntity: "site" },
  { id: "LA-19", area: "License Application", group: "", label: "Site Name", businessGate: "non_mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].name" }, perEntity: "site" },
  { id: "LA-20", area: "License Application", group: "", label: "Site ID", businessGate: "non_mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].id" }, perEntity: "site" },
  { id: "LA-21", area: "License Application", group: "", label: "Address", businessGate: "non_mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].address" }, perEntity: "site" },
  { id: "LA-22", area: "License Application", group: "", label: "Outsourcing Sites", businessGate: "non_mill",
    sources: ["audit_report"], kind: "presence", optional: true,
    fields: { audit_report: "outsourcing.details" },
    notes: "Outsourcing arrangements are read from audit report §2.5 — not confidently present in the PRISMA export." },
  { id: "LA-23", area: "License Application", group: "",
    label: "Supply Chain Model (IP/SG/MB) consistent with \naudit report and certificate.", businessGate: "non_mill",
    sources: ["prisma", "certificate", "audit_report"], kind: "exact", perEntity: "site",
    fields: {
      prisma: "sites[].supplyChainModels",
      certificate: "supplyChainModel",
      audit_report: "certificateInfo.supplyChainModel",
    } },
  { id: "LA-24", area: "License Application", group: "", label: "Input list consistent with audit report and certificate",
    businessGate: "non_mill", sources: ["prisma", "audit_report"], kind: "structural",
    structuralCheck: "io_inputs_match" },
  { id: "LA-25", area: "License Application", group: "", label: "Output list consistent with audit report and certificate",
    businessGate: "non_mill", sources: ["prisma", "audit_report"], kind: "structural",
    structuralCheck: "io_outputs_match" },

  // Independent Palm Oil Mill block — gated on a mill site existing in PRISMA.
  { id: "LA-26", area: "License Application", group: "Business Type (Independent Palm Oil Mill)",
    label: "Site Business ID", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].businessId" }, perEntity: "site" },
  { id: "LA-27", area: "License Application", group: "", label: "Site Name", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].name" }, perEntity: "site" },
  { id: "LA-28", area: "License Application", group: "", label: "Site ID", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].id" }, perEntity: "site" },
  { id: "LA-29", area: "License Application", group: "", label: "GPS Coordinates", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].gps" }, perEntity: "site" },
  { id: "LA-30", area: "License Application", group: "", label: "Address", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].address" }, perEntity: "site" },
  { id: "LA-31", area: "License Application", group: "", label: "Mill Capacity", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].millCapacity" }, perEntity: "site" },
  { id: "LA-32", area: "License Application", group: "",
    label: "Supply Chain Model (IP/SG/MB) consistent with audit report and certificate.", businessGate: "mill",
    sources: ["prisma", "certificate", "audit_report"], kind: "exact", perEntity: "site",
    fields: {
      prisma: "sites[].supplyChainModels",
      certificate: "supplyChainModel",
      audit_report: "certificateInfo.supplyChainModel",
    } },
  { id: "LA-33", area: "License Application", group: "", label: "CSPO Certified Volume (MT)", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].cspoVolume" }, perEntity: "site" },
  { id: "LA-34", area: "License Application", group: "", label: "CSPK Certified Volume (MT)", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].cspkVolume" }, perEntity: "site" },
  { id: "LA-35", area: "License Application", group: "", label: "Average OER (%)", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].oer" }, perEntity: "site" },
  { id: "LA-36", area: "License Application", group: "", label: "Average KER (%)", businessGate: "mill",
    sources: ["prisma"], kind: "presence", fields: { prisma: "sites[].ker" }, perEntity: "site" },
];

const AP: RspoChecklistItem[] = [
  { id: "AP-01", area: "Application Phase", group: "Audit Information", label: "Certification Body",
    sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    fields: {
      prisma: "audit.certificationBody",
      certificate: "certificationBodyName",
      audit_report: "certificationBody",
    } },
  { id: "AP-02", area: "Application Phase", group: "Audit Information",
    label: "Central Office (applicable for multi-site certification)", appliesTo: ["multi_site"],
    sources: ["prisma"], kind: "presence", fields: { prisma: "centralOffice.name" } },
  { id: "AP-03", area: "Application Phase", group: "Audit Information",
    label: "Group Manager Name (applicable for group certification)", appliesTo: ["group"],
    sources: ["prisma"], kind: "presence", fields: { prisma: "groupManager.name" } },
  { id: "AP-04", area: "Application Phase", group: "Audit Information",
    label: "Group Manager Email (applicable for group certification)", appliesTo: ["group"],
    sources: ["prisma"], kind: "presence", fields: { prisma: "groupManager.email" } },
  { id: "AP-05", area: "Application Phase", group: "Audit Information", label: "Audit Type",
    sources: ["prisma"], kind: "presence", fields: { prisma: "audit.typeCode" },
    notes: "PRISMA stores a code (e.g. AT-03); the data dictionary is an open client question." },
  { id: "AP-06", area: "Application Phase", group: "Audit Information", label: "Assessment Type",
    sources: ["prisma"], kind: "presence", fields: { prisma: "audit.assessmentTypeCode" } },
  { id: "AP-07", area: "Application Phase", group: "Audit Information", label: "Mode of Certification",
    sources: ["prisma"], kind: "presence", fields: { prisma: "audit.modeOfCertificationCode" } },
];

const CT: RspoChecklistItem[] = [
  { id: "CT-01", area: "Certificate", group: "General information", label: "Name of Certified Company",
    sources: ["certificate"], kind: "presence", fields: { certificate: "certifiedCompanyName" } },
  { id: "CT-02", area: "Certificate", group: "General information", label: "Address of Certified Company",
    sources: ["certificate"], kind: "presence", fields: { certificate: "address" } },
  { id: "CT-03", area: "Certificate", group: "General information", label: "Membership number",
    sources: ["certificate", "prisma"], kind: "exact",
    fields: { certificate: "membershipNumber", prisma: "membership.number" } },
  { id: "CT-04", area: "Certificate", group: "General information", label: "Parent company name",
    sources: ["certificate"], kind: "presence", optional: true, fields: { certificate: "parentCompanyName" } },
  { id: "CT-05", area: "Certificate", group: "General information", label: "Certificate number",
    sources: ["certificate", "prisma"], kind: "exact",
    fields: { certificate: "certificateNumber", prisma: "certificate.number" } },
  { id: "CT-06", area: "Certificate", group: "General information", label: "Certificate Start Date",
    sources: ["certificate", "prisma"], kind: "date",
    fields: { certificate: "certificateStartDate", prisma: "certificate.startDate" } },
  { id: "CT-07", area: "Certificate", group: "General information", label: "Certificate Expiration Date",
    sources: ["certificate", "prisma"], kind: "date",
    fields: { certificate: "certificateEndDate", prisma: "certificate.endDate" } },
  { id: "CT-08", area: "Certificate", group: "General information", label: "Date of first RSPO certification",
    sources: ["certificate"], kind: "presence", optional: true, fields: { certificate: "firstCertificationDate" } },
  { id: "CT-09", area: "Certificate", group: "General information", label: "Supply Chain model",
    sources: ["certificate", "prisma"], kind: "exact",
    fields: { certificate: "supplyChainModel", prisma: "supplyChainModelsSummary" } },
  { id: "CT-10", area: "Certificate", group: "General information", label: "Scope of certification",
    sources: ["certificate", "audit_report"], kind: "consistency",
    fields: { certificate: "scopeOfCertification", audit_report: "certificateInfo.scope" } },
  { id: "CT-11", area: "Certificate", group: "General information",
    label: "Information of Participating Sites (applicable for multi-site certification)",
    appliesTo: ["multi_site"], sources: ["certificate"], kind: "presence",
    fields: { certificate: "sites[].name" } },
  { id: "CT-12", area: "Certificate", group: "General information",
    label: "Information of Group Members (applicable for group certification)",
    appliesTo: ["group"], sources: ["certificate"], kind: "presence",
    fields: { certificate: "groupMembers[].name" } },
];

const SITE_TABLE_NOTES =
  "- Ensure type of business align with scope of activities\n- For mode of audit, if remote, make sure the justification is align with contigency audit procedure";

const AR: RspoChecklistItem[] = [
  { id: "AR-01", area: "Audit Report", group: "1.1 Description of Certification Body", label: "",
    sources: ["audit_report"], kind: "structural", structuralCheck: "section_present", section: "1.1" },
  { id: "AR-02", area: "Audit Report", group: "2.1 Organisational Overview",
    label: "Ensure the management unit name and address consistent with certificate and prisma",
    sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    fields: {
      prisma: ["legalEntity.name", "legalEntity.address"],
      certificate: ["certifiedCompanyName", "address"],
      audit_report: ["organisation.managementUnitName", "organisation.address"],
    } },
  { id: "AR-03", area: "Audit Report", group: "2.2 RSPO Membership Information",
    label: "Ensure the membership number and RSPO member name consistent with certificate and prisma",
    sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    fields: {
      prisma: ["membership.number", "legalEntity.name"],
      certificate: ["membershipNumber", "certifiedCompanyName"],
      audit_report: ["membership.number", "membership.memberName"],
    } },
  { id: "AR-04", area: "Audit Report", group: "2.3 Certificate Information",
    label: "Ensure the certificate number, prisma trading ID, scope of certification, supply chain model, certificate validity consistent with certificate and prisma (applicable for single site certification)",
    appliesTo: ["single_site"], sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    fields: {
      prisma: ["certificate.number", "sites[].tradingAccountId", "supplyChainModelsSummary", "certificate.startDate", "certificate.endDate"],
      certificate: ["certificateNumber", "supplyChainModel", "scopeOfCertification", "certificateStartDate", "certificateEndDate"],
      audit_report: ["certificateInfo.certificateNumber", "certificateInfo.tradingId", "certificateInfo.scope", "certificateInfo.supplyChainModel", "certificateInfo.validityStart", "certificateInfo.validityEnd"],
    } },
  { id: "AR-05", area: "Audit Report", group: "2.3 Certificate Information",
    label: "Ensure the certificate number and certificate validity consistent with certificate and prisma (applicable for multi-site certification)",
    appliesTo: ["multi_site"], sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    fields: {
      prisma: ["certificate.number", "certificate.startDate", "certificate.endDate"],
      certificate: ["certificateNumber", "certificateStartDate", "certificateEndDate"],
      audit_report: ["certificateInfo.certificateNumber", "certificateInfo.validityStart", "certificateInfo.validityEnd"],
    } },
  { id: "AR-06", area: "Audit Report", group: "2.3 Certificate Information",
    label: "Ensure the certificate number and certificate validity consistent with certificate and prisma (applicable for group certification)",
    appliesTo: ["group"], sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    fields: {
      prisma: ["certificate.number", "certificate.startDate", "certificate.endDate"],
      certificate: ["certificateNumber", "certificateStartDate", "certificateEndDate"],
      audit_report: ["certificateInfo.certificateNumber", "certificateInfo.validityStart", "certificateInfo.validityEnd"],
    } },
  { id: "AR-07", area: "Audit Report", group: "2.4 Description of the Management Unit",
    label: "Ensure the type of business, list of product category, mode of audit consistent with certificate and prisma (applicable for single site certification)",
    appliesTo: ["single_site"], sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    fields: {
      prisma: ["sites[].businessType", "sites[].inputOutput"],
      certificate: ["scopeOfCertification"],
      audit_report: ["managementUnitDescription.businessTypes", "managementUnitDescription.productCategories", "managementUnitDescription.modeOfAudit"],
    },
    notes: SITE_TABLE_NOTES },
  { id: "AR-08", area: "Audit Report", group: "2.4 Description of the Management Unit",
    label: "Ensure the site name, site address, prisma trading ID, type of business, scope of certification, supply chain model, roles, outsourcing, site audited consistent with certificate and prisma (applicable for multi-site certification)",
    appliesTo: ["multi_site"], sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    perEntity: "site",
    fields: {
      prisma: ["sites[].name", "sites[].address", "sites[].tradingAccountId", "sites[].businessType", "sites[].supplyChainModels"],
      certificate: ["sites[].name", "sites[].address", "sites[].supplyChainModel"],
      audit_report: ["sites[].name", "sites[].address", "sites[].tradingId", "sites[].businessType", "sites[].supplyChainModel", "sites[].audited"],
    },
    notes: SITE_TABLE_NOTES },
  { id: "AR-09", area: "Audit Report", group: "2.4 Description of the Management Unit",
    label: "Ensure the site name, site address, prisma trading ID, type of business, scope of certification, supply chain model, roles, outsourcing, site audited consistent with certificate and prisma (applicable for group certification)",
    appliesTo: ["group"], sources: ["prisma", "certificate", "audit_report"], kind: "consistency",
    perEntity: "site",
    fields: {
      prisma: ["sites[].name", "sites[].address", "sites[].tradingAccountId", "sites[].businessType", "sites[].supplyChainModels"],
      certificate: ["groupMembers[].name", "groupMembers[].address", "groupMembers[].supplyChainModel"],
      audit_report: ["sites[].name", "sites[].address", "sites[].tradingId", "sites[].businessType", "sites[].supplyChainModel", "sites[].audited"],
    },
    notes: SITE_TABLE_NOTES },
  { id: "AR-10", area: "Audit Report", group: "2.5 Outsourcing Details",
    label: "Ensure the information consistent with prisma",
    sources: ["prisma", "audit_report"], kind: "consistency", optional: true,
    fields: { prisma: "outsourcingSummary", audit_report: "outsourcing.details" } },
  { id: "AR-11", area: "Audit Report", group: "3.1 Audit Methodology", label: "",
    sources: ["audit_report"], kind: "structural", structuralCheck: "section_present", section: "3.1" },
  { id: "AR-12", area: "Audit Report", group: "3.2 Audit Team Member",
    label: "Check lead auditor consistent with prisma (audit module)",
    sources: ["prisma", "audit_report"], kind: "consistency",
    fields: { prisma: "audit.leadAuditor", audit_report: "auditTeam.leadAuditor" } },
  { id: "AR-13", area: "Audit Report", group: "3.3 Audit Plan",
    label: "Check closing meeting date consistent with prisma (audit module)",
    sources: ["prisma", "audit_report"], kind: "date",
    fields: { prisma: "audit.closingMeetingDate", audit_report: "closingMeetingDate" } },
  { id: "AR-14", area: "Audit Report", group: "3.3.1 Changes of the initial audit plan (if applicable)", label: "",
    sources: ["audit_report"], kind: "structural", structuralCheck: "section_present", section: "3.3.1",
    optional: true },
  { id: "AR-15", area: "Audit Report", group: "3.4 Audit Findings & Results for RSPO Supply Chain Certification Standards", label: "",
    sources: ["audit_report"], kind: "structural", structuralCheck: "section_present", section: "3.4" },
  { id: "AR-16", area: "Audit Report", group: "3.4.1 Audit Findings & Results for RSPO Rules on Market Communications and Claims", label: "",
    sources: ["audit_report"], kind: "structural", structuralCheck: "section_present", section: "3.4.1",
    optional: true },
  { id: "AR-17", area: "Audit Report", group: "3.5 Summary of Audit Findings",
    label: "Check total number of audit findings (NCs) to be consistent with the NCs found in Section 3.4",
    sources: ["audit_report"], kind: "structural", structuralCheck: "nc_totals_match" },
  { id: "AR-18", area: "Audit Report", group: "3.6 Nonconformity(ies) Issue in this Audit",
    label: "Check all status of all NCs have been covered and closed",
    sources: ["audit_report"], kind: "structural", structuralCheck: "all_ncs_closed" },
  { id: "AR-19", area: "Audit Report", group: "3.7 Nonconformity(ies) raised in the previous audit", label: "",
    sources: ["audit_report"], kind: "structural", structuralCheck: "section_present", section: "3.7",
    optional: true },
  { id: "AR-20", area: "Audit Report", group: "4. Audit Conclusion, Recommendation & Confirmation by\nLead Auditor",
    label: "Ensure all sections are marked",
    sources: ["audit_report"], kind: "structural", structuralCheck: "all_sections_marked" },
  { id: "AR-21", area: "Audit Report", group: "5. Acknowledgement of Internal Responsibility and Formal\nSign-Off of Assessment Finding",
    label: "Ensure all signatures are captured",
    sources: ["audit_report"], kind: "structural", structuralCheck: "signatures_captured" },
  { id: "AR-22", area: "Audit Report", group: "APPENDIX 1: Volume Summary",
    label: "Ensure the volumes are captured",
    sources: ["audit_report"], kind: "structural", structuralCheck: "volumes_captured" },
  { id: "AR-23", area: "Audit Report", group: "APPENDIX 2: History of the changes in the current certification cycle.", label: "",
    sources: ["audit_report"], kind: "structural", structuralCheck: "section_present", section: "APPENDIX 2",
    optional: true },
  { id: "AR-24", area: "Audit Report", group: "APPENDIX 3: List of certified input and output products",
    label: "Ensure all input and output products listed are aligned with prisma (audit module)",
    sources: ["prisma", "audit_report"], kind: "structural", structuralCheck: "io_products_match" },
];

export const RSPO_CHECKLIST: RspoChecklistItem[] = [...LD, ...LA, ...AP, ...CT, ...AR];

export const RSPO_AREAS: RspoArea[] = [
  "License Details", "License Application", "Application Phase", "Certificate", "Audit Report",
];

export const CERT_TYPE_LABELS: Record<RspoCertType, string> = {
  single_site: "Single Site Certification",
  multi_site: "Multi-Site Certification",
  group: "Group Certification",
};

/**
 * The items that actually apply to one review. `hasMill`/`hasNonMill` come
 * from the PRISMA sites' business types; when PRISMA gave us no sites at all,
 * both gates stay open so the checks surface as missing rather than silently
 * vanishing as not-applicable.
 */
export function applicableItems(
  certType: RspoCertType,
  opts: { hasMill: boolean; hasNonMill: boolean; sitesKnown: boolean },
): { applicable: RspoChecklistItem[]; excluded: RspoChecklistItem[] } {
  const applicable: RspoChecklistItem[] = [];
  const excluded: RspoChecklistItem[] = [];
  for (const item of RSPO_CHECKLIST) {
    if (item.appliesTo && !item.appliesTo.includes(certType)) { excluded.push(item); continue; }
    if (item.businessGate && opts.sitesKnown) {
      const open = item.businessGate === "mill" ? opts.hasMill : opts.hasNonMill;
      if (!open) { excluded.push(item); continue; }
    }
    applicable.push(item);
  }
  return { applicable, excluded };
}
