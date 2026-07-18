// ---------------------------------------------------------------------------
// Legal CMS — self-service template library (Route A).
// Each template defines a question set (the "drafting wizard"): the chatbot /
// wizard collects answers, fillTemplate() renders a finished .doc (Word opens
// HTML-based .doc natively — no docx dependency for the demo).
//
// Generic / single-company: the company name and governing law are captured as
// fields so the same templates work for any organisation and jurisdiction.
// ---------------------------------------------------------------------------

export interface TemplateField {
  id: string;
  label: string;
  placeholder: string;
  type?: "text" | "date" | "number" | "textarea";
  optional?: boolean;
  help?: string;
}

export interface LegalTemplate {
  id: string;
  name: string;
  description: string;
  fileName: string;
  route_hint: "A";
  /** Grouping for the template library. "Banking" items are bank-specific; the
   *  rest are cross-industry and reusable by any organisation. */
  category: "Banking" | "Commercial" | "Corporate" | "Employment" | "Data & Privacy";
  /** matter_type used when a download is tracked as a Legal CMS matter (see
   *  createTemplateRequest) — maps onto the shared MATTER_TYPES list. */
  matter_type: string;
  fields: TemplateField[];
  /** Body HTML with {{field_id}} tokens replaced by answers. */
  body: string;
}

const CSS = `
  body { font-family: 'Times New Roman', serif; font-size: 11pt; line-height: 1.5; margin: 2.5cm; }
  h1 { font-size: 14pt; text-align: center; text-transform: uppercase; letter-spacing: 1px; }
  h2 { font-size: 11pt; margin-top: 18pt; }
  p { text-align: justify; margin: 6pt 0; }
  .fill { font-weight: bold; }
  .sig-table { width: 100%; margin-top: 36pt; }
  .sig-table td { width: 50%; vertical-align: top; padding-right: 24pt; }
  .sig-line { border-top: 1px solid #000; margin-top: 48pt; padding-top: 4pt; font-size: 10pt; }
  .notice { font-size: 9pt; color: #555; border: 1px solid #999; padding: 8pt; margin-bottom: 18pt; }
`;

export const LEGAL_TEMPLATES: LegalTemplate[] = [
  {
    id: "mutual_nda",
    name: "Mutual Non-Disclosure Agreement",
    description: "Standard two-way confidentiality agreement for exploratory discussions with counterparties.",
    fileName: "Mutual-NDA.doc",
    route_hint: "A",
    category: "Commercial",
    matter_type: "nda",
    fields: [
      { id: "company",       label: "Your company name",        placeholder: "e.g. Northwind Corporation Ltd" },
      { id: "company_addr",  label: "Your registered office",   placeholder: "Registered office address" },
      { id: "counterparty",  label: "Counterparty name",        placeholder: "e.g. Acme Technologies Ltd" },
      { id: "cp_addr",       label: "Counterparty address",     placeholder: "Counterparty registered office" },
      { id: "purpose",       label: "Purpose of disclosure",    placeholder: "e.g. evaluation of a proposed technology services engagement", type: "textarea" },
      { id: "term",          label: "Agreement term",           placeholder: "e.g. two (2) years" },
      { id: "survival",      label: "Confidentiality survival period", placeholder: "e.g. three (3) years" },
      { id: "law",           label: "Governing law / jurisdiction", placeholder: "e.g. Malaysia" },
      { id: "date",          label: "Date of agreement",        placeholder: "", type: "date" },
    ],
    body: `
<h1>Mutual Non-Disclosure Agreement</h1>
<p>This Mutual Non-Disclosure Agreement (the "<b>Agreement</b>") is entered into on <span class="fill">{{date}}</span> between:</p>
<p>(1) <b><span class="fill">{{company}}</span></b>, a company with its registered office at <span class="fill">{{company_addr}}</span> (the "<b>Company</b>"); and</p>
<p>(2) <b><span class="fill">{{counterparty}}</span></b>, a company with its registered office at <span class="fill">{{cp_addr}}</span> (the "<b>Counterparty</b>"),</p>
<p>each a "<b>Party</b>" and together the "<b>Parties</b>".</p>

<h2>1. Purpose</h2>
<p>The Parties wish to exchange certain confidential information in connection with <span class="fill">{{purpose}}</span> (the "<b>Purpose</b>").</p>

<h2>2. Confidential Information</h2>
<p>"<b>Confidential Information</b>" means all information disclosed by one Party to the other, whether orally, in writing or in any other form, that is designated as confidential or that reasonably should be understood to be confidential, including business plans, financial information, customer data, technical specifications and know-how, but excluding information that: (a) is or becomes publicly available other than through breach of this Agreement; (b) was lawfully known to the recipient before disclosure; (c) is received from a third party without restriction; or (d) is independently developed without use of the disclosing Party's information.</p>

<h2>3. Obligations</h2>
<p>Each Party shall: (a) use the other Party's Confidential Information solely for the Purpose; (b) protect it with at least the same degree of care it uses for its own confidential information, and no less than reasonable care; (c) not disclose it to any third party except to its officers, employees, and professional advisers who need to know it for the Purpose and are bound by confidentiality obligations no less protective; and (d) comply with all applicable data protection and privacy laws in handling any personal or customer data.</p>

<h2>4. Compelled Disclosure</h2>
<p>A Party may disclose Confidential Information to the extent required by law, regulation or a competent authority, provided that, where lawful, it gives the other Party prompt written notice and reasonable assistance to contest or limit the disclosure.</p>

<h2>5. Term and Termination</h2>
<p>This Agreement takes effect on the date first written above and continues for <span class="fill">{{term}}</span>, unless earlier terminated by either Party upon thirty (30) days' prior written notice to the other Party. Termination shall not affect any rights or obligations that accrued before the effective date of termination.</p>

<h2>6. Survival</h2>
<p>The obligations of confidentiality under Clause 3, and the provisions of Clauses 9 to 14, survive expiry or termination of this Agreement for <span class="fill">{{survival}}</span>.</p>

<h2>7. Return or Destruction</h2>
<p>On written request, each Party shall promptly return or destroy the other Party's Confidential Information, except copies required to be retained by law or bona fide document-retention policies, and shall certify such destruction if requested.</p>

<h2>8. No Licence; No Obligation</h2>
<p>Nothing in this Agreement grants any licence or intellectual property rights, or obliges either Party to enter into any further agreement or to disclose any particular information.</p>

<h2>9. Limitation of Liability</h2>
<p>Neither Party shall be liable to the other for any indirect, incidental, consequential, or punitive damages arising out of or in connection with this Agreement. Nothing in this Clause 9 limits either Party's liability for breach of the confidentiality obligations under Clause 3, for which monetary damages alone may be an inadequate remedy.</p>

<h2>10. Indemnification</h2>
<p>Each Party shall indemnify and hold harmless the other Party against any losses, damages, or reasonable costs (including legal fees) arising from that Party's material breach of its obligations under this Agreement.</p>

<h2>11. Remedies</h2>
<p>Each Party acknowledges that a breach of the confidentiality obligations under this Agreement may cause irreparable harm to the other Party for which monetary damages alone would be an inadequate remedy, and accordingly the non-breaching Party shall be entitled to seek injunctive or other equitable relief, in addition to any other remedies available at law.</p>

<h2>12. Data Protection</h2>
<p>Where either Party discloses personal data under this Agreement, the receiving Party shall process such data in accordance with the Personal Data Protection Act 2010 (PDPA) of Malaysia (or the equivalent data protection law of the jurisdiction stated in Clause 13), and shall implement appropriate technical and organisational measures to protect it against unauthorised access, loss, or disclosure.</p>

<h2>13. Governing Law and Dispute Resolution</h2>
<p>This Agreement is governed by the laws of <span class="fill">{{law}}</span>. Any dispute arising out of or in connection with this Agreement, including any question regarding its existence, validity, or termination, shall be referred to and finally resolved by arbitration administered in accordance with the Asian International Arbitration Centre (AIAC) Arbitration Rules, seated in the jurisdiction stated above, conducted in the English language.</p>

<h2>14. General</h2>
<p>This Agreement constitutes the entire agreement between the Parties in relation to its subject matter and supersedes all prior discussions and agreements on that subject. No amendment or waiver of any provision is effective unless in writing and signed by both Parties. Neither Party may assign this Agreement without the other Party's prior written consent.</p>

<table class="sig-table"><tr>
<td><div class="sig-line">Signed for and on behalf of<br><b>{{company}}</b><br>Name:<br>Title:<br>Date:</div></td>
<td><div class="sig-line">Signed for and on behalf of<br><b>{{counterparty}}</b><br>Name:<br>Title:<br>Date:</div></td>
</tr></table>
`,
  },
  {
    id: "service_agreement",
    name: "Standard Services Agreement (Short Form)",
    description: "Pre-approved short-form agreement for low-risk vendor services below the review threshold.",
    fileName: "Services-Agreement.doc",
    route_hint: "A",
    category: "Commercial",
    matter_type: "template",
    fields: [
      { id: "company",    label: "Your company name",  placeholder: "e.g. Northwind Corporation Ltd" },
      { id: "supplier",   label: "Supplier name",      placeholder: "e.g. Acme Services Ltd" },
      { id: "services",   label: "Description of services", placeholder: "e.g. cloud hosting and support services", type: "textarea" },
      { id: "fees",       label: "Total fees (incl. currency)", placeholder: "e.g. USD 120,000", type: "text", help: "Short form is only valid for low-value engagements below the legal-review threshold." },
      { id: "start_date", label: "Start date",         placeholder: "", type: "date" },
      { id: "end_date",   label: "End date",           placeholder: "", type: "date" },
      { id: "law",        label: "Governing law / jurisdiction", placeholder: "e.g. Malaysia" },
      { id: "date",       label: "Date of agreement",  placeholder: "", type: "date" },
    ],
    body: `
<h1>Services Agreement (Short Form)</h1>
<p>This Services Agreement is entered into on <span class="fill">{{date}}</span> between <b><span class="fill">{{company}}</span></b> ("<b>Company</b>") and <b><span class="fill">{{supplier}}</span></b> ("<b>Supplier</b>").</p>

<h2>1. Services</h2>
<p>The Supplier shall provide the following services (the "<b>Services</b>") with reasonable skill and care: <span class="fill">{{services}}</span>.</p>

<h2>2. Fees</h2>
<p>The Company shall pay fees of <b><span class="fill">{{fees}}</span></b> within thirty (30) days of a valid invoice. Fees are exclusive of applicable taxes, which shall be itemised.</p>

<h2>3. Term and Termination</h2>
<p>This Agreement commences on <span class="fill">{{start_date}}</span> and continues until <span class="fill">{{end_date}}</span>. The Company may terminate for convenience on thirty (30) days' written notice, and either Party may terminate immediately for material breach not remedied within fourteen (14) days of notice.</p>

<h2>4. Confidentiality & Data Protection</h2>
<p>Each Party shall keep the other's confidential information confidential and comply with all applicable data protection and privacy laws. The Supplier shall not process Company customer data except as instructed in writing, and shall notify the Company without undue delay of any data breach.</p>

<h2>5. Compliance & Audit</h2>
<p>The Supplier acknowledges the Company is a regulated organisation. The Supplier shall provide reasonable cooperation with the Company's regulators and its internal and external auditors, including access to relevant records concerning the Services.</p>

<h2>6. Liability</h2>
<p>Neither Party's aggregate liability under this Agreement shall exceed the total fees paid or payable, except for liability arising from fraud, wilful misconduct, breach of confidentiality, or data protection obligations, which is uncapped.</p>

<h2>7. Governing Law</h2>
<p>This Agreement is governed by the laws of <span class="fill">{{law}}</span>; the Parties submit to the exclusive jurisdiction of its courts.</p>

<table class="sig-table"><tr>
<td><div class="sig-line">Signed for <b>{{company}}</b><br>Name:<br>Title:<br>Date:</div></td>
<td><div class="sig-line">Signed for <b>{{supplier}}</b><br>Name:<br>Title:<br>Date:</div></td>
</tr></table>
`,
  },
  {
    id: "ip_registration",
    name: "IP Registration Application (Trade Mark)",
    description: "Standardised trade-mark registration application for filing with the national IP registry (e.g. MyIPO).",
    fileName: "IP-TradeMark-Application.doc",
    route_hint: "A",
    category: "Commercial",
    matter_type: "ip_registration",
    fields: [
      { id: "company",   label: "Applicant company name", placeholder: "e.g. Northwind Corporation Sdn Bhd" },
      { id: "company_addr", label: "Applicant address",   placeholder: "Registered office address" },
      { id: "registry",  label: "Trade marks registry",   placeholder: "e.g. MyIPO (Intellectual Property Corporation of Malaysia)" },
      { id: "mark",      label: "Trade mark",             placeholder: "The word / logo mark to register" },
      { id: "class",     label: "Nice classification class(es)", placeholder: "e.g. Class 9 (software) or Class 35 (business services)" },
      { id: "goods",     label: "Goods / services specification", placeholder: "e.g. software, business and technology services", type: "textarea" },
      { id: "first_use", label: "Date of first use (if any)", placeholder: "", type: "date", optional: true },
      { id: "date",      label: "Application date",        placeholder: "", type: "date" },
    ],
    body: `
<h1>Trade Mark Registration Application</h1>
<p><b>To:</b> <span class="fill">{{registry}}</span></p>
<p><b>Applicant:</b> <span class="fill">{{company}}</span>, <span class="fill">{{company_addr}}</span>.</p>

<h2>1. Mark applied for</h2>
<p><span class="fill">{{mark}}</span></p>

<h2>2. Classification</h2>
<p>Nice Classification: <span class="fill">{{class}}</span></p>

<h2>3. Specification of goods / services</h2>
<p><span class="fill">{{goods}}</span></p>

<h2>4. Declaration</h2>
<p>The Applicant declares that it is the bona fide proprietor of the mark and is using, or has a bona fide intention to use, the mark in relation to the goods/services specified. Date of first use (where applicable): <span class="fill">{{first_use}}</span>.</p>

<h2>5. Filing</h2>
<p>Application dated <span class="fill">{{date}}</span>, submitted under the applicable trade marks legislation.</p>

<div class="sig-line" style="width:50%">Authorised signatory for <b>{{company}}</b><br>Name:<br>Title:<br>Date:</div>
`,
  },
  {
    id: "letter_of_demand",
    name: "Letter of Demand",
    description: "Formal demand for payment or performance before escalation — common in debt recovery and banking.",
    fileName: "Letter-of-Demand.doc",
    route_hint: "A",
    category: "Banking",
    matter_type: "standard_form",
    fields: [
      { id: "company",   label: "Your company name",     placeholder: "e.g. Northwind Bank Berhad" },
      { id: "recipient", label: "Recipient name",        placeholder: "The party in default" },
      { id: "recipient_addr", label: "Recipient address", placeholder: "Recipient's address" },
      { id: "obligation", label: "What is owed / the default", placeholder: "e.g. outstanding sum of RM50,000 under facility no. 123", type: "textarea" },
      { id: "amount",    label: "Amount demanded (if any)", placeholder: "e.g. RM 50,000.00", optional: true },
      { id: "deadline",  label: "Deadline to comply",    placeholder: "e.g. fourteen (14) days" },
      { id: "date",      label: "Date of letter",        placeholder: "", type: "date" },
    ],
    body: `
<h1>Letter of Demand</h1>
<p style="text-align:right"><span class="fill">{{date}}</span></p>
<p><b>To:</b> <span class="fill">{{recipient}}</span><br><span class="fill">{{recipient_addr}}</span></p>
<p><b>WITHOUT PREJUDICE</b></p>
<p>Dear Sir/Madam,</p>
<p>We act for and on behalf of <b><span class="fill">{{company}}</span></b> ("our client").</p>
<h2>1. The default</h2>
<p>We are instructed that, as at the date of this letter, you have failed to meet the following obligation owing to our client: <span class="fill">{{obligation}}</span>. The sum presently due and owing is <b><span class="fill">{{amount}}</span></b>.</p>
<h2>2. Demand</h2>
<p>We are instructed to and hereby DEMAND that you remedy the said default and/or make full payment of the sum stated above within <b><span class="fill">{{deadline}}</span></b> from the date of this letter.</p>
<h2>3. Consequences of non-compliance</h2>
<p>TAKE NOTICE that should you fail to comply within the stipulated period, our client reserves the right to commence legal proceedings against you to recover the sum due together with interest, costs and all other relief, without further reference to you. Our client further reserves all its rights and remedies, all of which are expressly reserved.</p>
<p>Govern yourself accordingly.</p>
<p>Yours faithfully,<br><br>_____________________________<br>for and on behalf of <b>{{company}}</b></p>
`,
  },
  {
    id: "dpa",
    name: "Data Processing Agreement (PDPA)",
    description: "Appoints a vendor as a data processor with PDPA 2010-grade obligations — for any vendor handling personal data.",
    fileName: "Data-Processing-Agreement.doc",
    route_hint: "A",
    category: "Data & Privacy",
    matter_type: "standard_form",
    fields: [
      { id: "controller", label: "Data controller (your company)", placeholder: "e.g. Northwind Bank Berhad" },
      { id: "processor",  label: "Data processor (vendor)",  placeholder: "e.g. Acme Cloud Services Sdn Bhd" },
      { id: "purpose",    label: "Purpose of processing",    placeholder: "e.g. cloud hosting of customer records", type: "textarea" },
      { id: "data_types", label: "Categories of personal data", placeholder: "e.g. names, NRIC, contact details, account data", type: "textarea" },
      { id: "law",        label: "Governing law / jurisdiction", placeholder: "e.g. Malaysia" },
      { id: "date",       label: "Date of agreement",        placeholder: "", type: "date" },
    ],
    body: `
<h1>Data Processing Agreement</h1>
<p>This Data Processing Agreement ("<b>DPA</b>") is entered into on <span class="fill">{{date}}</span> between <b><span class="fill">{{controller}}</span></b> (the "<b>Data Controller</b>") and <b><span class="fill">{{processor}}</span></b> (the "<b>Data Processor</b>").</p>
<h2>1. Scope</h2>
<p>The Data Processor processes personal data on behalf of the Data Controller for the following purpose: <span class="fill">{{purpose}}</span>. The categories of personal data are: <span class="fill">{{data_types}}</span>.</p>
<h2>2. Processor obligations (PDPA 2010)</h2>
<p>The Data Processor shall: (a) process personal data only on the documented instructions of the Data Controller and solely for the stated purpose; (b) implement security measures consistent with the Security Principle under the Personal Data Protection Act 2010; (c) ensure personnel are bound by confidentiality; (d) not engage a sub-processor without prior written consent and equivalent obligations; (e) assist the Data Controller in responding to data-subject access/correction requests; and (f) not transfer personal data outside Malaysia without the Data Controller's written consent and a lawful basis.</p>
<h2>3. Breach notification</h2>
<p>The Data Processor shall notify the Data Controller without undue delay, and in any event within seventy-two (72) hours, of becoming aware of any personal-data breach, and provide reasonable assistance to investigate and remediate.</p>
<h2>4. Return or deletion</h2>
<p>On termination, the Data Processor shall, at the Data Controller's option, return or securely destroy all personal data and certify such destruction, save for copies required to be retained by law.</p>
<h2>5. Audit</h2>
<p>The Data Controller and its regulators may audit the Data Processor's compliance on reasonable notice.</p>
<h2>6. Governing Law</h2>
<p>This DPA is governed by the laws of <span class="fill">{{law}}</span>.</p>
<table class="sig-table"><tr>
<td><div class="sig-line">Signed for <b>{{controller}}</b><br>Name:<br>Title:<br>Date:</div></td>
<td><div class="sig-line">Signed for <b>{{processor}}</b><br>Name:<br>Title:<br>Date:</div></td>
</tr></table>
`,
  },
  {
    id: "board_resolution",
    name: "Directors' Circular Resolution",
    description: "Written board resolution in lieu of a meeting under the Companies Act 2016 — for any company.",
    fileName: "Directors-Circular-Resolution.doc",
    route_hint: "A",
    category: "Corporate",
    matter_type: "standard_form",
    fields: [
      { id: "company",  label: "Company name",       placeholder: "e.g. Northwind Corporation Sdn Bhd" },
      { id: "reg_no",   label: "Company registration no.", placeholder: "e.g. 202001000000 (1234567-A)" },
      { id: "resolutions", label: "Resolution(s) to be passed", placeholder: "State each resolution, e.g. approval to open a bank account / enter into the agreement dated …", type: "textarea" },
      { id: "date",     label: "Date of resolution", placeholder: "", type: "date" },
    ],
    body: `
<h1>Directors' Circular Resolution</h1>
<p style="text-align:center"><b><span class="fill">{{company}}</span></b><br>(Company No. <span class="fill">{{reg_no}}</span>)<br>(Incorporated in Malaysia under the Companies Act 2016)</p>
<p>CIRCULAR RESOLUTION IN WRITING of the Board of Directors pursuant to the Company's Constitution and the Companies Act 2016, dated <span class="fill">{{date}}</span>.</p>
<h2>Resolutions</h2>
<p><span class="fill">{{resolutions}}</span></p>
<p><b>IT WAS RESOLVED</b> that the above be and are hereby approved, and that any one Director and/or the Company Secretary be authorised to do all acts and things necessary to give effect to these resolutions.</p>
<p>This resolution may be signed in counterparts and by the number of Directors required by the Constitution, and shall be as valid and effective as if passed at a duly convened meeting of the Board.</p>
<table class="sig-table"><tr>
<td><div class="sig-line">Director<br>Name:<br>Date:</div></td>
<td><div class="sig-line">Director<br>Name:<br>Date:</div></td>
</tr></table>
`,
  },
  {
    id: "employment_offer",
    name: "Letter of Offer (Employment)",
    description: "Standard employment offer letter aligned to the Employment Act 1955 — cross-industry.",
    fileName: "Employment-Offer-Letter.doc",
    route_hint: "A",
    category: "Employment",
    matter_type: "standard_form",
    fields: [
      { id: "company",   label: "Employer (your company)", placeholder: "e.g. Northwind Corporation Sdn Bhd" },
      { id: "candidate", label: "Candidate name",       placeholder: "Full name of candidate" },
      { id: "position",  label: "Position / job title",  placeholder: "e.g. Legal Counsel" },
      { id: "salary",    label: "Monthly salary",        placeholder: "e.g. RM 8,000" },
      { id: "start_date",label: "Start date",            placeholder: "", type: "date" },
      { id: "probation", label: "Probation period",      placeholder: "e.g. six (6) months" },
      { id: "notice",    label: "Notice period",         placeholder: "e.g. one (1) month" },
      { id: "date",      label: "Date of letter",        placeholder: "", type: "date" },
    ],
    body: `
<h1>Letter of Offer of Employment</h1>
<p style="text-align:right"><span class="fill">{{date}}</span></p>
<p>Dear <span class="fill">{{candidate}}</span>,</p>
<p>We are pleased to offer you employment with <b><span class="fill">{{company}}</span></b> (the "Company") on the following terms.</p>
<h2>1. Position</h2>
<p>You will be employed as <b><span class="fill">{{position}}</span></b>, reporting to your designated superior, commencing on <span class="fill">{{start_date}}</span>.</p>
<h2>2. Remuneration</h2>
<p>Your gross monthly salary will be <b><span class="fill">{{salary}}</span></b>, subject to statutory deductions (EPF, SOCSO, EIS and PCB) in accordance with Malaysian law.</p>
<h2>3. Probation</h2>
<p>You will serve a probationary period of <span class="fill">{{probation}}</span>, which the Company may extend at its discretion. During probation, either party may terminate on shorter notice as stated below.</p>
<h2>4. Notice of termination</h2>
<p>After confirmation, either party may terminate this employment by giving <span class="fill">{{notice}}</span> written notice or salary in lieu, without prejudice to the Company's right to terminate summarily for misconduct with just cause and excuse.</p>
<h2>5. Confidentiality</h2>
<p>You shall keep confidential all trade secrets and confidential information of the Company during and after employment, and shall not solicit the Company's customers or employees for the period stated in your terms.</p>
<h2>6. Statutory terms</h2>
<p>Your employment is governed by the Employment Act 1955 (where applicable) and the laws of Malaysia. Full terms are set out in the Company's employee handbook.</p>
<p>Please sign and return the duplicate of this letter to indicate your acceptance.</p>
<table class="sig-table"><tr>
<td><div class="sig-line">For and on behalf of <b>{{company}}</b><br>Name:<br>Title:</div></td>
<td><div class="sig-line">Accepted by <b>{{candidate}}</b><br>Signature:<br>Date:</div></td>
</tr></table>
`,
  },
];

function esc(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fields the user must answer before a finished (non-blank) contract can be generated. */
export function requiredFieldsFor(t: LegalTemplate): TemplateField[] {
  return t.fields.filter((f) => !f.optional);
}

/** Render finished document HTML with answers substituted for {{tokens}}. */
export function fillTemplate(t: LegalTemplate, answers: Record<string, string>, extraClause?: string): string {
  let body = t.body;
  for (const f of t.fields) {
    const val = (answers[f.id] ?? "").trim();
    const display = val || (f.optional ? "—" : `[${f.label}]`);
    body = body.replaceAll(`{{${f.id}}}`, esc(display));
  }
  const extra = extraClause?.trim()
    ? `<h2>Additional Terms</h2><p>${esc(extraClause.trim()).replace(/\n/g, "<br>")}</p>`
    : "";
  // Insert extra clause before signature block if present
  if (extra && body.includes('<table class="sig-table">')) {
    body = body.replace('<table class="sig-table">', `${extra}<table class="sig-table">`);
  } else if (extra) {
    body += extra;
  }
  return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>
<head><meta charset="utf-8"><title>${esc(t.name)}</title><style>${CSS}</style></head><body>
<div class="notice">SELF-SERVICE DRAFT (Route A), AI-assisted from the approved template library. Pre-approved for routine use. Any amendment to the operative clauses requires legal review (Route B).</div>
${body}
</body></html>`;
}

/** Blank template (for the plain "download template" affordance). */
export function blankTemplateHtml(t: LegalTemplate): string {
  const blanks: Record<string, string> = {};
  for (const f of t.fields) blanks[f.id] = `[${f.label}]`;
  return fillTemplate(t, blanks);
}

/** Strip a generated template's HTML down to plain text — stored server-side as
 *  the document's baseline text so a later AI review (or a counterparty-markup
 *  comparison) has something to work from without re-parsing the fake .doc file
 *  (it's HTML wearing a .doc extension, not a real Word/PDF binary). */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(p|div|h[1-6]|tr|br)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).join("\n")
    .trim();
}

/** Trigger a client-side download of arbitrary document HTML as a .doc file. */
export function downloadDoc(html: string, fileName: string) {
  const blob = new Blob([html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Back-compat: download a template blank. */
export function downloadTemplate(t: LegalTemplate) {
  downloadDoc(blankTemplateHtml(t), t.fileName);
}
