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
from datetime import date, timedelta
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
    "ifrs-smes:NoncurrentAssets": "totalNoncurrentAssets",
    "ssmt-mpers:OtherCurrentReceivables": "otherReceivablesInclRelated",
    "ssmt-mpers:OtherCurrentReceivablesDueFromHoldingCompany": "receivablesDueFromHoldingCompany",
    "ssmt-mpers:OtherCurrentReceivablesDueFromRelatedParties": "receivablesDueFromRelatedParties",
    "ifrs-smes:AmountsReceivableRelatedPartyTransactions": "receivablesDueFromRelatedParties",
    "ifrs-smes:AmountsPayableRelatedPartyTransactions": "payablesDueToRelatedParties",
    "ifrs-smes:Buildings": "buildings",
    "ssmt-mpers:OfficeEquipmentFixtureAndFittings": "officeEquipment",
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
    # The SOCE "total" column on a plain context: opening balance is last
    # year's closing equity, and the movement row is the derived roll-forward.
    "ssmt-mpers:EquityBalanceRestated": "totalEquity",
    "ifrs-smes:ChangesInEquity": "equityMovementTotal",
    # Face-of-statement receivables total, i.e. trade + other.
    "ifrs-smes:TradeAndOtherCurrentReceivables": "totalReceivables",
    "ifrs-smes:InvestmentProperty": "investmentProperty",
    "ifrs-smes:InvestmentsInAssociates": "investmentsInAssociates",
    "ifrs-smes:Inventories": "inventories",
    # Real concept names, learned from the multi-donor literal diff — the
    # ifrs-smes spellings guessed earlier never appear in an actual filing.
    "ssmt-mpers:CurrentTradeReceivables": "tradeReceivables",
    "ssmt-mpers:OtherCurrentTradeReceivables": "tradeReceivables",
    "ssmt-mpers:OtherCurrentNontradeReceivables": "otherReceivables",
    "ssmt-mpers:OtherCurrentPrepaymentsAndCurrentAccruedIncome": "prepayments",
    "ssmt-mpers:OtherCurrentNontradeDeposits": "deposits",
    "ssmt-mpers:OtherCurrentReceivablesDueFromOtherRelatedParties": "receivablesDueFromRelatedParties",
    "ssmt-mpers:NoncurrentPortionOfNoncurrentSecuredBankLoansReceived": "noncurrentBorrowings",
    "ifrs-smes:TradeAndOtherCurrentPayables": "totalPayables",
    "ssmt-mpers:NoncurrentBorrowings": "noncurrentBorrowings",
    "ifrs-smes:ShorttermBorrowings": "currentBorrowings",
    "ssmt-mpers:AmountOfSharesIssuedAndFullyPaidOutstanding": "shareCapital",
    "ifrs-smes:NumberOfSharesIssuedAndFullyPaid": "numberOfShares",
    "ifrs-smes:TradeAndOtherCurrentReceivablesToTradeCustomers": "tradeReceivables",
    "ifrs-smes:NoncurrentLiabilities": "totalNoncurrentLiabilities",
    "ifrs-smes:NoncurrentPortionOfNoncurrentBorrowings": "noncurrentBorrowings",
    "ifrs-smes:DeferredTaxLiabilities": "deferredTaxLiabilities",
    "ifrs-smes:CurrentBorrowings": "currentBorrowings",
    "ssmt-mpers:OtherCurrentTradePayables": "tradePayables",
    "ifrs-smes:TradeAndOtherCurrentPayablesToTradeSuppliers": "tradePayables",
    "ssmt-mpers:OtherCurrentPayables": "otherPayablesInclRelated",
    # Subtotal BELOW the face amount: accruals + other non-trade payables,
    # i.e. the face amount less the holding-company balance.
    "ssmt-mpers:CurrentNontradePayables": "currentNontradePayables",
    "ssmt-mpers:CurrentNontradeAccruals": "accruals",
    "ssmt-mpers:OtherCurrentNontradePayables": "otherNontradePayables",
    "ssmt-mpers:OtherCurrentPayablesDueToHoldingCompany": "payablesDueToHoldingCompany",
    "ssmt-mpers:OtherCurrentPayablesDueToRelatedParties": "payablesDueToRelatedParties",
    "ifrs-smes:CurrentTaxLiabilitiesCurrent": "currentTaxLiabilities",
    "ifrs-smes:CurrentLiabilities": "totalCurrentLiabilities",
    "ifrs-smes:Liabilities": "totalLiabilities",
    "ifrs-smes:EquityAndLiabilities": "totalEquityAndLiabilities",
}
PL = {
    "ifrs-smes:Revenue": "revenue",
    # Split by nature. Binding both to one "revenue" field emitted the full
    # amount twice; every filing reports one and zero for the other.
    "ifrs-smes:RevenueFromRenderingOfServices": "revenueFromServices",
    "ssmt-mpers:RevenueFromRenderingOfOtherServices": "revenueFromServices",
    "ifrs-smes:RevenueFromSaleOfGoods": "revenueFromGoods",
    "ssmt-mpers:RevenueFromSaleOfOtherGoods": "revenueFromGoods",
    "ifrs-smes:GrossProfit": "grossProfit",
    "ifrs-smes:AdministrativeExpense": "administrativeExpenses",
    "ifrs-smes:OtherIncome": "otherIncome",
    "ifrs-smes:OtherOperatingExpense": "otherOperatingExpenses",
    "ifrs-smes:OtherExpenseByFunction": "otherOperatingExpenses",
    "ifrs-smes:CostOfSales": "costOfSales",
    "ssmt-mpers:OtherCostOfSales": "costOfSales",
    "ifrs-smes:CostOfInventories": "costOfSales",
    "ifrs-smes:FinanceCosts": "financeCosts",
    "ifrs-smes:KeyManagementPersonnelCompensation": "keyManagementCompensation",
    "ssmt-mpers:AuditorsRemuneration": "auditorsRemuneration",
    "ssmt-mpers:DividendIncomeRelatedPartyTransactions": "relatedPartyDividendIncome",
    "ssmt-mpers:RentalExpensesRelatedPartyTransactions": "relatedPartyRentalExpense",
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
    "ifrs-smes:AdjustmentsForDecreaseIncreaseInTradeAccountReceivable": "cfChangeInTradeReceivables",
    "ifrs-smes:AdjustmentsForIncreaseDecreaseInTradeAccountPayable": "cfChangeInTradePayables",
    "ifrs-smes:AdjustmentsForIncreaseDecreaseInOtherOperatingPayables": "cfChangeInOtherPayables",
    "ifrs-smes:AdjustmentsForReconcileProfitLoss": "cfTotalAdjustments",
    "ssmt-mpers:CashFlowsFromUsedInOperations": "cfFromOperations",
    "ifrs-smes:CashFlowsFromUsedInOperatingActivities": "cfFromOperatingActivities",
    "ifrs-smes:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities": "cfPurchaseOfPpe",
    "ifrs-smes:CashFlowsFromUsedInInvestingActivities": "cfFromInvestingActivities",
    "ifrs-smes:CashFlowsFromUsedInFinancingActivities": "cfFromFinancingActivities",
    "ifrs-smes:IncomeTaxesPaidRefundClassifiedAsOperatingActivities": "incomeTaxPaid",
    # add-back of finance costs in the operating reconciliation = the P&L line
    "ifrs-smes:AdjustmentsForFinanceCosts": "financeCosts",
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
    "ssmt:DisclosureOfStatusOfDividend": "dividendStatus",
    "ssmt:BasisOfAccountingStandardsAppliedToPrepareFinancialStatements": "basisOfAccounting",
    "ssmt:DisclosureOfFinancialStatementsAuditStatus": "auditStatus",
    "ssmt:DisclosureOfDirectorsReceivedOrBecomeEntitledToReceiveOtherBenefitsByReasonOfContractMadeByCompanyOrRelatedCorporation": "directorsOtherBenefits",
    "ssmt:DisclosureOfContingentOrOtherLiabilityBeingEnforceableWithinTwelveMonthsAfterEndOfFinancialYear": "contingentLiabilityEnforceable",
    "ssmt:DisclosureOfOccurenceOfAnySubstantialMaterialOrUnusualInNatureItemsTransactionsOrEvents": "materialUnusualEvents",
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
    "ssmt:NumberOfDirectorsSigningDirectorsReport": "numberOfDirectorsSigning",
    "ssmt:NumberOfDirectorsSigningStatementByDirectors": "numberOfDirectorsSigning",
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
# Both carry a per-component equity balance; EquityBalanceRestated is the
# opening column, ifrs-smes:Equity the closing one.
EQUITY_CONCEPTS = {"ifrs-smes:Equity", "ssmt-mpers:EquityBalanceRestated"}
# At the {PPE} instant the same concepts mean the OPENING balance of the
# comparative year, which lives under separate keys in the previous bag.
OPENING_COMPONENTS = {
    "IssuedCapitalMember": "openingShareCapital",
    "RetainedEarningsMember": "openingRetainedEarnings",
    "EquityAttributableToOwnersOfParentMember": "openingTotalEquity",
}

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
# The profit row lands in retained earnings, so both the total column and the
# retained-earnings column carry profit after tax.
EQUITY_MOVEMENT_MEMBERS = ("EquityAttributableToOwnersOfParentMember", "RetainedEarningsMember")

# The "total movement" row: closing minus opening per component, derived in
# mbrs.ts. Never equal to profit when a dividend or share issue occurred.
EQUITY_CHANGE_FIELDS = {
    "IssuedCapitalMember": "equityMovementShareCapital",
    "RetainedEarningsMember": "equityMovementRetainedEarnings",
    "EquityAttributableToOwnersOfParentMember": "equityMovementTotal",
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
    # The instant before the comparative year opens: the SOCE's earliest
    # balance row. Belongs to the previous bag under its opening* keys.
    if re.search(r"asof_\{PPE\}", ctx):
        return "opening"
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
    if p == "opening":
        if concept not in EQUITY_CONCEPTS:
            return None
        if PLAIN_CTX.match(ctx or ""):
            return ("openingTotalEquity", "previous")
        for member, field in OPENING_COMPONENTS.items():
            if (ctx or "").endswith("_" + member):
                return (field, "previous")
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
        if concept in EQUITY_MOVEMENT_CONCEPTS:
            for member in EQUITY_MOVEMENT_MEMBERS:
                if (ctx or "").endswith("_" + member):
                    return (EQUITY_MOVEMENT_CONCEPTS[concept], p)
        if concept == "ifrs-smes:ChangesInEquity":
            for member, field in EQUITY_CHANGE_FIELDS.items():
                if (ctx or "").endswith("_" + member):
                    return (field, p)
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


def derive_maps(raw):
    """Per-sample date/entity tokens, read from the filing itself rather than
    hardcoded, so any accepted filing can serve as a donor."""
    def dei(tag):
        m = re.search(rf"<ssmt-dei:{tag}[^>]*>([^<]+)<", raw)
        return m.group(1).strip() if m else None

    cs, ce = dei("CompanyCurrentFinancialYearStartDate"), dei("CompanyCurrentFinancialYearEndDate")
    ps, pe = dei("CompanyPreviousFinancialYearStartDate"), dei("CompanyPreviousFinancialYearEndDate")
    ent = re.search(r"<xbrli:identifier[^>]*>([^<]+)</xbrli:identifier>", raw).group(1).strip()
    if not all([cs, ce, ps, pe]):
        raise SystemExit("sample is missing the ssmt-dei period dates")
    ppe = (date.fromisoformat(ps) - timedelta(days=1)).isoformat()
    iso = {ce: "{CE-}", cs: "{CS-}", pe: "{PE-}", ps: "{PS-}", ppe: "{PPE-}"}
    dates = {k.replace("-", ""): v.replace("-}", "}") for k, v in iso.items()}
    return dates, iso, ent


def parse_sample(path):
    """One donor -> {(concept, ctx): entry} plus its context structures."""
    global ISO
    raw = open(path, encoding="utf-8", errors="replace").read()
    dates, iso, ent = derive_maps(raw)
    ISO = iso  # resolve() and the literal tokeniser read the module-level map

    contexts = {
        m.group(1): " ".join(m.group(2).split())
        for m in re.finditer(r'<xbrli:context id="([^"]+)">(.*?)</xbrli:context>', raw, re.S)
    }
    body = re.sub(r"<xbrli:context .*?</xbrli:context>", "", raw, flags=re.S)
    body = re.sub(r"<xbrli:unit .*?</xbrli:unit>", "", body, flags=re.S)

    out, order = {}, []
    for m in FACT_RE.finditer(body):
        name, attrs, val = m.group(1), m.group(2), m.group(3).strip()
        cm = re.search(r'contextRef="([^"]+)"', attrs)
        um = re.search(r'unitRef="([^"]+)"', attrs)
        dm = re.search(r'decimals="([^"]+)"', attrs)
        ctx = tok(cm.group(1), dates) if cm else None

        entry = {"c": name}
        if ctx:
            entry["ctx"] = ctx
        if um:
            entry["u"] = um.group(1)
        if dm:
            entry["d"] = dm.group(1)

        if name.endswith("Explanatory") or name.split(":")[-1].startswith(
            "DescriptionOfAccountingPolicy"
        ):
            entry["narrative"] = True
        else:
            r = resolve(name, ctx)
            if r:
                entry["field"] = r[0]
                if r[1]:
                    entry["period"] = r[1]
            else:
                entry["v"] = tok(unesc(val), iso)

        key = (name, ctx)
        if key not in out:
            out[key] = entry
            order.append(key)

    ctx_struct = {}
    for cid, cbody in contexts.items():
        b = tok(tok(cbody, dates), iso).replace(ent, "{ENTITY}")
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
        ctx_struct[tok(cid, dates)] = e

    return out, order, ctx_struct


def main(*paths):
    merged, order, ctx_struct = {}, [], {}
    seen_literal = {}   # key -> set of literal values across donors

    for path in paths:
        sample, sample_order, sctx = parse_sample(path)
        for key in sample_order:
            e = sample[key]
            if "v" in e:
                seen_literal.setdefault(key, set()).add(e["v"])
            if key not in merged:
                merged[key] = e
                order.append(key)
            elif "field" in e and "field" not in merged[key]:
                merged[key] = e     # a later donor let us bind what an earlier one could not
        ctx_struct.update(sctx)

    facts, bound, narrative, dropped, varying = [], 0, 0, [], []
    for key in order:
        e = merged[key]
        name = e["c"]
        if e.get("narrative"):
            narrative += 1
            facts.append(e)
            continue
        if "field" in e:
            bound += 1
            facts.append(e)
            continue

        lits = seen_literal.get(key, set())
        # A literal that DIFFERS between donors is company data, not a constant.
        # Emitting either one publishes one company's answer into every other
        # filing - exactly the defect this generator shipped before. Drop it and
        # let the fact be absent.
        if len(lits) > 1:
            varying.append(f"{name} ({' | '.join(sorted(lits))[:70]})")
            continue
        # Single-donor monetary literals are still that donor's money unless
        # they are a structural zero.
        if e.get("u") == "MYR" and _nonzero_money(e.get("v", "")):
            dropped.append(f"{name} ({e['v']})")
            continue
        facts.append(e)

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
        print(f"dropped {len(dropped)} unbindable monetary literals (donor's money)")
    if varying:
        print(f"dropped {len(varying)} literals that DIFFER between donors "
              f"(company data, not constants):")
        for d in varying[:80]:
            print(f"   - {d}")
    print(f"wrote {SRC_DIR}/mbrs-template.ts ({len(out)} bytes)")
    print(f"wrote {SRC_DIR}/mbrs-narratives.ts ({len(narr)} concepts)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(*sys.argv[1:])
