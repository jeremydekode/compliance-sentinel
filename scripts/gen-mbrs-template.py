#!/usr/bin/env python3
"""Regenerate src/lib/mbrs-template.ts and src/lib/mbrs-narratives.ts from a
real SSM MBRS instance document.

    python3 scripts/gen-mbrs-template.py path/to/SSM_FS-MPERS_<reg>_<yyyymmdd>.xml

WHY THIS EXISTS
SSM's taxonomy package (.xsd + linkbases) is not vendored in this repo, so a
real filing produced by SSM's own MBRS Preparation Tool is the only
authoritative description of the required fact set we have. This script lifts
the skeleton — every context, unit, concept and structural zero — verbatim, and
binds only the facts that carry company data to canonical fields from
src/lib/mbrs.ts.

The generated template is checked by a round-trip: feeding the sample's own
figures back through src/lib/mbrs-xbrl.ts must reproduce the source file
fact-for-fact.

To support a new filing variant (FS-MFRS, a different taxonomy year), run this
against a sample of that variant and extend the mapping tables below.
"""
import json
import re
import sys
from xml.sax.saxutils import unescape as _unescape

SRC_DIR = "src/lib"

# Dates in the reference filing, replaced by tokens the generator resolves per
# company. {PPE} is the day before the previous period starts — the opening
# balance instant for the comparative statement of changes in equity.
DATES = {
    "20250630": "{CE}",
    "20240901": "{CS}",
    "20240831": "{PE}",
    "20230901": "{PS}",
    "20230831": "{PPE}",
}
ISO = {
    "2025-06-30": "{CE-}", "2024-09-01": "{CS-}",
    "2024-08-31": "{PE-}", "2023-09-01": "{PS-}", "2023-08-31": "{PPE-}",
}
ENTITY_ID = "202101011095"

# ── concept → canonical field ──────────────────────────────────────────────
SOFP = {
    "ifrs-smes:PropertyPlantAndEquipment": "propertyPlantAndEquipment",
    "ifrs-smes:OtherPropertyPlantAndEquipment": "propertyPlantAndEquipment",
    "ifrs-smes:NoncurrentAssets": "totalNoncurrentAssets",
    "ssmt-mpers:OtherCurrentReceivables": "otherReceivables",
    "ifrs-smes:TradeAndOtherCurrentReceivables": "otherReceivables",
    "ssmt-mpers:OtherCurrentReceivablesDueFromHoldingCompany": "receivablesDueFromHoldingCompany",
    "ssmt-mpers:OtherCurrentReceivablesDueFromRelatedParties": "receivablesDueFromHoldingCompany",
    "ifrs-smes:CashAndCashEquivalents": "cashAndCashEquivalents",
    "ifrs-smes:Cash": "cashAndCashEquivalents",
    "ifrs-smes:BalancesWithBanks": "cashAndCashEquivalents",
    "ssmt:CashAndBankBalances": "cashAndCashEquivalents",
    "ifrs-smes:CurrentAssets": "totalCurrentAssets",
    "ifrs-smes:Assets": "totalAssets",
    "ifrs-smes:IssuedCapital": "shareCapital",
    "ssmt-mpers:CapitalFromOrdinaryShares": "shareCapital",
    "ifrs-smes:RetainedEarnings": "retainedEarnings",
    "ifrs-smes:EquityAttributableToOwnersOfParent": "totalEquity",
    # WAS MISSING: plain ifrs-smes:Equity fell through to the reference
    # company's literal, filing IOT Foresight's RM15,322 as every company's
    # total equity.
    "ifrs-smes:Equity": "totalEquity",
    "ifrs-smes:InvestmentProperty": "investmentProperty",
    "ifrs-smes:InvestmentsInAssociates": "investmentsInAssociates",
    "ifrs-smes:Inventories": "inventories",
    "ifrs-smes:TradeAndOtherCurrentReceivablesToTradeCustomers": "tradeReceivables",
    "ifrs-smes:NoncurrentLiabilities": "totalNoncurrentLiabilities",
    "ifrs-smes:NoncurrentPortionOfNoncurrentBorrowings": "noncurrentBorrowings",
    "ifrs-smes:DeferredTaxLiabilities": "deferredTaxLiabilities",
    "ifrs-smes:CurrentBorrowings": "currentBorrowings",
    "ssmt-mpers:OtherCurrentTradePayables": "tradePayables",
    "ifrs-smes:TradeAndOtherCurrentPayablesToTradeSuppliers": "tradePayables",
    "ssmt-mpers:OtherCurrentPayables": "otherPayablesAndAccruals",
    # Subtotal BELOW the face amount: accruals + other non-trade payables,
    # i.e. the face amount less the holding-company balance.
    "ssmt-mpers:CurrentNontradePayables": "currentNontradePayables",
    "ssmt-mpers:CurrentNontradeAccruals": "accruals",
    "ssmt-mpers:OtherCurrentNontradePayables": "otherNontradePayables",
    "ssmt-mpers:OtherCurrentPayablesDueToHoldingCompany": "payablesDueToHoldingCompany",
    "ssmt-mpers:OtherCurrentPayablesDueToRelatedParties": "payablesDueToHoldingCompany",
    "ifrs-smes:CurrentTaxLiabilitiesCurrent": "currentTaxLiabilities",
    "ifrs-smes:CurrentLiabilities": "totalCurrentLiabilities",
    "ifrs-smes:Liabilities": "totalLiabilities",
    "ifrs-smes:EquityAndLiabilities": "totalEquityAndLiabilities",
}
PL = {
    "ifrs-smes:Revenue": "revenue",
    "ifrs-smes:RevenueFromRenderingOfServices": "revenue",
    "ssmt-mpers:RevenueFromRenderingOfOtherServices": "revenue",
    "ifrs-smes:GrossProfit": "grossProfit",
    "ifrs-smes:AdministrativeExpense": "administrativeExpenses",
    "ifrs-smes:OtherIncome": "otherIncome",
    "ifrs-smes:OtherOperatingExpense": "otherOperatingExpenses",
    "ifrs-smes:FinanceCosts": "financeCosts",
    "ifrs-smes:ProfitLossBeforeTax": "profitBeforeTax",
    "ssmt-mpers:AggregateProfitLossBeforeTax": "profitBeforeTax",
    "ssmt-mpers:ProfitLossFromOperatingActivities": "profitBeforeTax",
    "ifrs-smes:IncomeTaxExpenseContinuingOperations": "taxExpense",
    "ifrs-smes:ProfitLoss": "profitAfterTax",
    "ifrs-smes:ProfitLossFromContinuingOperations": "profitAfterTax",
    "ifrs-smes:ProfitLossAttributableToOwnersOfParent": "profitAfterTax",
    "ifrs-smes:ComprehensiveIncome": "profitAfterTax",
    "ifrs-smes:ComprehensiveIncomeAttributableToOwnersOfParent": "profitAfterTax",
}
CF = {
    "ssmt-mpers:AdjustmentsForDepreciationExpense": "depreciation",
    "ifrs-smes:AdjustmentsForDecreaseIncreaseInOtherOperatingReceivables": "cfChangeInReceivables",
    "ifrs-smes:AdjustmentsForIncreaseDecreaseInTradeAccountPayable": "cfChangeInTradePayables",
    "ifrs-smes:AdjustmentsForIncreaseDecreaseInOtherOperatingPayables": "cfChangeInOtherPayables",
    "ifrs-smes:AdjustmentsForReconcileProfitLoss": "cfTotalAdjustments",
    "ssmt-mpers:CashFlowsFromUsedInOperations": "cfFromOperations",
    "ifrs-smes:CashFlowsFromUsedInOperatingActivities": "cfFromOperatingActivities",
    "ifrs-smes:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities": "cfPurchaseOfPpe",
    "ifrs-smes:CashFlowsFromUsedInInvestingActivities": "cfFromInvestingActivities",
    "ifrs-smes:IncreaseDecreaseInCashAndCashEquivalents": "cfNetIncreaseInCash",
    "ifrs-smes:IncreaseDecreaseInCashAndCashEquivalentsBeforeEffectOfExchangeRateChanges": "cfNetIncreaseInCash",
}
DEI = {
    "ssmt-dei:NewCompanyRegistrationNumber": "registrationNumber",
    "ssmt-dei:CompanyRegistrationNumber": "oldRegistrationNumber",
    "ssmt-dei:NameOfReportingEntity": "entityName",
    "ssmt-dei:CompanyCurrentFinancialYearStartDate": "currentPeriodStart",
    "ssmt-dei:CompanyCurrentFinancialYearEndDate": "currentPeriodEnd",
    "ssmt-dei:CompanyPreviousFinancialYearStartDate": "previousPeriodStart",
    "ssmt-dei:CompanyPreviousFinancialYearEndDate": "previousPeriodEnd",
    "ssmt:NumberOfEmployees": "numberOfEmployees",
    "ssmt:TypeOfAuditorsOpinion": "auditorsOpinion",
    "ssmt:DateOfSigningAuditorsReport": "auditorReportDate",
    "ssmt:LicenseNumberOfAuditor": "auditorLicenseNumber",
    "ssmt:NameOfAuditorSigningReport": "auditorName",
    "ssmt:RegistrationNumberOfAuditFirm": "auditFirmRegistrationNumber",
    "ssmt:NameOfAuditFirm": "auditFirmName",
    "ssmt:AddressOne": "auditFirmAddress",
    "ssmt:PostcodeOfAuditFirm": "auditFirmPostcode",
    "ssmt:TownWhereAuditFirmIsLocated": "auditFirmTown",
    "ssmt:StateWhereAuditFirmIsLocated": "auditFirmState",
    "ssmt:NameOfFirstDirectorWhoSignedDirectorsReport": "director1Name",
    "ssmt:IdentificationNumberOfFirstDirectorWhoSignedDirectorsReport": "director1Id",
    "ssmt:NameOfSecondDirectorWhoSignedDirectorsReport": "director2Name",
    "ssmt:IdentificationNumberOfSecondDirectorWhoSignedDirectorsReport": "director2Id",
    "ssmt:NameOfFirstDirectorWhoSignedStatementByDirectors": "director1Name",
    "ssmt:IdentificationNumberOfFirstDirectorWhoSignedStatementByDirectors": "director1Id",
    "ssmt:NameOfSecondDirectorWhoSignedStatementByDirectors": "director2Name",
    "ssmt:IdentificationNumberOfSecondDirectorWhoSignedStatementByDirectors": "director2Id",
    "ssmt:DateOfSigningDirectorsReport": "directorsReportDate",
    "ssmt:DateOfSigningStatementByDirectors": "directorsReportDate",
    # These three carried the reference filing's literals (2027-12-31), while
    # the real dates sat extracted and unused.
    "ssmt:DateOfFinancialStatementsApprovedByBoardOfDirectors": "boardApprovalDate",
    "ssmt:DateOfStatutoryDeclaration": "statutoryDeclarationDate",
    "ssmt:DateOfCirculationOfFinancialStatementsAndReportsToMembers": "circulationDate",
}
# A company declares up to three business activities, each on its own
# NatureOfBusinessAxis member with its OWN MSIC code and description.
BUSINESS_SLOTS = {"BusinessOneMember": "1", "BusinessTwoMember": "2", "BusinessThreeMember": "3"}
# Statement-of-changes-in-equity columns. The grid is a breakdown of equity by
# component, NOT a restatement of the plain-context figure, so each column binds
# to its own field.
EQUITY_COMPONENTS = {
    "IssuedCapitalMember": "shareCapital",
    "RetainedEarningsMember": "retainedEarnings",
    # The "total" column of the grid.
    "EquityAttributableToOwnersOfParentMember": "totalEquity",
}
EQUITY_CONCEPTS = {"ifrs-smes:Equity"}

# Movement rows on the grid's total column. Profit attributable to owners is
# profit after tax for a company with no non-controlling interests, which is
# every FS-MPERS filer. ChangesInEquity and EquityBalanceRestated are
# deliberately NOT bound: the first also absorbs share issues and dividends,
# the second is an opening balance whose period is ambiguous in this context
# set — guessing either would put a wrong number back into the filing.
EQUITY_MOVEMENT_CONCEPTS = {
    "ifrs-smes:ProfitLoss": "profitAfterTax",
    "ifrs-smes:ComprehensiveIncome": "profitAfterTax",
}

BUSINESS_CONCEPTS = {
    "ssmt:MSICCode": "msicCode",
    "ssmt:DescriptionOfBusiness": "businessDescription",
}

FACT_RE = re.compile(
    r"<((?:ifrs-smes|ssmt|ssmt-mpers|ssmt-dei[\w-]*|ifrs-full)[:\w.-]+)([^>]*?)>(.*?)</\1>", re.S
)
PLAIN_CTX = re.compile(r"^(?:asof_\{\w+\}|fromto_\{\w+\}_\{\w+\})(?:_SeparateMember)?$")


def unesc(s):
    """XML text -> raw string. Everything downstream stores values unescaped;
    mbrs-xbrl.ts escapes exactly once on output."""
    return _unescape(s or "", {"&quot;": '"', "&apos;": "'"})


def tok(s, table):
    for k, v in table.items():
        s = s.replace(k, v)
    return s


def period_of(ctx):
    if not ctx:
        return None
    if "{CS}_{CE}" in ctx or re.search(r"asof_\{CE\}", ctx):
        return "current"
    if "{PS}_{PE}" in ctx or re.search(r"asof_\{PE\}", ctx):
        return "previous"
    return None


def resolve(concept, ctx):
    if concept in BUSINESS_CONCEPTS and ctx:
        for member, n in BUSINESS_SLOTS.items():
            if ctx.endswith("_" + member):
                return (f"{BUSINESS_CONCEPTS[concept]}{n}", None)
        return None
    if concept in DEI:
        return (DEI[concept], None)
    p = period_of(ctx)
    if p is None:
        return None
    if not PLAIN_CTX.match(ctx or ""):
        # SOCE equity columns: bind the component we can identify. Previously
        # every dimensional fact kept the reference company's literal, which is
        # how another entity's share capital and retained earnings ended up in
        # each filing.
        if concept in EQUITY_CONCEPTS:
            for member, field in EQUITY_COMPONENTS.items():
                if (ctx or "").endswith("_" + member):
                    return (field, p)
        if concept in EQUITY_MOVEMENT_CONCEPTS and (ctx or "").endswith(
            "_EquityAttributableToOwnersOfParentMember"
        ):
            return (EQUITY_MOVEMENT_CONCEPTS[concept], p)
        return None
    for table in (SOFP, PL, CF):
        if concept in table:
            return (table[concept], p)
    return None


def _nonzero_money(v):
    try:
        return float(str(v).replace(",", "")) != 0.0
    except ValueError:
        return False


def tsj(o):
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)


def main(path):
    raw = open(path, encoding="utf-8", errors="replace").read()

    contexts = {
        m.group(1): " ".join(m.group(2).split())
        for m in re.finditer(r'<xbrli:context id="([^"]+)">(.*?)</xbrli:context>', raw, re.S)
    }

    # Parse facts from the body with contexts and units removed, so typed-member
    # elements nested inside a context are never mistaken for top-level facts.
    body = re.sub(r"<xbrli:context .*?</xbrli:context>", "", raw, flags=re.S)
    body = re.sub(r"<xbrli:unit .*?</xbrli:unit>", "", body, flags=re.S)

    facts, bound, narrative, dropped = [], 0, 0, []
    for m in FACT_RE.finditer(body):
        name, attrs, val = m.group(1), m.group(2), m.group(3).strip()
        cm = re.search(r'contextRef="([^"]+)"', attrs)
        um = re.search(r'unitRef="([^"]+)"', attrs)
        dm = re.search(r'decimals="([^"]+)"', attrs)
        ctx = tok(cm.group(1), DATES) if cm else None

        entry = {"c": name}
        if ctx:
            entry["ctx"] = ctx
        if um:
            entry["u"] = um.group(1)
        if dm:
            entry["d"] = dm.group(1)

        # *Explanatory facts are the company's own narrative disclosures. They
        # must never carry a template default — that would publish the reference
        # company's directors' report into every other filing.
        if name.endswith("Explanatory"):
            entry["narrative"] = True
            narrative += 1
            facts.append(entry)
            continue

        r = resolve(name, ctx)
        if r:
            entry["field"] = r[0]
            if r[1]:
                entry["period"] = r[1]
            bound += 1
        else:
            literal = tok(unesc(val), {k: v for k, v in ISO.items()})
            # A monetary literal we could not bind is the REFERENCE COMPANY's
            # money. A structural zero is safe to reproduce; any other figure is
            # someone else's balance and must never be filed. Dropping it leaves
            # the fact absent, which the validator surfaces, instead of stating
            # a false amount.
            if entry.get("u") == "MYR" and _nonzero_money(literal):
                dropped.append(f"{name} ({literal})")
                continue
            entry["v"] = literal
        facts.append(entry)

    ctx_struct = {}
    for cid, cbody in contexts.items():
        b = tok(tok(cbody, DATES), ISO).replace(ENTITY_ID, "{ENTITY}")
        inst = re.search(r"<xbrli:instant>([^<]+)</xbrli:instant>", b)
        sd = re.search(r"<xbrli:startDate>([^<]+)</xbrli:startDate>", b)
        ed = re.search(r"<xbrli:endDate>([^<]+)</xbrli:endDate>", b)
        ex = re.findall(r'<xbrldi:explicitMember dimension="([^"]+)">([^<]+)</xbrldi:explicitMember>', b)
        ty = re.findall(
            r'<xbrldi:typedMember dimension="([^"]+)">\s*<([\w:.-]+)>([^<]*)</[\w:.-]+>\s*</xbrldi:typedMember>', b
        )
        e = {}
        if inst:
            e["i"] = inst.group(1)
        else:
            e["s"], e["e"] = sd.group(1), ed.group(1)
        if ex:
            e["dims"] = [[a, mm] for a, mm in ex]
        if ty:
            e["typed"] = [[a, el, v] for a, el, v in ty]
        ctx_struct[tok(cid, DATES)] = e

    header = f'''// AUTO-DERIVED from a real SSM MBRS Preparation Tool instance document
// (FS-MPERS, taxonomy SSMxT_2022v1.0). Do not hand-edit — regenerate with:
//   python3 scripts/gen-mbrs-template.py <sample-filing.xml>
//
// WHY A TEMPLATE AND NOT A TAXONOMY ENGINE: SSM's taxonomy package (.xsd +
// linkbases) is not vendored here, so a real sample instance is the only
// authoritative description of the required fact set we have. The context set,
// unit set, concept ordering and the structural zeros are reproduced verbatim;
// facts carrying company data are bound to canonical fields instead. Replacing
// this module with a taxonomy-driven mapper is the intended upgrade path and
// touches nothing outside this file.
//
// All values are UNESCAPED. mbrs-xbrl.ts escapes exactly once on output.
//
// Date tokens, resolved at generation time:
//   {{CS}}/{{CE}}    current period start / end     (yyyymmdd form, used in ids)
//   {{PS}}/{{PE}}    previous period start / end
//   {{PPE}}        day before previous start - the opening SOCE balance instant
//   {{CS-}} etc.   the same dates in ISO yyyy-mm-dd form, used in context bodies
//   {{ENTITY}}     company registration number

export interface TemplateFact {{
  /** Qualified XBRL concept, e.g. "ifrs-smes:Assets". */
  c: string;
  /** Tokenised context id; absent for context-free facts. */
  ctx?: string;
  /** Unit ref: MYR | PURE | share. */
  u?: string;
  /** XBRL decimals attribute. */
  d?: string;
  /** Literal value - structural zeros, fixed enumerations, tokenised dates. */
  v?: string;
  /** Canonical extraction field this fact is filled from. */
  field?: string;
  /** Which reporting period `field` is read from. */
  period?: "current" | "previous";
  /** Filled from the extracted narratives map, keyed by `c`. */
  narrative?: boolean;
}}

export interface TemplateContext {{
  /** Instant date token (point-in-time context). */
  i?: string;
  /** Duration start / end date tokens. */
  s?: string;
  e?: string;
  /** Explicit dimension members: [axis, member][]. */
  dims?: [string, string][];
  /** Typed dimension members: [axis, element, value][]. */
  typed?: [string, string, string][];
}}

'''
    out = header + "export const TEMPLATE_FACTS: TemplateFact[] = [\n"
    for f in facts:
        out += "  " + tsj(f) + ",\n"
    out += "];\n\nexport const TEMPLATE_CONTEXTS: Record<string, TemplateContext> = {\n"
    for k, v in ctx_struct.items():
        out += f"  {tsj(k)}: {tsj(v)},\n"
    out += "};\n"
    open(f"{SRC_DIR}/mbrs-template.ts", "w").write(out)

    narr = []
    for f in facts:
        if f.get("narrative") and f["c"] not in narr:
            narr.append(f["c"])
    narr_out = (
        "// AUTO-DERIVED alongside mbrs-template.ts — regenerate with the same script.\n"
        "//\n"
        "// Split out of the template deliberately: the canonical model needs this list\n"
        "// and is imported by the review page, so keeping it here stops the ~120KB fact\n"
        "// template from being pulled into the client bundle.\n\n"
        "/** XBRL concepts that carry company narrative prose (…Explanatory). */\n"
        "export const NARRATIVE_CONCEPTS: string[] = [\n"
        + "".join(f"  {tsj(c)},\n" for c in narr)
        + "];\n"
    )
    open(f"{SRC_DIR}/mbrs-narratives.ts", "w").write(narr_out)

    print(f"facts {len(facts)} (bound {bound}, narrative {narrative}, "
          f"literal {len(facts)-bound-narrative}) | contexts {len(ctx_struct)}")
    if dropped:
        print(f"dropped {len(dropped)} unbindable monetary literals "
              f"(reference company's figures, not ours):")
        for d in dropped[:12]:
            print(f"   - {d}")
    print(f"wrote {SRC_DIR}/mbrs-template.ts ({len(out)} bytes)")
    print(f"wrote {SRC_DIR}/mbrs-narratives.ts ({len(narr)} concepts)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
