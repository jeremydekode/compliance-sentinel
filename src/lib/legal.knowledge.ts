// ---------------------------------------------------------------------------
// Legal CMS — starter knowledge base (Route C self-service advisory).
//
// Angled for a Malaysian bank / financial institution, but deliberately spans
// cross-industry positions so the same platform is reusable by any organisation.
// Seeded into legal_kb_entries via seedKnowledgeBase(); ALSO compiled into the
// advisory/review prompts as a baseline playbook so Route C answers well even
// before anything is seeded.
// ---------------------------------------------------------------------------

export interface KbSeedEntry {
  title: string;
  takeaways: string;
  category: "Banking" | "Data & Privacy" | "Contracts" | "Corporate" | "Employment";
}

export const LEGAL_KB_SEED: KbSeedEntry[] = [
  // ---- Banking / financial services (Malaysia) ----
  {
    category: "Banking",
    title: "Banking secrecy & customer information",
    takeaways:
      "Under the Financial Services Act 2013 (s.133) a bank must not disclose any customer document or information to a third party. Disclosure is only permitted under the exceptions in Schedule 11 (e.g. customer's written consent, court order, disclosure to the regulator, or for recovery of a debt). The Islamic Financial Services Act 2013 (s.145–146) is the equivalent for Islamic institutions. Any vendor arrangement that touches customer data must be checked against these exceptions and layered on top of PDPA 2010.",
  },
  {
    category: "Banking",
    title: "BNM outsourcing requirements",
    takeaways:
      "Bank Negara Malaysia's Outsourcing policy document governs any arrangement where a service provider performs an activity on the bank's behalf. Material outsourcing generally requires prior BNM notification/no-objection, a documented risk assessment, board oversight, and contractual rights of audit and access for the bank, its auditors and BNM. Contracts should mandate data confidentiality, business-continuity, sub-outsourcing controls, and (usually) that customer data remains within Malaysia unless approved otherwise.",
  },
  {
    category: "Banking",
    title: "AML/CFT obligations",
    takeaways:
      "The Anti-Money Laundering, Anti-Terrorism Financing and Proceeds of Unlawful Activities Act 2001 (AMLA) requires customer due diligence (CDD), ongoing monitoring, and submission of suspicious transaction reports to BNM's Financial Intelligence and Enforcement Department. Records must be kept for at least six years. New products, onboarding flows and third-party arrangements should be screened for AML/CFT and sanctions exposure before launch.",
  },
  {
    category: "Banking",
    title: "Enforceability of guarantees",
    takeaways:
      "A guarantee is governed by the Contracts Act 1950 (ss.79–86). It must be supported by consideration and, in practice, be in writing and executed as a deed. A material variation of the principal contract made without the surety's consent, or the release of the principal debtor, can discharge the guarantor. Continuing guarantees should say so expressly and set out how they can be revoked as to future transactions.",
  },
  {
    category: "Banking",
    title: "Credit facility documentation essentials",
    takeaways:
      "A typical facility comprises a letter of offer, the facility agreement, and the security documents (charge, debenture, guarantee, assignment). Watch conditions precedent, financial covenants, events of default, cross-default, and the security perfection timeline (e.g. registration of charges at SSM within statutory deadlines). Stamp duty and, for land, registration at the land office must be addressed.",
  },

  // ---- Data & privacy (applies across industries) ----
  {
    category: "Data & Privacy",
    title: "Sharing personal data with third-party vendors",
    takeaways:
      "The Personal Data Protection Act 2010 (PDPA) permits disclosure only for the purpose the data was collected or a directly related purpose, unless the data subject consents. Appoint the vendor as a data processor under a written data processing agreement imposing PDPA-grade security, purpose limitation, and a prohibition on onward transfer. Cross-border transfers need a lawful basis. For a bank, banking secrecy (FSA s.133) applies on top of PDPA.",
  },
  {
    category: "Data & Privacy",
    title: "PDPA 2010 compliance basics",
    takeaways:
      "The PDPA is built on seven principles: General, Notice & Choice, Disclosure, Security, Retention, Data Integrity, and Access. Give a bilingual privacy notice, collect consent, keep data only as long as needed, secure it, and honour data-subject access/correction requests. Data processors must be bound by contract to equivalent security obligations. Non-compliance carries fines and, for some offences, imprisonment.",
  },

  // ---- General contracts (Malaysia law, cross-industry) ----
  {
    category: "Contracts",
    title: "Standard liability cap position",
    takeaways:
      "Prefer an aggregate liability cap tied to fees paid (e.g. fees in the preceding 12 months). Never accept unlimited liability. Standard carve-outs from the cap: fraud, wilful misconduct, death/personal injury, breach of confidentiality, IP infringement, and data-protection breaches. Exclude indirect and consequential loss. Under the Contracts Act 1950, penalty clauses are unenforceable — liquidated damages must be a genuine pre-estimate (s.75).",
  },
  {
    category: "Contracts",
    title: "Termination for convenience",
    takeaways:
      "Seek a right to terminate for convenience on reasonable written notice (commonly 30–90 days), plus immediate termination for material unremedied breach, insolvency, or change of control. Spell out the consequences: payment for work done, return/destruction of confidential information and data, transition assistance, and which clauses survive (confidentiality, liability, IP, governing law).",
  },
  {
    category: "Contracts",
    title: "IP ownership in services contracts",
    takeaways:
      "State clearly who owns deliverables. The customer usually takes assignment of foreground IP created specifically for it, while the supplier retains its pre-existing background IP and grants a licence to use it in the deliverables. Include an assignment of present and future rights, a waiver of moral rights where lawful, and a warranty of non-infringement with an IP indemnity.",
  },
  {
    category: "Contracts",
    title: "Force majeure essentials",
    takeaways:
      "Define force majeure by category (acts of God, war, epidemic, government action) plus a sweep-up for events beyond reasonable control. Require prompt written notice, a duty to mitigate, and suspension (not excuse) of obligations while it continues. Give either party a right to terminate if the event persists beyond a set period (e.g. 60–90 days). Payment obligations already accrued are usually carved out.",
  },
  {
    category: "Contracts",
    title: "Governing law & dispute resolution",
    takeaways:
      "For Malaysian counterparties, default to Malaysian law and the exclusive jurisdiction of the Malaysian courts. For cross-border deals, consider arbitration at the Asian International Arbitration Centre (AIAC) seated in Kuala Lumpur, which gives a neutral forum and enforceability under the New York Convention. Keep the governing-law and dispute-resolution clauses consistent with each other.",
  },
  {
    category: "Contracts",
    title: "Stamp duty on agreements",
    takeaways:
      "Under the Stamp Act 1949 most agreements attract either ad valorem duty (e.g. on facility/security documents) or fixed duty (e.g. RM10 on a general agreement). Instruments should be stamped within 30 days of execution to avoid penalties, and an unstamped instrument is generally inadmissible in court until stamped. Adjudication can be sought where the correct duty is unclear.",
  },

  // ---- Corporate & employment (cross-industry) ----
  {
    category: "Corporate",
    title: "Directors' authority & board resolutions",
    takeaways:
      "Under the Companies Act 2016, the board manages the company and can act by resolution at a meeting or by written circular resolution signed by the required majority. Check the constitution for reserved matters, quorum, and any need for shareholder approval (e.g. substantial value transactions, related-party transactions). Record resolutions and update the statutory registers; some changes require lodgement with SSM.",
  },
  {
    category: "Employment",
    title: "Employment contract essentials",
    takeaways:
      "The Employment Act 1955 (as amended in 2022) now covers all employees, with certain protections capped by wage thresholds. Cover job scope, remuneration, hours, leave, notice periods, and grounds/process for termination (dismissal must be with just cause and excuse). Note that under s.28 of the Contracts Act 1950, post-employment restraints of trade (non-competes) are generally void in Malaysia — protect the business instead through confidentiality and non-solicitation of the company's own interests.",
  },
];

/** Compact baseline playbook injected into advisory/review prompts so Route C is
 *  grounded even before the KB table is seeded. */
export function baselinePlaybookText(): string {
  return LEGAL_KB_SEED.map((e) => `- [${e.category}] ${e.title}: ${e.takeaways}`).join("\n");
}
