// PRISMA / CLM export parser — the "system" leg of the four-source cross-check.
//
// The export is an xlsx whose "audit data" cells hold PYTHON/MONGO REPR STRINGS
// (`[{'k': ObjectId('…'), 'd': datetime.datetime(2025, 1, 8, 0, 0)}]`), not
// JSON. Three hard-won facts shape this module — all verified on the real
// sample, none hypothetical:
//
//   1. The sheet declares `!ref A1:AF1029953` with only 4 real rows. Reading
//      with defaults materialises a million empty rows and OOMs the server fn:
//      hence `blankrows: false`, no `defval`, and a hard row cap.
//   2. Long cells are TRUNCATED at Excel's 32,767-char cell limit, cutting a
//      repr mid-structure. The parser recovers every COMPLETE list element and
//      records a warning, instead of throwing the whole cell away.
//   3. Company names contain apostrophes ("Kramers' Seafood Trading") and
//      mojibake (`PAÂ\xa0`), so regex-to-JSON is hopeless; this is a real
//      recursive-descent parser.
//
// No AI anywhere in this file. A cell that defeats the parser degrades to
// `{ __raw }` + a warning — the affected checklist items become needs_review,
// the run never fails, and nothing is guessed.

export interface PrismaSite {
  /** prisma_site_business_id / asset id (PM25-…, DS25-…). */
  businessId: string | null;
  /** prisma_site_id (S25-…) when known. */
  id: string | null;
  name: string;
  address: string | null;
  businessType: string | null;
  supplyChainModels: string | null;   // canonical "MB+SG" form
  tradingAccountId: string | null;
  inputs: string[];
  outputs: string[];
  allowedToBuy: boolean | null;
  allowedToProcess: boolean | null;
  allowedToSell: boolean | null;
  // Independent-mill fields — absent from the sample export; kept so the
  // checklist paths resolve (null → missing, which is the honest answer).
  gps: string | null;
  millCapacity: string | null;
  cspoVolume: string | null;
  cspkVolume: string | null;
  oer: string | null;
  ker: string | null;
}

export interface PrismaApplication {
  applicationNumber: string;
  legalEntity: { name: string | null; address: string | null };
  parentCompany: { name: string | null; address: string | null };
  membership: { number: string | null; since: string | null; sector: string | null };
  certificate: {
    number: string | null; startDate: string | null; endDate: string | null;
    fileName: string | null; auditReportFileName: string | null;
  };
  audit: {
    typeCode: string | null; assessmentTypeCode: string | null; modeOfCertificationCode: string | null;
    closingMeetingDate: string | null; leadAuditor: string | null; certificationBody: string | null;
  };
  centralOffice: { name: string | null } | null;
  groupManager: { name: string | null; email: string | null } | null;
  managementUnits: Array<{
    id: string | null; name: string; address: string | null;
    businessTypeCode: string | null; tradingAccountId: string | null;
  }>;
  sites: PrismaSite[];
  license: { licenseId: string | null; prismaLicenseId: string | null; startDate: string | null; endDate: string | null };
  supplyChainModelsSummary: string | null;
  outsourcingSummary: string | null;
  parseWarnings: string[];
}

/** Sanity cap: the sample has 4 real rows; a sheet yielding thousands means
 *  we're reading something that isn't the expected export. */
const MAX_DATA_ROWS = 10_000;

// ── Python/Mongo repr parser ────────────────────────────────────────────────

class ReprParser {
  private i = 0;
  truncated = false;

  constructor(private readonly s: string) {}

  parse(): unknown {
    const v = this.value();
    this.ws();
    return v;
  }

  private ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private eof(): boolean {
    return this.i >= this.s.length;
  }

  private value(): unknown {
    this.ws();
    if (this.eof()) { this.truncated = true; return undefined; }
    const c = this.s[this.i];
    if (c === "[") return this.list("[", "]");
    if (c === "(") return this.list("(", ")");
    if (c === "{") return this.dictOrSet();
    if (c === "'" || c === '"') return this.str();
    if (this.match("True")) return true;
    if (this.match("False")) return false;
    if (this.match("None")) return null;
    if (this.match("ObjectId(")) {
      const id = this.value();
      this.expect(")");
      return typeof id === "string" ? id : null;
    }
    if (this.match("datetime.datetime(")) return this.datetime();
    if (this.match("datetime.date(")) return this.datetime();
    if (this.match("DBRef(")) {
      // DBRef('site', ObjectId('…'), …) — the ref id is all we can use.
      const coll = this.value();
      let id: unknown = null;
      this.ws();
      while (!this.eof() && this.s[this.i] === ",") {
        this.i++;
        const part = this.value();
        if (id === null && typeof part === "string") id = part;
        this.ws();
      }
      this.expect(")");
      return { $ref: coll, $id: id };
    }
    if (/[-\d]/.test(c)) return this.num();
    // Bare identifier (e.g. an enum repr) — consume a token so we don't loop.
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.s.slice(this.i));
    if (m) { this.i += m[0].length; return m[0]; }
    throw new Error(`unexpected char '${c}' at ${this.i}`);
  }

  private match(kw: string): boolean {
    if (this.s.startsWith(kw, this.i)) { this.i += kw.length; return true; }
    return false;
  }

  private expect(ch: string) {
    this.ws();
    if (this.eof()) { this.truncated = true; return; }
    if (this.s[this.i] === ch) this.i++;
    else throw new Error(`expected '${ch}' at ${this.i}, got '${this.s[this.i]}'`);
  }

  private list(open: string, close: string): unknown[] {
    this.i++; // consume open
    const out: unknown[] = [];
    // Elements are only committed once their trailing comma/close is seen, so
    // a truncated final element is dropped rather than half-kept.
    for (;;) {
      this.ws();
      if (this.eof()) { this.truncated = true; return out; }
      if (this.s[this.i] === close) { this.i++; return out; }
      let v: unknown;
      try {
        v = this.value();
      } catch {
        this.truncated = true;
        return out;
      }
      this.ws();
      if (this.eof()) { this.truncated = true; return out; } // v was cut off — drop it
      out.push(v);
      if (this.s[this.i] === ",") this.i++;
    }
  }

  private dictOrSet(): unknown {
    this.i++; // consume {
    this.ws();
    if (!this.eof() && this.s[this.i] === "}") { this.i++; return {}; }
    // Peek: a dict has `key:`; a set repr (rare) has bare values.
    const save = this.i;
    let first: unknown;
    try {
      first = this.value();
    } catch {
      this.truncated = true;
      return {};
    }
    this.ws();
    if (!this.eof() && this.s[this.i] === ":") {
      // dict
      this.i++;
      const out: Record<string, unknown> = {};
      let key = typeof first === "string" ? first : String(first);
      for (;;) {
        let v: unknown;
        try {
          v = this.value();
        } catch {
          this.truncated = true;
          return out;
        }
        this.ws();
        if (this.eof()) { this.truncated = true; return out; } // value cut off — drop pair
        out[key] = v;
        if (this.s[this.i] === "}") { this.i++; return out; }
        if (this.s[this.i] === ",") this.i++;
        this.ws();
        if (this.eof()) { this.truncated = true; return out; }
        if (this.s[this.i] === "}") { this.i++; return out; }
        let k: unknown;
        try {
          k = this.value();
        } catch {
          this.truncated = true;
          return out;
        }
        key = typeof k === "string" ? k : String(k);
        this.expect(":");
        if (this.truncated) return out;
      }
    }
    // set
    this.i = save;
    const items = this.list("{", "}");
    return items;
  }

  private str(): string {
    const quote = this.s[this.i];
    this.i++;
    let out = "";
    while (!this.eof()) {
      const c = this.s[this.i];
      if (c === "\\") {
        const n = this.s[this.i + 1];
        if (n === "x") { out += String.fromCharCode(parseInt(this.s.slice(this.i + 2, this.i + 4), 16) || 0); this.i += 4; continue; }
        if (n === "u") { out += String.fromCharCode(parseInt(this.s.slice(this.i + 2, this.i + 6), 16) || 0); this.i += 6; continue; }
        if (n === "n") { out += "\n"; this.i += 2; continue; }
        if (n === "t") { out += "\t"; this.i += 2; continue; }
        out += n; this.i += 2; continue;
      }
      if (c === quote) { this.i++; return out; }
      out += c;
      this.i++;
    }
    this.truncated = true;
    return out;
  }

  private num(): number {
    const m = /^-?\d+(\.\d+)?/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`bad number at ${this.i}`);
    this.i += m[0].length;
    return Number(m[0]);
  }

  private datetime(): string {
    // Already consumed "datetime.datetime(" — read ints until ")".
    const parts: number[] = [];
    for (;;) {
      this.ws();
      if (this.eof()) { this.truncated = true; break; }
      if (this.s[this.i] === ")") { this.i++; break; }
      if (this.s[this.i] === ",") { this.i++; continue; }
      // tzinfo or kwargs — skip to close
      if (!/[-\d]/.test(this.s[this.i])) {
        const close = this.s.indexOf(")", this.i);
        if (close === -1) { this.truncated = true; this.i = this.s.length; break; }
        this.i = close + 1;
        break;
      }
      parts.push(this.num());
    }
    const [y, mo = 1, d = 1] = parts;
    if (!y) return "";
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
}

/** Parses one repr cell. Never throws: an unparseable cell comes back as
 *  `{ __raw }` with ok=false; a truncated cell parses to its complete prefix
 *  with truncated=true. */
export function parsePyRepr(src: string): { value: unknown; truncated: boolean; ok: boolean } {
  const p = new ReprParser(src);
  try {
    const value = p.parse();
    return { value, truncated: p.truncated, ok: true };
  } catch {
    return { value: { __raw: src.slice(0, 2000) }, truncated: false, ok: false };
  }
}

// ── Workbook → PrismaApplication ────────────────────────────────────────────

function get(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur ?? null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "placeholder") return null;
  return s;
}

/** PRISMA address dicts → one printable line. */
function joinAddress(a: unknown): string | null {
  if (a == null || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const parts = [o.street, o.unit_no, o.postal_code, o.city, o.state_province, o.country]
    .map((x) => String(x ?? "").replace(/ /g, " ").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function scmFromBraceSet(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  const models = new Set<string>();
  const up = s.toUpperCase();
  if (up.includes("MASS_BALANCE") || /\bMB\b/.test(up)) models.add("MB");
  if (up.includes("SEGREGAT") || /\bSG\b/.test(up)) models.add("SG");
  if (up.includes("IDENTITY_PRESERVED") || /\bIP\b/.test(up)) models.add("IP");
  return models.size ? [...models].sort().join("+") : s;
}

export async function parsePrismaWorkbook(buffer: Buffer): Promise<{
  applications: Record<string, PrismaApplication>;
  applicationNumbers: string[];
  warnings: string[];
}> {
  const XLSX = await import("xlsx");
  // blankrows:false and NO defval — the sheet's !ref spans a million phantom
  // rows and materialising them is an OOM, not a slowdown.
  const wb = XLSX.read(buffer, { type: "buffer", dense: true });
  const warnings: string[] = [];

  function sheetRows(name: string): Record<string, unknown>[] {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
    if (aoa.length > MAX_DATA_ROWS) {
      throw new Error(`Sheet "${name}" has ${aoa.length} rows — this doesn't look like the expected PRISMA export`);
    }
    const [hdr, ...rows] = aoa;
    if (!hdr) return [];
    const keys = (hdr as unknown[]).map((h) => String(h ?? "").trim());
    return rows
      .filter((r) => r.some((c) => c != null && String(c).trim() !== ""))
      .map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]])));
  }

  const auditRows = sheetRows("audit data");
  const clmRows = sheetRows("clm data");
  const memberRows = sheetRows("clm-membership data");

  if (!auditRows.length) {
    throw new Error('No rows found in the "audit data" sheet — is this the PRISMA export?');
  }

  const memberByNumber = new Map<string, Record<string, unknown>>();
  for (const m of memberRows) {
    const num = str(m["membership_number"]);
    if (num) memberByNumber.set(num, m);
  }

  const applications: Record<string, PrismaApplication> = {};

  for (const row of auditRows) {
    const appNo = str(row["application_number"]);
    if (!appNo) continue;
    const parseWarnings: string[] = [];

    /** Parse a repr cell, tagging warnings with the column name. */
    function cell(col: string): unknown {
      const raw = row[col];
      if (raw == null || String(raw).trim() === "") return null;
      const s = String(raw);
      if (!/^[\[{(]|^ObjectId|^datetime/.test(s.trim())) return s; // plain scalar cell
      const r = parsePyRepr(s);
      if (!r.ok) parseWarnings.push(`${col}: unreadable cell — affected checks need manual review`);
      else if (r.truncated) parseWarnings.push(`${col}: cell truncated at Excel's 32,767-char limit — later entries missing`);
      return r.value;
    }

    const legalEntities = (cell("legal_entities") as unknown[]) ?? [];
    const le = legalEntities[0] ?? null;
    const memberships = (cell("memberships") as unknown[]) ?? [];
    const mem = memberships[0] ?? null;
    const membershipNumber = str(get(mem, "membership_number"));
    const memberRow = membershipNumber ? memberByNumber.get(membershipNumber) : undefined;

    const auditReport = ((cell("audit_report") as unknown[]) ?? [])[0] ?? null;
    const issued = get(auditReport, "issued_certificate_detail");
    const validity = ((get(issued, "certificate_validity_periods") as unknown[]) ?? [])[0] ?? null;

    const auditPlan = ((cell("audit_plan") as unknown[]) ?? [])[0] ?? null;
    const certificationBody = cell("certification_body");
    const centralOffice = cell("central_office");
    const groupManager = cell("group_manager");

    const managementUnitsRaw = (cell("management_units") as unknown[]) ?? [];
    const sitesRaw = (cell("sites") as unknown[]) ?? [];

    // Address AND site-id lookup: audit-data "sites" rows carry both address
    // and prisma_site_id; CLM rows carry the business data (asset id, supply
    // chain models, products) but not the site's own PRISMA id. Joined by
    // loose name key — the id was previously discarded here even though it
    // sits right next to the address in the same source row, which made
    // "Site ID" read as not-found for every site that DID have one.
    const addressByName = new Map<string, string>();
    const siteIdByName = new Map<string, string>();
    for (const s of sitesRaw) {
      const name = str(get(s, "name"));
      if (!name) continue;
      const key = nameKey(name);
      const addr = joinAddress(get(s, "address"));
      if (addr) addressByName.set(key, addr);
      const sid = str(get(s, "prisma_site_id"));
      if (sid) siteIdByName.set(key, sid);
    }
    for (const mu of managementUnitsRaw) {
      const name = str(get(mu, "name"));
      const addr = joinAddress(get(mu, "address"));
      if (name && addr && !addressByName.has(nameKey(name))) addressByName.set(nameKey(name), addr);
    }

    // Sites assembled from CLM rows (deduped per asset; input/output rows merge).
    const clmForApp = clmRows.filter((r) => str(r["audit_id"]) === appNo);
    const siteMap = new Map<string, PrismaSite>();
    let prismaLicenseId: string | null = null;
    for (const r of clmForApp) {
      const assetId = str(r["asset_prisma_id"]) ?? `?-${siteMap.size}`;
      prismaLicenseId = prismaLicenseId ?? str(r["prisma_id"]);
      let site = siteMap.get(assetId);
      if (!site) {
        const name = str(r["name"]) ?? assetId;
        site = {
          businessId: str(r["asset_prisma_id"]),
          id: siteIdByName.get(nameKey(name)) ?? null,
          name,
          address: addressByName.get(nameKey(name)) ?? null,
          businessType: str(r["business_type"]),
          supplyChainModels: scmFromBraceSet(r["supply_chain_models"]),
          tradingAccountId: str(r["trading_account_id"]),
          inputs: [], outputs: [],
          allowedToBuy: typeof r["allowed_to_buy"] === "boolean" ? (r["allowed_to_buy"] as boolean) : null,
          allowedToProcess: typeof r["allowed_to_process"] === "boolean" ? (r["allowed_to_process"] as boolean) : null,
          allowedToSell: typeof r["allowed_to_sell"] === "boolean" ? (r["allowed_to_sell"] as boolean) : null,
          gps: null, millCapacity: null, cspoVolume: null, cspkVolume: null, oer: null, ker: null,
        };
        siteMap.set(assetId, site);
      }
      const product = str(r["product_name"]) ?? str(r["input_output"]);
      if (product) {
        const isInput = /input/i.test(product) || r["allowed_to_buy"] === true;
        (isInput ? site.inputs : site.outputs).push(product);
      }
    }

    const sites = [...siteMap.values()];
    const scmSet = new Set<string>();
    for (const s of sites) for (const m of (s.supplyChainModels ?? "").split("+")) if (m) scmSet.add(m);

    applications[appNo] = {
      applicationNumber: appNo,
      legalEntity: {
        name: str(get(le, "name")),
        address: joinAddress(get(le, "mailing_address")),
      },
      parentCompany: { name: null, address: null }, // not present in the export — open client question
      membership: {
        number: membershipNumber,
        since: str(get(mem, "membership_since")) ?? str(memberRow?.["membership_since"])?.slice(0, 10) ?? null,
        sector: str(get(mem, "membership_sector")) ?? str(memberRow?.["membership_sector"]),
      },
      certificate: {
        number: str(get(issued, "certificate_number")) ?? str(get(cell("current_certification_detail"), "certificate_number")),
        startDate: str(get(validity, "certificate_start_date")),
        endDate: str(get(validity, "certificate_end_date")),
        fileName: str(get(issued, "certificate", "name")),
        auditReportFileName: str(get(issued, "audit_report", "name")),
      },
      audit: {
        typeCode: str(row["audit_type_id"]),
        assessmentTypeCode: str(row["assessment_type_id"]),
        modeOfCertificationCode: str(row["mode_of_certification_id"]),
        closingMeetingDate: str(get(auditPlan, "closing_meeting_date")),
        leadAuditor: str(get(auditPlan, "lead_auditor", "name")),
        certificationBody: str(get(certificationBody, "name")),
      },
      centralOffice: get(centralOffice, "name") ? { name: str(get(centralOffice, "name")) } : null,
      groupManager: groupManager
        ? { name: str(get(groupManager, "name")), email: str(get(groupManager, "email")) }
        : null,
      managementUnits: managementUnitsRaw.slice(0, 500).map((mu) => ({
        id: str(get(mu, "prisma_management_unit_id")),
        name: str(get(mu, "name")) ?? "(unnamed)",
        address: joinAddress(get(mu, "address")),
        businessTypeCode: str(get(mu, "business_type")),
        tradingAccountId: str(get(mu, "trading_account", "prisma_trading_account_id")),
      })),
      sites,
      license: {
        licenseId: str(row["license_id"]),
        prismaLicenseId,
        startDate: null, // not confidently present in the export — never guessed
        endDate: null,
      },
      supplyChainModelsSummary: scmSet.size ? [...scmSet].sort().join("+") : null,
      outsourcingSummary: null,
      parseWarnings,
    };
    warnings.push(...parseWarnings.map((w) => `${appNo}: ${w}`));
  }

  return {
    applications,
    applicationNumbers: Object.keys(applications),
    warnings,
  };
}

function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
