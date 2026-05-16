// Deterministic mock dataset keyed by uploaded filename.
export type ImpactLevel = "high" | "medium" | "low";
export type ChangeType =
  | "find_replace"
  | "insertion"
  | "full_rewrite"
  | "new_section"
  | "contextual";

export type DiffSource = "document" | "kb" | "new";

export interface MockChange {
  chapter_ref: string;
  old_requirement: string;
  new_requirement: string;
  change_summary: string;
  impact: ImpactLevel;
  tone_shift: string;
  pages?: string;
  legal_refs?: string[];
  related_instruments?: string[];
  diff_source?: DiffSource;
  compared_against?: string[];
}

export interface MockImpact {
  sop_title: string;
  change_type: ChangeType;
  page: number;
  line_range: string;
  paragraph: string;
  chapter: string;
  warning?: string;
  find_text?: string;
  replace_text?: string;
}

export interface MockDataset {
  policy_name: string;
  title: string;
  summary: {
    executive: string;
    effective_date: string;
    before_count: number;
    after_count: number;
    immediate_actions: string[];
    structural: { added: string[]; renamed: string[]; restructured: string[] };
    timeline: { phase: string; window: string; focus: string; bullets: string[] }[];
  };
  changes: MockChange[];
  impacts: MockImpact[];
}

const BNM_RMIT: MockDataset = {
  policy_name: "BNM RMiT 2024",
  title: "BNM Risk Management in Technology (RMiT) — 2024 Update",
  summary: {
    executive:
      "The 2024 RMiT update tightens cyber resilience, third-party governance, and cloud controls. **27 chapters** revised, with the largest impact on incident reporting timelines and outsourcing notification thresholds.",
    effective_date: "1 January 2025",
    before_count: 124,
    after_count: 151,
    immediate_actions: [
      "Reduce major incident reporting window from 24h to 6h",
      "Update outsourcing notification threshold to RM 5M aggregate",
      "Adopt mandatory kill-switch capability for critical online services",
    ],
    structural: {
      added: ["Ch. 11.5 Kill-Switch Capability", "Appendix F: Cloud Exit Strategy"],
      renamed: ["Ch. 7 — now 'Cyber Resilience' (was 'Cyber Security')"],
      restructured: ["Ch. 10 Outsourcing split into 10A (Material) and 10B (Non-Material)"],
    },
    timeline: [
      {
        phase: "Phase 1 (0–30 days)",
        window: "Q1 2025",
        focus: "Stand up the foundations: ratify the updated policy stack, redraft incident-response SOPs to the new 6-hour clock, and brief the Board and Risk Committees so leadership owns the timeline before regulator scrutiny begins.",
        bullets: [
          "Issue revised Cyber Resilience & Incident Response SOP with 6-hour reporting clock and 14-day RCA template.",
          "Convene Board Risk Committee to ratify RMiT 2024 alignment plan and resourcing.",
          "Notify BNM relationship manager of project plan, owners, and milestone dates.",
          "Update incident triage runbooks and on-call rosters to meet the new escalation SLA.",
        ],
      },
      {
        phase: "Phase 2 (30–90 days)",
        window: "Q2 2025",
        focus: "Operationalise the new mandates: re-paper material vendors against the RM 5M aggregate threshold, build the kill-switch capability end-to-end, and run the first DR cycle that proves the tightened RTOs.",
        bullets: [
          "Re-baseline outsourcing register; flag aggregated arrangements crossing RM 5M for BNM notification.",
          "Implement and tabletop the kill-switch runbook for tier-0 online services (≤15 min isolation).",
          "Roll out PAM session recording on tier-0 systems and shift privileged-access reviews to semi-annual.",
          "Run a live failover for critical systems against the new 2-hour RTO and document lessons learned.",
        ],
      },
      {
        phase: "Phase 3 (90–180 days)",
        window: "Q3 2025",
        focus: "Close the loop and prove sustained compliance: validate cloud exit playbooks, complete the internal audit, and prepare BNM attestation evidence so the new posture is defensible end-to-end.",
        bullets: [
          "Validate Cloud Exit Strategy (Appendix F) for each material cloud workload and sign off annually.",
          "Internal Audit walkthrough across Ch. 5, 7, 8, 10A, 11.5, 12 and 14 with findings tracker.",
          "Compile BNM attestation pack: control evidence, drill outcomes, KRI dashboard, residual-risk register.",
          "Embed quarterly Board Technology Risk Report with cyber posture KRIs and unresolved-finding heatmap.",
        ],
      },
    ],
  },
  changes: [
    {
      chapter_ref: "Ch. 7 Cyber Resilience",
      old_requirement: "FIs must report major cyber incidents to BNM within 24 hours of detection.",
      new_requirement: "FIs must report major cyber incidents to BNM within **6 hours** of detection, with a follow-up RCA within 14 days.",
      change_summary: "Tightened reporting window and added mandatory RCA deliverable.",
      impact: "high",
      tone_shift: "Prescriptive → Time-bound mandate",
      pages: "pp. 42–47",
      legal_refs: ["FSA 2013 s.143(2)", "IFSA 2013 s.155(2)"],
      related_instruments: ["BNM Operational Risk Policy 2022", "BNM Incident Reporting Circular 03/2023"],
    },
    {
      chapter_ref: "Ch. 10A Material Outsourcing",
      old_requirement: "Notify BNM of material outsourcing arrangements above RM 10M.",
      new_requirement: "Notify BNM of any **aggregate** outsourcing arrangement above **RM 5M** to a single provider, including intra-group.",
      change_summary: "Lowered threshold and aggregated by provider including intra-group exposure.",
      impact: "high",
      tone_shift: "Per-contract → Aggregate exposure",
      pages: "pp. 58–66",
      legal_refs: ["FSA 2013 s.47(1)", "BNM/RH/PD 028-99"],
      related_instruments: ["BNM Outsourcing Policy 2019", "BNM Group-wide Risk Policy 2021"],
    },
    {
      chapter_ref: "Ch. 11.5 Kill-Switch",
      old_requirement: "(new section)",
      new_requirement: "FIs must implement a **kill-switch** capability allowing isolation of critical online services within 15 minutes.",
      change_summary: "New mandatory capability with tested runbook and quarterly drills.",
      impact: "high",
      tone_shift: "N/A → New mandate",
      pages: "pp. 71–74",
      legal_refs: ["FSA 2013 s.143(1)"],
      related_instruments: ["BNM Cyber Resilience Guideline 2020", "MAS TRMG (cross-reference)"],
      diff_source: "new",
      compared_against: [],
    },
    {
      chapter_ref: "Ch. 12 Cloud Services",
      old_requirement: "Cloud adoption requires a documented risk assessment.",
      new_requirement: "Cloud adoption requires a documented risk assessment **and an exit strategy** validated annually.",
      change_summary: "Added exit-strategy obligation and annual validation.",
      impact: "medium",
      tone_shift: "Recommended → Required",
      pages: "pp. 80–88, App. F",
      legal_refs: ["FSA 2013 s.47", "PDPA 2010 s.39"],
      related_instruments: ["BNM Cloud Risk Advisory 2021", "BNM Outsourcing Policy 2019"],
      diff_source: "kb",
      compared_against: ["Cloud Services Governance SOP v2.1", "BNM Cloud Risk Advisory 2021"],
    },
    {
      chapter_ref: "Ch. 8 Access Control",
      old_requirement: "Privileged access reviews shall be performed at least annually.",
      new_requirement: "Privileged access reviews shall be performed at least **semi-annually**, with PAM session recording for tier-0 systems.",
      change_summary: "Increased review cadence and added session recording.",
      impact: "medium",
      tone_shift: "Annual → Semi-annual + recording",
      pages: "pp. 51–55",
      legal_refs: ["FSA 2013 s.143(1)"],
      related_instruments: ["BNM IT Security Guideline 2018"],
    },
    {
      chapter_ref: "Ch. 14 BCM",
      old_requirement: "Critical systems RTO of 4 hours.",
      new_requirement: "Critical systems RTO of **2 hours**, validated by live failover at least once per year.",
      change_summary: "Tightened RTO and added live failover requirement.",
      impact: "medium",
      tone_shift: "Tabletop → Live failover",
      pages: "pp. 92–97",
      legal_refs: ["FSA 2013 s.47(2)"],
      related_instruments: ["BNM BCM Policy 2011 (revised 2019)"],
    },
    {
      chapter_ref: "Ch. 5 Governance",
      old_requirement: "Board to receive technology risk reports semi-annually.",
      new_requirement: "Board to receive technology risk reports **quarterly**, including cyber posture KRIs.",
      change_summary: "Increased reporting cadence with KRI dashboard.",
      impact: "low",
      tone_shift: "Semi-annual → Quarterly",
      pages: "pp. 30–34",
      legal_refs: ["FSA 2013 s.56", "Companies Act 2016 s.211"],
      related_instruments: ["BNM Corporate Governance Policy 2016"],
    },
  ],
  impacts: [
    {
      sop_title: "Cyber Resilience & Incident Response SOP",
      change_type: "find_replace",
      page: 14,
      line_range: "210–214",
      paragraph: "§4.2.1 Reporting Obligations",
      chapter: "Ch. 7 Cyber Resilience",
      find_text:
        "Major cyber incidents shall be reported to Bank Negara Malaysia within twenty-four (24) hours of detection by the Incident Response Lead.",
      replace_text:
        "Major cyber incidents shall be reported to Bank Negara Malaysia within **six (6) hours** of detection by the Incident Response Lead, followed by a Root Cause Analysis report within fourteen (14) calendar days.",
    },
    {
      sop_title: "Third-Party / Vendor Risk Management SOP",
      change_type: "full_rewrite",
      page: 8,
      line_range: "98–140",
      paragraph: "§3.1 BNM Notification Threshold",
      chapter: "Ch. 10A Material Outsourcing",
      warning:
        "Manual review required: legal counsel to confirm aggregation methodology for intra-group arrangements before publishing.",
      find_text:
        "Outsourcing arrangements with a contract value exceeding RM 10,000,000 to a single service provider shall trigger BNM notification under the Outsourcing Policy 2019.",
      replace_text:
        "Outsourcing arrangements whose **aggregate** annualised contract value to a single service provider (including intra-group entities) exceeds **RM 5,000,000** shall trigger BNM notification under BNM RMiT Ch. 10A. Aggregation is computed across all active SOWs and renewals over a rolling 12-month window.",
    },
    {
      sop_title: "Cyber Resilience & Incident Response SOP",
      change_type: "new_section",
      page: 22,
      line_range: "after 401",
      paragraph: "(new) §6.5 Kill-Switch Procedure",
      chapter: "Ch. 11.5 Kill-Switch",
      replace_text:
        "**§6.5 Kill-Switch Procedure**\n\nThe Head of Cyber Operations shall maintain a documented kill-switch runbook capable of isolating any critical online service within fifteen (15) minutes of authorisation. Quarterly drills shall be conducted with results submitted to the Technology Risk Committee.",
    },
    {
      sop_title: "Cloud Services Governance SOP",
      change_type: "insertion",
      page: 11,
      line_range: "172",
      paragraph: "§5.3 Cloud Adoption Gate",
      chapter: "Ch. 12 Cloud Services",
      find_text: "A risk assessment shall be approved by the Cloud Steering Committee prior to onboarding.",
      replace_text:
        "A risk assessment **and a documented Exit Strategy (Appendix F)** shall be approved by the Cloud Steering Committee prior to onboarding. The Exit Strategy shall be validated annually by Cloud Operations.",
    },
    {
      sop_title: "Access Control & Privileged Access SOP",
      change_type: "find_replace",
      page: 6,
      line_range: "84–86",
      paragraph: "§2.4 Privileged Access Reviews",
      chapter: "Ch. 8 Access Control",
      find_text: "Privileged access entitlements shall be reviewed by system owners on an annual basis.",
      replace_text:
        "Privileged access entitlements shall be reviewed by system owners on a **semi-annual** basis. For tier-0 systems, **PAM session recording** shall be enabled and retained for 365 days.",
    },
    {
      sop_title: "Business Continuity Management SOP",
      change_type: "find_replace",
      page: 19,
      line_range: "260–262",
      paragraph: "§7.1 Recovery Time Objectives",
      chapter: "Ch. 14 BCM",
      find_text: "Critical systems shall maintain a Recovery Time Objective (RTO) of four (4) hours.",
      replace_text:
        "Critical systems shall maintain a Recovery Time Objective (RTO) of **two (2) hours**, validated by **live failover testing** at least once per calendar year.",
    },
    {
      sop_title: "Technology Risk Management Framework",
      change_type: "contextual",
      page: 4,
      line_range: "52–54",
      paragraph: "§1.5 Board Reporting",
      chapter: "Ch. 5 Governance",
      find_text: "The Board shall receive a Technology Risk Report on a semi-annual basis.",
      replace_text:
        "The Board shall receive a Technology Risk Report on a **quarterly** basis, incorporating cyber posture KRIs and a heatmap of unresolved high-impact findings.",
    },
  ],
};

const FATF_AML: MockDataset = {
  policy_name: "FATF AML/CFT Update 2024",
  title: "FATF AML/CFT Recommendations — 2024 Update",
  summary: {
    executive:
      "Tightened beneficial-ownership transparency, enhanced PEP screening, and lowered crypto-asset (VASP) reporting thresholds. **18 recommendations** revised.",
    effective_date: "1 March 2025",
    before_count: 80,
    after_count: 92,
    immediate_actions: [
      "Lower suspicious-transaction reporting threshold and update STR templates",
      "Re-screen entire customer book against expanded PEP / sanctions lists",
      "Apply travel-rule controls to virtual-asset transfers ≥ USD 1,000",
    ],
    structural: {
      added: ["Rec. 16A Travel Rule for VASPs", "Annex C Beneficial Ownership Register"],
      renamed: ["Rec. 12 — now 'Politically Exposed Persons (Domestic & Foreign)'"],
      restructured: ["Rec. 10 CDD split into 10A (Standard) and 10B (Enhanced)"],
    },
    timeline: [
      {
        phase: "Phase 1 (0–30 days)",
        window: "Q1 2025",
        focus: "Refresh AML governance: update STR thresholds, retrain front-line staff, and brief the AMLCO and Board on the new posture.",
        bullets: [
          "Re-issue STR / SAR templates with the lowered threshold and new typologies.",
          "Run mandatory PEP / sanctions retraining for relationship managers.",
          "Brief the Board AML Committee on FATF 2024 alignment plan.",
        ],
      },
      {
        phase: "Phase 2 (30–90 days)",
        window: "Q2 2025",
        focus: "Operationalise the controls: re-screen the customer book, deploy the travel-rule integration, and launch the beneficial-ownership register.",
        bullets: [
          "Bulk re-screen all customers against expanded PEP / sanctions lists.",
          "Integrate VASP travel-rule messaging on all in-/out-bound transfers ≥ USD 1,000.",
          "Stand up the beneficial-ownership register and back-fill top-200 clients.",
        ],
      },
      {
        phase: "Phase 3 (90–180 days)",
        window: "Q3 2025",
        focus: "Validate end-to-end: independent AML audit, regulator attestation, and quarterly KRI reporting.",
        bullets: [
          "Independent AML audit covering Rec. 10A/10B, 12, 16A and Annex C.",
          "Compile regulator attestation pack and submit on schedule.",
          "Embed quarterly AML KRI dashboard for the Board.",
        ],
      },
    ],
  },
  changes: [
    {
      chapter_ref: "Rec. 10B Enhanced CDD",
      old_requirement: "Enhanced due diligence required for high-risk customers identified by internal scoring.",
      new_requirement: "Enhanced due diligence required for **all** PEPs (domestic and foreign), high-risk jurisdictions, and any customer with beneficial owners in opaque structures.",
      change_summary: "Broadened EDD scope to all PEPs and opaque ownership structures.",
      impact: "high",
      tone_shift: "Risk-based → Mandatory categories",
      pages: "pp. 22–28",
      legal_refs: ["FATF Rec. 10", "FATF Rec. 12"],
      related_instruments: ["AMLA 2001 (MY)", "EU 6AMLD"],
    },
    {
      chapter_ref: "Rec. 16A Travel Rule (VASP)",
      old_requirement: "(new section)",
      new_requirement: "Virtual asset service providers must transmit originator and beneficiary information for transfers **≥ USD 1,000**.",
      change_summary: "New travel-rule mandate for crypto / VASP transfers.",
      impact: "high",
      tone_shift: "N/A → New mandate",
      pages: "pp. 41–45",
      legal_refs: ["FATF Rec. 16"],
      related_instruments: ["MAS PSN02 (SG)"],
      diff_source: "new",
      compared_against: [],
    },
    {
      chapter_ref: "Rec. 20 STR Threshold",
      old_requirement: "File a Suspicious Transaction Report when aggregate suspicious activity exceeds the legacy threshold.",
      new_requirement: "File a Suspicious Transaction Report **immediately upon suspicion**, regardless of monetary threshold.",
      change_summary: "Removed monetary threshold; suspicion alone now triggers STR.",
      impact: "medium",
      tone_shift: "Threshold-based → Suspicion-based",
      pages: "pp. 51–53",
      legal_refs: ["FATF Rec. 20", "AMLA 2001 s.14"],
      related_instruments: ["FIU Reporting Guideline 2022"],
    },
  ],
  impacts: [
    {
      sop_title: "Customer Due Diligence (CDD) SOP",
      change_type: "full_rewrite",
      page: 12,
      line_range: "180–230",
      paragraph: "§4 Enhanced Due Diligence",
      chapter: "Rec. 10B Enhanced CDD",
      find_text: "Enhanced due diligence shall be applied to customers scored 'high risk' by the internal model.",
      replace_text: "Enhanced due diligence shall be applied to **all PEPs (domestic and foreign)**, customers from FATF high-risk jurisdictions, and any customer with beneficial owners in opaque or multi-layer structures, in addition to internally high-risk-scored customers.",
    },
    {
      sop_title: "Suspicious Transaction Reporting SOP",
      change_type: "find_replace",
      page: 5,
      line_range: "62–66",
      paragraph: "§2.1 Reporting Trigger",
      chapter: "Rec. 20 STR Threshold",
      find_text: "An STR shall be filed when suspicious activity exceeds the prescribed monetary threshold.",
      replace_text: "An STR shall be filed **immediately upon suspicion**, irrespective of monetary value, in line with FATF Rec. 20 (2024).",
    },
    {
      sop_title: "Virtual Asset Transfer SOP",
      change_type: "new_section",
      page: 0,
      line_range: "(new)",
      paragraph: "(new) §3 Travel Rule",
      chapter: "Rec. 16A Travel Rule (VASP)",
      replace_text: "**§3 Travel Rule.** All in-/out-bound virtual-asset transfers ≥ USD 1,000 shall transmit originator and beneficiary identifying information using the IVMS-101 schema, retained for 7 years.",
    },
  ],
};

const CIRCULAR: MockDataset = {
  policy_name: "Regulator Circular 02/2025",
  title: "Regulator Circular 02/2025 — Operational Resilience",
  summary: {
    executive: "Thematic supervisory circular on operational resilience: tightens scenario-testing expectations and incident-disclosure cadence.",
    effective_date: "1 April 2025",
    before_count: 12,
    after_count: 16,
    immediate_actions: [
      "Adopt severe-but-plausible scenario library for resilience testing",
      "Disclose material operational incidents in the next quarterly board pack",
    ],
    structural: { added: ["Annex A Scenario Library"], renamed: [], restructured: [] },
    timeline: [
      { phase: "Phase 1 (0–30 days)", window: "Q2 2025", focus: "Adopt the scenario library and refresh disclosure templates.", bullets: ["Adopt scenario library", "Refresh quarterly disclosure template"] },
      { phase: "Phase 2 (30–90 days)", window: "Q2 2025", focus: "Run two scenario tests against critical services.", bullets: ["Test #1: third-party outage", "Test #2: cyber extortion"] },
      { phase: "Phase 3 (90–180 days)", window: "Q3 2025", focus: "Embed lessons into BCM and report to the Board.", bullets: ["Update BCM playbooks", "Board resilience report"] },
    ],
  },
  changes: [
    {
      chapter_ref: "§3 Scenario Testing",
      old_requirement: "Annual tabletop test of one BCM scenario.",
      new_requirement: "**Two** severe-but-plausible scenarios per year drawn from the regulator's library, with at least one cyber scenario.",
      change_summary: "Doubled cadence and prescribed scenario source.",
      impact: "medium", tone_shift: "Generic → Prescribed library",
      pages: "p. 4", legal_refs: ["Circular 02/2025"], related_instruments: ["BCM Policy"],
    },
    {
      chapter_ref: "§5 Incident Disclosure",
      old_requirement: "Material incidents disclosed in the annual report.",
      new_requirement: "Material incidents disclosed in the **next quarterly** Board pack with root-cause and remediation status.",
      change_summary: "Cadence tightened from annual to quarterly.",
      impact: "medium", tone_shift: "Annual → Quarterly",
      pages: "p. 6", legal_refs: ["Circular 02/2025"], related_instruments: ["Board Reporting Standard"],
    },
  ],
  impacts: [
    {
      sop_title: "Business Continuity Management SOP",
      change_type: "find_replace", page: 8, line_range: "104–108",
      paragraph: "§3 Scenario Testing", chapter: "§3 Scenario Testing",
      find_text: "An annual tabletop exercise shall be conducted against one BCM scenario.",
      replace_text: "**Two** severe-but-plausible scenarios per year (at least one cyber) shall be exercised against critical services, drawn from the regulator's published scenario library.",
    },
    {
      sop_title: "Incident Disclosure SOP",
      change_type: "find_replace", page: 3, line_range: "40–42",
      paragraph: "§5 Disclosures", chapter: "§5 Incident Disclosure",
      find_text: "Material operational incidents shall be disclosed in the Annual Report.",
      replace_text: "Material operational incidents shall be disclosed in the **next quarterly Board pack**, including root-cause analysis and remediation status.",
    },
  ],
};

const IT_POLICY: MockDataset = {
  policy_name: "IT Policy 2025",
  title: "Internal IT Policy — 2025 Refresh",
  summary: {
    executive: "Refreshes laptop, SaaS-onboarding, and remote-access controls. **9 sections** revised.",
    effective_date: "1 May 2025",
    before_count: 40, after_count: 49,
    immediate_actions: [
      "Mandate FIDO2 hardware keys for admin consoles",
      "Onboard SaaS apps via the central IAM broker only",
    ],
    structural: { added: ["§7 SaaS Onboarding"], renamed: [], restructured: [] },
    timeline: [
      { phase: "Phase 1", window: "Q2 2025", focus: "Roll out FIDO2 keys to admin populations.", bullets: ["Procure keys", "Enrol admins"] },
      { phase: "Phase 2", window: "Q3 2025", focus: "Migrate SaaS apps behind IAM broker.", bullets: ["Inventory SaaS", "Migrate top 20"] },
      { phase: "Phase 3", window: "Q4 2025", focus: "Decommission legacy VPN.", bullets: ["Sunset legacy VPN", "Audit access logs"] },
    ],
  },
  changes: [
    {
      chapter_ref: "§4 Privileged Access",
      old_requirement: "Admin consoles protected by password + OTP.",
      new_requirement: "Admin consoles protected by **FIDO2 hardware key** (phishing-resistant MFA).",
      change_summary: "Upgraded MFA factor for admin access.",
      impact: "high", tone_shift: "OTP → FIDO2",
      pages: "p. 10", legal_refs: [], related_instruments: ["NIST 800-63B"],
    },
    {
      chapter_ref: "§7 SaaS Onboarding",
      old_requirement: "(new section)",
      new_requirement: "All SaaS apps must be onboarded through the **central IAM broker** with SCIM provisioning.",
      change_summary: "New mandatory SaaS onboarding pattern.",
      impact: "medium", tone_shift: "N/A → New mandate",
      pages: "pp. 14–16", legal_refs: [], related_instruments: ["IAM Standard"],
      diff_source: "new", compared_against: [],
    },
  ],
  impacts: [
    {
      sop_title: "Privileged Access SOP",
      change_type: "find_replace", page: 4, line_range: "50–52",
      paragraph: "§4 Privileged Access", chapter: "§4 Privileged Access",
      find_text: "Administrative consoles shall require password and one-time-password (OTP) authentication.",
      replace_text: "Administrative consoles shall require **FIDO2 hardware-key** authentication (phishing-resistant MFA). OTP is no longer accepted as a sole second factor.",
    },
    {
      sop_title: "SaaS Onboarding SOP",
      change_type: "new_section", page: 0, line_range: "(new)",
      paragraph: "(new) §1 Onboarding via IAM broker", chapter: "§7 SaaS Onboarding",
      replace_text: "**§1 Onboarding via IAM broker.** New SaaS applications shall be integrated via the central IAM broker with SCIM provisioning. Local-account onboarding is prohibited unless an exception is signed off by the CISO.",
    },
  ],
};

const GENERIC_FALLBACK: MockDataset = {
  ...BNM_RMIT,
  policy_name: "Regulatory Update",
  title: "Regulatory Update — Compliance Gap Analysis",
};

export type DatasetKey = "rmit_reg" | "fatf" | "circular" | "it_policy" | "policy";

export function pickDatasetForType(docType: string, filename: string): MockDataset {
  switch (docType) {
    case "rmit_reg": return BNM_RMIT;
    case "fatf": return FATF_AML;
    case "circular": return CIRCULAR;
    case "it_policy": return IT_POLICY;
    default: return pickDatasetForFile(filename);
  }
}

export function pickDatasetForFile(filename: string): MockDataset {
  const f = filename.toLowerCase();
  if (/(rmit|bnm|kill|vendor|cyber)/.test(f)) return BNM_RMIT;
  if (/(fatf|aml|cft|kyc)/.test(f)) return FATF_AML;
  if (/circular/.test(f)) return CIRCULAR;
  if (/(it[\s_-]*policy|itp|infosec)/.test(f)) return IT_POLICY;
  return GENERIC_FALLBACK;
}

export const PIPELINE_STEPS = [
  { key: "trigger",     label: "Semantic Ingestion — Initialising Vector RAG environment", duration: 700 },
  { key: "parse",       label: "Clause Extraction — Identifying mandates and regulatory tone shifts", duration: 900 },
  { key: "discover",    label: "Contextual Discovery — Cross-referencing Knowledge Base via Similarity", duration: 1100 },
  { key: "recommend",   label: "Impact Generation — Mapping changes to internal SOP paragraphs", duration: 1100 },
  { key: "draft",       label: "Amendment Drafting — Generating implementation-ready wording", duration: 900 },
  { key: "qa",          label: "Legal Verification — Checking cross-document consistency", duration: 1100 },
  { key: "review",      label: "Finalising Analysis — Consolidating findings into Intelligence Dashboard", duration: 900 },
  { key: "complete",    label: "Analysis Complete — Redirecting to results...", duration: 600 },
];
