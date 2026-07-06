import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateWithFallback } from "@/lib/gemini";
import { docxToText, looksLikeDocx, applyEditsToDocx, type DocxEdit } from "@/lib/docx-editor";
import { extractPdfPages } from "@/lib/pdf-pages";
import { LEGAL_KB_SEED, baselinePlaybookText } from "@/lib/legal.knowledge";

// ---------------------------------------------------------------------------
// Legal CMS — server functions
// 6-step AI workflow: Intake → Triage → Assignment → Review → Approval → Vault
// 4 routes: A (self-service), B (bespoke contract), C (simple advisory), D (complex advisory)
//
// Single-organisation demo: the platform is scoped to one company. Legal work is
// referred to as belonging to "the Company"; matters carry a constant org tag so
// the schema stays multi-tenant-ready without exposing it in the UI.
// ---------------------------------------------------------------------------

export const DEFAULT_ORG = "org";

export const MATTER_TYPES = [
  { value: "template",          label: "Standard Template",          route_hint: "A" },
  { value: "ip_registration",   label: "IP Registration",            route_hint: "A" },
  { value: "standard_form",     label: "Standard Internal Form",     route_hint: "A" },
  { value: "contract_review",   label: "Third-Party Contract Review",route_hint: "B" },
  { value: "bespoke_contract",  label: "Bespoke Contract Drafting",  route_hint: "B" },
  { value: "nda",               label: "NDA / Confidentiality",      route_hint: "B" },
  { value: "simple_query",      label: "Simple Legal Query",         route_hint: "C" },
  { value: "playbook_query",    label: "Playbook / Policy Query",    route_hint: "C" },
  { value: "complex_advisory",  label: "Complex Legal Advisory",     route_hint: "D" },
  { value: "multi_party",       label: "Multi-Party Agreement",      route_hint: "D" },
  { value: "material_contract", label: "Material Contract",          route_hint: "D" },
  { value: "regulatory",        label: "Regulatory Matter",          route_hint: "D" },
] as const;

export const STATUS_META: Record<string, { label: string; color: string; step: number }> = {
  draft:              { label: "Draft",              color: "gray",   step: 0 },
  triage:             { label: "AI Triage",          color: "violet", step: 1 },
  resolved:           { label: "Resolved by AI",     color: "emerald",step: 1 },
  pending_assignment: { label: "Pending Assignment", color: "amber",  step: 2 },
  assigned:           { label: "Assigned",           color: "blue",   step: 2 },
  in_review:          { label: "In Review",          color: "blue",   step: 3 },
  pending_approval:   { label: "Pending Approval",   color: "amber",  step: 4 },
  approved:           { label: "Approved",           color: "emerald",step: 5 },
  rejected:           { label: "Rejected",           color: "red",    step: 4 },
  archived:           { label: "Archived",           color: "gray",   step: 6 },
};

export const ROUTE_META: Record<string, { label: string; description: string; color: string }> = {
  A: { label: "Route A",  description: "Self-Service",       color: "emerald" },
  B: { label: "Route B",  description: "Bespoke Contract",   color: "blue" },
  C: { label: "Route C",  description: "Simple Advisory",    color: "violet" },
  D: { label: "Route D",  description: "Complex Advisory",   color: "rose" },
};

// Approval thresholds — contract value + materiality drive who must approve
// (Step 5: "pre-set threshold rules (e.g. contract value)"). Values are in the
// organisation's base currency; tune to taste.
export const MATERIAL_THRESHOLD = 5_000_000;   // at/above this a contract is material (executive escalation)
export const SENIOR_THRESHOLD   = 250_000;     // at/above this needs a senior approver

export function approvalTierFor(
  contractValue: number | null | undefined,
  isMaterial: boolean,
): { tier: "standard" | "senior" | "executive"; label: string; material: boolean } {
  const v = contractValue ?? 0;
  const material = isMaterial || v >= MATERIAL_THRESHOLD;
  if (material) return { tier: "executive", label: "Executive approver / General Counsel", material: true };
  if (v >= SENIOR_THRESHOLD) return { tier: "senior", label: "Senior legal approver", material: false };
  return { tier: "standard", label: "Legal Head", material: false };
}

// Allowed status transitions (server-side trust boundary — the UI only *shows*
// legitimate buttons, but the handler must enforce the workflow).
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft:              ["triage", "pending_assignment", "resolved"],
  triage:             ["pending_assignment"],
  resolved:           ["pending_assignment", "archived"],            // escalate / file
  pending_assignment: ["assigned"],
  assigned:           ["in_review"],                                 // reject happens in review, not at assignment
  in_review:          ["pending_approval", "rejected"],
  pending_approval:   ["approved", "rejected"],
  rejected:           ["in_review", "assigned"],                     // reopen to review, or hand back for re-assignment
  approved:           ["archived"],
  archived:           [],
};

// Single source for the signed-in actor across handlers.
function actor(context: any): { userId: string | null; userEmail: string | null } {
  return {
    userId: (context?.userId as string | undefined) ?? null,
    userEmail: (context?.claims?.email as string | undefined) ?? null,
  };
}

// Best-effort audit logging: an event/comment insert must NEVER fail the primary
// action (e.g. orphan a just-created matter, or make the client retry and create
// a duplicate). Failures are swallowed + logged, not rethrown.
async function logEvent(sb: any, row: Record<string, unknown>) {
  try { await sb.from("legal_matter_events").insert(row); }
  catch (e) { console.error("[legal] event log failed:", e); }
}
async function logComment(sb: any, row: Record<string, unknown>) {
  try { await sb.from("legal_matter_comments").insert(row); }
  catch (e) { console.error("[legal] comment log failed:", e); }
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

async function classifyMatterRoute(
  title: string,
  description: string,
  matterType: string,
): Promise<{ route: "A" | "B" | "C" | "D"; reasoning: string }> {
  const typeHint = MATTER_TYPES.find((t) => t.value === matterType)?.route_hint ?? null;

  const prompt = `You are a legal routing AI for the Company's Legal CMS. Classify this legal matter into one of four routes.

ROUTES:
- Route A (Self-Service): Standardized templates, IP registrations, standard forms. AI drafts automatically, no human legal involvement needed.
- Route B (Bespoke Contract): Third-party drafts, contract review, bespoke contract engineering. Requires AI triage + human lawyer review.
- Route C (Simple Advisory): Routine legal queries answerable from playbooks/SOPs. AI chatbot resolves autonomously.
- Route D (Complex Advisory): Complex matters requiring lawyer review — multi-party agreements, regulatory matters, material contracts, group/executive escalation.

MATTER:
Title: ${title}
Type: ${matterType}
Description: ${description}
${typeHint ? `Suggested route hint from type: ${typeHint}` : ""}

Reply with ONLY valid JSON: {"route": "A"|"B"|"C"|"D", "reasoning": "one sentence explaining why"}`;

  try {
    const res = await generateWithFallback({ contents: [{ parts: [{ text: prompt }] }] }, { tier: "fast" });
    const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (["A","B","C","D"].includes(parsed.route)) return parsed;
    }
  } catch {
    // fallback
  }
  // Type-hint fallback
  const route = (typeHint ?? "D") as "A" | "B" | "C" | "D";
  return { route, reasoning: "Classified based on matter type." };
}

async function runAiTriage(
  title: string,
  description: string,
  matterType: string,
): Promise<{ summary: string; riskFlags: Array<{ severity: "high"|"medium"|"low"; flag: string; recommendation: string }> }> {
  const prompt = `You are a legal AI triage system for the Company — a Malaysian financial institution (also reused by other industries). Apply Malaysian law and, where relevant, BNM / Financial Services Act 2013 / PDPA 2010 / AMLA 2001. Analyze this legal matter and produce a structured triage report.

MATTER:
Title: ${title}
Type: ${matterType}
Description: ${description}

Identify risk flags, compliance concerns, and priority indicators. Return ONLY valid JSON:
{
  "summary": "2-3 sentence triage summary",
  "riskFlags": [
    {"severity": "high"|"medium"|"low", "flag": "risk description", "recommendation": "mitigation recommendation"}
  ]
}

Produce 2-5 risk flags. Be specific to the matter type.`;

  try {
    const res = await generateWithFallback({ contents: [{ parts: [{ text: prompt }] }] }, { tier: "quality" });
    const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {
    // fallback
  }
  return {
    summary: "Triage analysis could not be completed. Manual review required.",
    riskFlags: [{ severity: "medium", flag: "Manual triage required", recommendation: "Assign to senior legal counsel for review." }],
  };
}

async function generateSimpleAdvisoryResponse(
  title: string,
  description: string,
  kbEntries: Array<{ title: string; takeaways: string }> = [],
): Promise<string> {
  const kbBlock = kbEntries.length
    ? `\n\nPUBLISHED KNOWLEDGE BASE (prior sign-off by General Counsel — prefer these positions where relevant):\n${kbEntries.map((e, i) => `${i + 1}. ${e.title}: ${e.takeaways}`).join("\n")}`
    : "";
  const prompt = `You are an AI legal assistant for the Company — a Malaysian financial institution (this platform is also reused across other industries, so apply general Malaysian law where the query is not bank-specific). Answer this simple legal query grounded in the baseline playbook, the published knowledge base, and applicable Malaysian law (e.g. Contracts Act 1950, PDPA 2010, Companies Act 2016, Employment Act 1955; for financial services, BNM policy documents, Financial Services Act 2013 / IFSA 2013, AMLA 2001).

BASELINE PLAYBOOK:
${baselinePlaybookText()}

Query: ${title}
Details: ${description}${kbBlock}

Provide a helpful, professional response in 2-4 paragraphs. Cite the specific statute/policy and the playbook/KB item where it applies. Include relevant legal principles and any caveats. End with a note that this is AI-assisted guidance and complex matters should be escalated to legal counsel.`;

  try {
    const res = await generateWithFallback({ contents: [{ parts: [{ text: prompt }] }] }, { tier: "quality" });
    return res.candidates?.[0]?.content?.parts?.[0]?.text ?? "Unable to generate response.";
  } catch {
    return "Unable to generate AI response at this time. Please escalate to legal counsel.";
  }
}

async function generateExecSummary(
  title: string,
  description: string,
  matterType: string,
  route: string,
  triageSummary?: string,
): Promise<string> {
  const prompt = `You are a legal AI system generating an executive summary for approver sign-off on a legal matter.

MATTER:
Title: ${title}
Type: ${matterType}
Route: ${route}
Description: ${description}
${triageSummary ? `Triage Summary: ${triageSummary}` : ""}

Generate a concise executive summary (3-5 sentences) for the approving authority covering: (1) what the matter is, (2) key obligations or risks, (3) recommended action. Written in formal but clear language.`;

  try {
    const res = await generateWithFallback({ contents: [{ parts: [{ text: prompt }] }] }, { tier: "quality" });
    return res.candidates?.[0]?.content?.parts?.[0]?.text ?? "Summary generation failed.";
  } catch {
    return "Executive summary could not be generated. Please review the matter manually before approving.";
  }
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

export const listLegalMatters = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      status:      z.string().optional(),
      route:       z.enum(["A","B","C","D"]).optional(),
    }).optional()
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    let q = sb
      .from("legal_matters")
      .select("*")
      .eq("workspace_id", "legal")
      .order("created_at", { ascending: false });

    if (data?.status)      q = q.eq("status", data.status);
    if (data?.route)       q = q.eq("route", data.route);

    const { data: matters, error } = await q;
    if (error) throw new Error(error.message);
    return (matters ?? []) as any[];
  });

export const getLegalMatter = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const [matterRes, eventsRes, commentsRes, docsRes, sharesRes] = await Promise.all([
      sb.from("legal_matters").select("*").eq("id", data.id).single(),
      sb.from("legal_matter_events").select("*").eq("matter_id", data.id).order("created_at", { ascending: true }),
      sb.from("legal_matter_comments").select("*").eq("matter_id", data.id).order("created_at", { ascending: true }),
      sb.from("legal_matter_documents").select("*").eq("matter_id", data.id).order("created_at", { ascending: true }),
      sb.from("legal_matter_shares").select("*").eq("matter_id", data.id).order("created_at", { ascending: false }),
    ]);
    if (matterRes.error) throw new Error(matterRes.error.message);
    // Surface (don't silently swallow) secondary-query failures — an empty audit
    // trail from a query error would otherwise masquerade as "no events".
    for (const [name, res] of [["events", eventsRes], ["comments", commentsRes], ["documents", docsRes], ["shares", sharesRes]] as const) {
      if ((res as any).error) console.error(`[legal] getLegalMatter ${name} query failed:`, (res as any).error);
    }

    // Restricted documents are view-only: never expose the (public-bucket) URL to
    // the client, so the bytes are unreachable from the browser regardless of UI.
    const documents = (docsRes.data ?? []).map((d: any) =>
      d.access_level === "restricted" ? { ...d, file_url: null } : d
    );

    return {
      matter:    matterRes.data,
      events:    eventsRes.data ?? [],
      comments:  commentsRes.data ?? [],
      documents,
      shares:    sharesRes.data ?? [],
    };
  });

export const createLegalMatter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      title:           z.string().min(3),
      description:     z.string().min(10),
      matter_type:     z.string(),
      priority:        z.enum(["low","normal","high","urgent"]).default("normal"),
      requestor_name:  z.string(),
      requestor_email: z.string().email(),
      due_date:        z.string().optional(),
      is_material:     z.boolean().optional(),
      contract_value:  z.number().nonnegative().optional(),
      has_attachments: z.boolean().optional(),
    })
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    // 1. AI route classification
    const { route, reasoning } = await classifyMatterRoute(data.title, data.description, data.matter_type);

    // 1b. Intake AI screening — flag discrepancies before routing (missing docs,
    // missing/erratic contract value, material without value). Rule-based for
    // reliable, explainable demo behaviour.
    // Materiality: explicit flag, material type, OR value at/above the threshold.
    const isMaterial =
      (data.is_material ?? false) ||
      data.matter_type === "material_contract" ||
      (data.contract_value ?? 0) >= MATERIAL_THRESHOLD;

    const screeningFlags: Array<{ type: string; message: string }> = [];
    const needsDoc = ["contract_review", "bespoke_contract", "material_contract", "multi_party"].includes(data.matter_type);
    if (needsDoc && !data.has_attachments) {
      screeningFlags.push({ type: "missing_document", message: "This matter type usually needs the draft/contract attached — none was uploaded." });
    }
    if ((data.is_material || data.matter_type === "material_contract") && !data.contract_value) {
      screeningFlags.push({ type: "missing_value", message: "Marked material but no contract value provided — value drives the approval threshold." });
    }
    if (data.contract_value && data.contract_value >= SENIOR_THRESHOLD && data.matter_type === "template") {
      screeningFlags.push({ type: "value_mismatch", message: "Contract value exceeds the short-form template limit — should route to bespoke legal review." });
    }
    const aiScreening = screeningFlags.length
      ? { status: "flags", flags: screeningFlags }
      : { status: "clear", flags: [] };

    // 2. Determine initial status + AI response by route
    let initialStatus: string;
    let aiResponse: string | undefined;
    let triageResult: any;
    let triageSummary: string | undefined;
    let riskFlags: any;

    if (route === "A") {
      // Self-service: bypasses triage/assignment/review entirely (deck: "Bypasses
      // Steps 2,3,4"). The matter is a self-served record — resolved on creation.
      initialStatus = "resolved";
    } else if (route === "C") {
      // Simple advisory: AI answers from playbooks + the published KB, and the
      // matter terminates at Step 1 — "Resolved autonomously" — unless escalated.
      initialStatus = "resolved";
      const { data: kb } = await sb
        .from("legal_kb_entries")
        .select("title, takeaways")
        .order("created_at", { ascending: false })
        .limit(12);
      aiResponse = await generateSimpleAdvisoryResponse(data.title, data.description, kb ?? []);
    } else {
      // Routes B and D: run AI triage immediately, then wait for the Legal Head
      // to assign (chain-of-command).
      const triage = await runAiTriage(data.title, data.description, data.matter_type);
      triageSummary = triage.summary;
      riskFlags = triage.riskFlags;
      triageResult = triage;
      initialStatus = "pending_assignment";
    }

    // 3. Insert matter
    const { data: matter, error } = await sb
      .from("legal_matters")
      .insert({
        workspace_id:      "legal",
        entity_code:       DEFAULT_ORG,
        title:             data.title,
        description:       data.description,
        matter_type:       data.matter_type,
        route,
        ai_route_reasoning: reasoning,
        status:            initialStatus,
        priority:          data.priority,
        is_material:       isMaterial,
        requestor_id:      userId,
        requestor_name:    data.requestor_name,
        requestor_email:   data.requestor_email,
        due_date:          data.due_date ?? null,
        contract_value:    data.contract_value ?? null,
        ai_screening:      aiScreening,
        ai_triage_result:  triageResult ?? null,
        ai_triage_summary: triageSummary ?? null,
        ai_risk_flags:     riskFlags ?? null,
        ai_response:       aiResponse ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // 4. Log creation event — best-effort, so a logging failure never orphans the
    //    just-committed matter or forces a retry that would create a duplicate.
    await logEvent(sb, {
      matter_id:  matter.id,
      event_type: "created",
      actor_id:   userId,
      actor_name: data.requestor_name,
      to_status:  initialStatus,
      payload:    { route, reasoning },
    });

    if (route === "B" || route === "D") {
      await logEvent(sb, {
        matter_id:  matter.id,
        event_type: "triage_completed",
        actor_name: "AI Triage System",
        to_status:  "pending_assignment",
        payload:    { summary: triageSummary, riskCount: riskFlags?.length ?? 0 },
      });
    }

    return matter as any;
  });

export const assignLegalMatter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      matter_id:         z.string().uuid(),
      assigned_to_name:  z.string(),
      assigned_to_email: z.string().email().optional(),
      notes:             z.string().optional(),
    })
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { error } = await sb
      .from("legal_matters")
      .update({
        status:            "assigned",
        assigned_to_name:  data.assigned_to_name,
        assigned_to_email: data.assigned_to_email ?? null,
        assigned_by:       userId,
        assigned_by_name:  userEmail ?? "Legal Head",
        assigned_at:       new Date().toISOString(),
      })
      .eq("id", data.matter_id);

    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id:  data.matter_id,
      event_type: "assigned",
      actor_id:   userId,
      actor_name: userEmail ?? "Legal Head",
      from_status: "pending_assignment",
      to_status:  "assigned",
      payload:    { assigned_to: data.assigned_to_name, notes: data.notes },
    });

    if (data.notes) {
      await logComment(sb, {
        matter_id:    data.matter_id,
        author_id:    userId,
        author_name:  userEmail ?? "Legal Head",
        content:      data.notes,
        comment_type: "review_note",
      });
    }

    return { ok: true };
  });

export const advanceLegalMatterStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      matter_id:  z.string().uuid(),
      new_status: z.enum(["assigned","in_review","pending_approval","approved","rejected","archived"]),
      notes:      z.string().optional(),
    })
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    // Fetch current status for the transition guard + event log
    const { data: current } = await sb
      .from("legal_matters")
      .select("status, title, description, matter_type, route, ai_triage_summary, ai_executive_summary")
      .eq("id", data.matter_id)
      .single();
    if (!current) throw new Error("Matter not found");

    // Trust boundary: reject illegal transitions (the UI only shows legal ones,
    // but the server must enforce the workflow, e.g. no in_review → approved skip).
    const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(data.new_status)) {
      throw new Error(`Cannot move a ${current.status} matter to ${data.new_status}.`);
    }

    const updatePayload: any = { status: data.new_status };
    if (data.new_status === "approved") {
      updatePayload.approved_by      = userId;
      updatePayload.approved_by_name = userEmail ?? "Approver";
      updatePayload.approved_at      = new Date().toISOString();
      updatePayload.completed_at     = new Date().toISOString();
    }
    if (data.new_status === "rejected" && data.notes) {
      updatePayload.rejection_reason = data.notes;
    }
    if (data.new_status === "archived") {
      updatePayload.completed_at = new Date().toISOString();
    }

    // Generate the exec summary on the way to approval — but only if one doesn't
    // already exist, so a reopen→resubmit never clobbers the manager's edits.
    if (data.new_status === "pending_approval" && !current.ai_executive_summary) {
      updatePayload.ai_executive_summary = await generateExecSummary(
        current.title,
        current.description,
        current.matter_type,
        current.route,
        current.ai_triage_summary,
      );
    }

    const { error } = await sb
      .from("legal_matters")
      .update(updatePayload)
      .eq("id", data.matter_id);

    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id:  data.matter_id,
      event_type: "status_changed",
      actor_id:   userId,
      actor_name: userEmail ?? "System",
      from_status: current?.status,
      to_status:  data.new_status,
      payload:    { notes: data.notes },
    });

    if (data.notes) {
      await logComment(sb, {
        matter_id:    data.matter_id,
        author_id:    userId,
        author_name:  userEmail ?? "User",
        content:      data.notes,
        comment_type: data.new_status === "rejected" ? "rejection_reason" : "review_note",
      });
    }

    return { ok: true };
  });

export const addLegalComment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      matter_id:    z.string().uuid(),
      content:      z.string().min(1),
      comment_type: z.enum(["comment","review_note","ai_note"]).default("comment"),
      function_tag: z.string().optional(),   // Tax / Compliance / Risk / Finance
    })
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    // Parse @mentions so the in-matter chat can highlight / notify tagged users.
    const mentions = Array.from(new Set((data.content.match(/@([\w.\-]+)/g) ?? []).map((s) => s.slice(1))));

    const { data: comment, error } = await sb
      .from("legal_matter_comments")
      .insert({
        matter_id:    data.matter_id,
        author_id:    userId,
        author_name:  userEmail ?? "User",
        author_email: userEmail,
        content:      data.content,
        comment_type: data.comment_type,
        function_tag: data.function_tag ?? null,
        mentions:     mentions.length ? mentions : null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return comment;
  });

// Escalate an AI-resolved matter to human legal review — "unless escalated".
// Route C → D (complex advisory); Route A → B (bespoke, deviation from standard
// form). Runs triage if none exists and drops it into the assignment queue.
export const escalateLegalMatter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    matter_id: z.string().uuid(),
    reason: z.string().optional(),
  }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: matter } = await sb
      .from("legal_matters")
      .select("status, route, title, description, matter_type, ai_triage_summary")
      .eq("id", data.matter_id)
      .single();
    if (!matter) throw new Error("Matter not found");

    // Only an AI-resolved matter can be escalated (Route C/A terminate at intake).
    if (matter.status !== "resolved") {
      throw new Error("Only an AI-resolved matter can be escalated to human review.");
    }

    // Route A escalates to B (deviation from standard form); Route C → D.
    const targetRoute = matter.route === "A" ? "B" : "D";
    // Clear the AI-resolved answer: it was a Route-A/C artefact and must not be
    // mislabelled as a lawyer-grade "proposed response" once re-routed.
    const update: any = { status: "pending_assignment", route: targetRoute, ai_response: null };
    if (!matter.ai_triage_summary) {
      const triage = await runAiTriage(matter.title ?? "", matter.description ?? "", matter.matter_type ?? "");
      update.ai_triage_result = triage;
      update.ai_triage_summary = triage.summary;
      update.ai_risk_flags = triage.riskFlags;
    }

    const { error } = await sb.from("legal_matters").update(update).eq("id", data.matter_id);
    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id:  data.matter_id,
      event_type: "escalated",
      actor_id:   userId,
      actor_name: userEmail ?? "User",
      from_status: matter?.status,
      to_status:  "pending_assignment",
      payload:    { reason: data.reason, route: targetRoute },
    });

    if (data.reason) {
      await logComment(sb, {
        matter_id:    data.matter_id,
        author_id:    userId,
        author_name:  userEmail ?? "User",
        content:      `Escalated to counsel: ${data.reason}`,
        comment_type: "review_note",
      });
    }

    return { ok: true };
  });

export const archiveLegalMatter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ matter_id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { error } = await sb
      .from("legal_matters")
      .update({ status: "archived", completed_at: new Date().toISOString() })
      .eq("id", data.matter_id);

    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id:  data.matter_id,
      event_type: "archived",
      actor_id:   userId,
      actor_name: userEmail ?? "System",
      to_status:  "archived",
    });

    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Step 1 — Conversational AI intake (the "intelligent point of intake").
// Stateless chat: the client sends the whole history each turn; the model
// interviews the requester, offers self-service templates, and — once it has
// enough context — proposes a structured request draft for confirmation.
// ---------------------------------------------------------------------------

const INTAKE_SYSTEM = `You are the Company's Legal Intake Assistant — the conversational gatekeeper that replaces the traditional legal Requisition Form. The Company is a Malaysian financial institution, but this platform is also reused across other industries, so apply general Malaysian law unless the request is bank-specific (then also consider BNM policy, Financial Services Act 2013, PDPA 2010, AMLA 2001).

YOUR JOB — a short exploratory interview:
1. Understand what the requester needs. Ask AT MOST ONE clarifying question per turn, and at most 2-3 questions total before proposing. Be warm, efficient, plain-English.
2. Work out which track fits:
   - Route A (Self-Service): standard templates (NDA, short-form services agreement), IP registrations, standard forms. → OFFER the matching template download. Tell them they can use it directly, and OFFER to also open a tracked request if they want Legal sign-off or bespoke changes.
   - Route B (Bespoke Contract): reviewing/negotiating a third-party draft or bespoke drafting. → They should upload the contract document when opening the request; the AI runs a clause-by-clause first cut before a lawyer opens the file.
   - Route C (Simple Advisory): a routine legal question answerable from playbooks. → The system answers it instantly when the request opens.
   - Route D (Complex Advisory): multi-party, regulatory, material or novel matters needing lawyer review.
3. When you have enough to act, PROPOSE a request draft. Keep the title crisp, the description a faithful 2-4 sentence summary of what they told you.

AVAILABLE TEMPLATES (for offer_template): "mutual_nda" (Mutual NDA), "service_agreement" (Standard Services Agreement short form, low-value vendor services), "ip_registration" (Trade-mark registration application), "letter_of_demand" (Letter of Demand — payment default / debt recovery), "dpa" (Data Processing Agreement, PDPA — vendor handling personal data), "board_resolution" (Directors' Circular Resolution, Companies Act 2016), "employment_offer" (Letter of Offer of Employment, Employment Act 1955).

MATTER TYPES (for propose_request.matter_type): template, ip_registration, standard_form, contract_review, bespoke_contract, nda, simple_query, playbook_query, complex_advisory, multi_party, material_contract, regulatory.

RESPONSE FORMAT — reply with ONLY valid JSON, no markdown fences:
{
  "reply": "your conversational message to the requester",
  "action": null
    | {"type": "offer_template", "template_id": "mutual_nda" | "service_agreement"}
    | {"type": "propose_request", "draft": {"title": "...", "matter_type": "...", "priority": "low"|"normal"|"high"|"urgent", "description": "...", "is_material": false, "contract_value": null}}
}

Rules: offer_template only when a standard template genuinely fits. propose_request only when you truly have enough (never on the first turn unless the user gave full context). If they mention a contract to review, remind them in "reply" to attach the document on the confirmation card. If they mention a monetary amount, set draft.contract_value to that number (digits only); otherwise leave it null. Material = large value / company-wide significance → is_material true and mention that it triggers executive-level approval.`;

export const legalIntakeChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      messages: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string(),
      })).min(1).max(40),
    })
  )
  .handler(async ({ data }) => {
    const contents = data.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    }));

    const res = await generateWithFallback(
      {
        contents,
        config: {
          systemInstruction: INTAKE_SYSTEM,
          responseMimeType: "application/json",
          maxOutputTokens: 2048,
        },
      },
      { tier: "quality" }
    );

    const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    try {
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : text);
      if (typeof parsed.reply === "string") {
        return { reply: parsed.reply, action: parsed.action ?? null };
      }
    } catch {
      // fall through
    }
    return {
      reply: text || "Sorry — I didn't catch that. Could you tell me a bit more about what you need from Legal?",
      action: null,
    };
  });

// ---------------------------------------------------------------------------
// Documents: attach uploaded files to a matter + AI clause-by-clause review
// (the "Playbook Triage" first cut — red flag / caution / compliant).
// ---------------------------------------------------------------------------

export const attachLegalDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      matter_id:  z.string().uuid(),
      file_name:  z.string(),
      file_url:   z.string().url(),
      mime_type:  z.string().optional(),
      size_bytes: z.number().optional(),
      doc_role:   z.enum(["submitted", "reference", "executed"]).default("submitted"),
    })
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: doc, error } = await sb
      .from("legal_matter_documents")
      .insert({
        matter_id:        data.matter_id,
        file_name:        data.file_name,
        file_url:         data.file_url,
        mime_type:        data.mime_type ?? null,
        size_bytes:       data.size_bytes ?? null,
        doc_role:         data.doc_role,
        ai_review_status: "none",
        uploaded_by:      userId,
        uploaded_by_name: userEmail ?? "User",
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id:  data.matter_id,
      event_type: "document_uploaded",
      actor_id:   userId,
      actor_name: userEmail ?? "User",
      payload:    { file_name: data.file_name, doc_role: data.doc_role },
    });

    return doc as any;
  });

export const reviewLegalDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ document_id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;

    const { data: doc, error } = await sb
      .from("legal_matter_documents")
      .select("*")
      .eq("id", data.document_id)
      .single();
    if (error || !doc) throw new Error(error?.message ?? "Document not found");

    // Parent matter (separate fetch — avoids relying on PostgREST embed detection)
    const { data: matter } = await sb
      .from("legal_matters")
      .select("id, title, matter_type, entity_code")
      .eq("id", doc.matter_id)
      .single();

    await sb.from("legal_matter_documents")
      .update({ ai_review_status: "running" })
      .eq("id", data.document_id);

    try {
      // Fetch the file from public storage
      const resp = await fetch(doc.file_url);
      if (!resp.ok) throw new Error(`Could not fetch document (${resp.status})`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      const mime = doc.mime_type || resp.headers.get("content-type") || "application/octet-stream";
      const instruction = `You are senior legal counsel AI for the Company — a Malaysian financial institution (the platform is also reused by other industries, so apply general Malaysian law where the matter is not bank-specific). Perform a clause-by-clause first-cut review of the attached document for the matter "${matter?.title ?? doc.file_name}".

Assess against standard company playbook positions and Malaysian law: liability caps (never unlimited; penalties void under s.75 Contracts Act 1950), indemnities, termination rights, confidentiality, data protection (PDPA 2010) and — for a bank — customer secrecy (Financial Services Act 2013 s.133) and BNM outsourcing audit-access requirements, IP ownership, force majeure, governing law (prefer Malaysian law / AIAC arbitration), payment & stamp-duty terms, auto-renewal traps.

Return ONLY valid JSON:
{
  "verdict": "red_flag" | "caution" | "compliant",
  "riskScore": 0-100 (0 = clean, 100 = severe — overall exposure of this draft to the Company),
  "summary": "3-4 sentence overall assessment for the lawyer picking this up",
  "exposure": {
    "financial":    "low" | "medium" | "high",
    "regulatory":   "low" | "medium" | "high",
    "operational":  "low" | "medium" | "high",
    "reputational": "low" | "medium" | "high"
  },
  "clauses": [
    {
      "ref": "clause number/heading, e.g. 'Clause 12.3 — Liability'",
      "excerpt": "an EXACT verbatim substring copied character-for-character from the document (roughly 8-25 words) that uniquely marks the passage to change — do NOT paraphrase, summarise, truncate mid-word, add ellipses, or fix typos; copy it exactly so it can be found and replaced",
      "severity": "red_flag" | "caution" | "compliant",
      "category": "financial" | "regulatory" | "operational" | "reputational",
      "comment": "what the issue or confirmation is",
      "suggestion": "the SUGGESTED REDLINE — the exact replacement wording the Company should propose (empty string if compliant)"
    }
  ]
}
Cover the 4-10 most significant clauses. verdict = worst severity found. Make suggestions concrete, drop-in replacement wording a lawyer could accept as-is.`;

      let parts: any[];
      // Reuse text already extracted on the review (amended drafts carry their
      // amended text, and their file is an HTML .doc that won't re-parse as docx).
      let documentText = String(doc.ai_review?.documentText ?? "");
      if (documentText.trim()) {
        parts = [{ text: instruction }, { text: `DOCUMENT (${doc.file_name}):\n\n${documentText.slice(0, 150_000)}` }];
      } else if (looksLikeDocx(mime, doc.file_name)) {
        documentText = await docxToText(buffer);
        parts = [{ text: instruction }, { text: `DOCUMENT (${doc.file_name}):\n\n${documentText.slice(0, 150_000)}` }];
      } else if (mime.includes("pdf") || /\.pdf($|\?)/i.test(doc.file_name)) {
        try {
          const pages = await extractPdfPages(buffer);
          documentText = pages.map((pg) => pg.text).filter(Boolean).join("\n\n");
        } catch { documentText = ""; }
        parts = documentText.trim()
          ? [{ text: instruction }, { text: `DOCUMENT (${doc.file_name}):\n\n${documentText.slice(0, 150_000)}` }]
          // scanned/image PDF — send the binary so Gemini can still read it
          : [{ text: instruction }, { inlineData: { mimeType: "application/pdf", data: buffer.toString("base64") } }];
      } else {
        documentText = buffer.toString("utf8");
        parts = [{ text: instruction }, { text: `DOCUMENT (${doc.file_name}):\n\n${documentText.slice(0, 150_000)}` }];
      }

      const res = await generateWithFallback(
        { contents: [{ role: "user", parts }], config: { responseMimeType: "application/json", maxOutputTokens: 16384 } },
        { tier: "quality" }
      );
      const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const match = text.match(/\{[\s\S]*\}/);
      const review = JSON.parse(match ? match[0] : text);

      if (!review || !Array.isArray(review.clauses)) throw new Error("AI review returned an unexpected format");
      // Stash a truncated copy of the document text for the co-pilot editor view.
      review.documentText = documentText.slice(0, 60_000);
      // PRESERVE user-authored data across a re-run: reviewer highlight-to-comment
      // annotations, and (for amended drafts) the redline + change history live INSIDE
      // ai_review — a naive overwrite would silently delete them.
      const prior = doc.ai_review ?? {};
      if (Array.isArray(prior.annotations) && prior.annotations.length) review.annotations = prior.annotations;
      if (prior.redlineText) review.redlineText = prior.redlineText;
      if (Array.isArray(prior.changes) && prior.changes.length) review.changes = prior.changes;

      await sb.from("legal_matter_documents")
        .update({ ai_review: review, ai_review_status: "done", ai_reviewed_at: new Date().toISOString() })
        .eq("id", data.document_id);

      const counts = { red_flag: 0, caution: 0, compliant: 0 } as Record<string, number>;
      for (const c of review.clauses) counts[c.severity] = (counts[c.severity] ?? 0) + 1;

      await logEvent(sb, {
        matter_id:  doc.matter_id,
        event_type: "ai_review_completed",
        actor_name: "AI Triage Scanner",
        payload:    { file_name: doc.file_name, verdict: review.verdict, ...counts },
      });

      await logComment(sb, {
        matter_id:    doc.matter_id,
        author_name:  "AI Triage Scanner",
        content:      `First-cut review of "${doc.file_name}" complete — ${counts.red_flag} red flag${counts.red_flag !== 1 ? "s" : ""}, ${counts.caution} caution${counts.caution !== 1 ? "s" : ""}, ${counts.compliant} compliant. ${review.summary ?? ""}`,
        comment_type: "ai_note",
      });

      return { ok: true, review };
    } catch (e: any) {
      await sb.from("legal_matter_documents")
        .update({ ai_review_status: "failed" })
        .eq("id", data.document_id);
      throw new Error(e?.message ?? "AI review failed");
    }
  });

export const setDocumentAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    document_id:  z.string().uuid(),
    access_level: z.enum(["standard", "restricted"]),
  }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { error } = await sb
      .from("legal_matter_documents")
      .update({ access_level: data.access_level })
      .eq("id", data.document_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Fetch a single document + its parent matter for the AI Co-Pilot review screen.
export const getLegalDocument = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ document_id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { data: doc, error } = await sb
      .from("legal_matter_documents")
      .select("*")
      .eq("id", data.document_id)
      .single();
    if (error || !doc) throw new Error(error?.message ?? "Document not found");

    const { data: matter } = await sb
      .from("legal_matters")
      .select("id, reference_number, title, route, entity_code, status")
      .eq("id", doc.matter_id)
      .single();

    // Extract the document text so the viewer can show content WITHOUT an AI review
    // having run first. Prefer text already stored on the review (e.g. amended
    // drafts carry their amended text); otherwise extract from the source file.
    let text: string = doc.ai_review?.documentText ?? "";
    if (!text && doc.access_level !== "restricted" && doc.file_url) {
      try {
        const resp = await fetch(doc.file_url);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          const mime = doc.mime_type || resp.headers.get("content-type") || "";
          if (looksLikeDocx(mime, doc.file_name)) {
            text = await docxToText(buf);
          } else if (mime.includes("pdf") || /\.pdf($|\?)/i.test(doc.file_name)) {
            const pages = await extractPdfPages(buf);
            text = pages.map((p) => p.text).filter(Boolean).join("\n\n");
          } else {
            text = buf.toString("utf8");
          }
        }
      } catch (e) {
        console.error("[legal] getLegalDocument text extraction failed:", e);
      }
    }

    // Never leak the URL for a restricted doc.
    if (doc.access_level === "restricted") doc.file_url = null;
    return { document: doc, matter, text: text.slice(0, 200_000) };
  });

// Accept a suggested AI redline — records it into the review, logs it, and posts
// a note ("suggests alternative clauses directly into the workflow for approval").
export const acceptClauseSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    document_id:  z.string().uuid(),
    clause_index: z.number().int().min(0),
    accepted:     z.boolean().default(true),
  }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: doc } = await sb
      .from("legal_matter_documents")
      .select("ai_review, matter_id, file_name")
      .eq("id", data.document_id)
      .single();
    if (!doc?.ai_review?.clauses?.[data.clause_index]) throw new Error("Clause not found");

    const review = doc.ai_review;
    review.clauses[data.clause_index].accepted = data.accepted;

    const { error } = await sb
      .from("legal_matter_documents")
      .update({ ai_review: review })
      .eq("id", data.document_id);
    if (error) throw new Error(error.message);

    if (data.accepted) {
      const clause = review.clauses[data.clause_index];
      await logEvent(sb, {
        matter_id:  doc.matter_id,
        event_type: "suggestion_accepted",
        actor_id:   userId,
        actor_name: userEmail ?? "User",
        payload:    { file_name: doc.file_name, ref: clause.ref },
      });
    }
    return { ok: true };
  });

function escHtml(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Normalize a string for whitespace/quote/dash-insensitive matching (lowercased,
// smart-quotes → straight, whitespace collapsed to single spaces, trimmed).
function normStr(s: string): string {
  return (s ?? "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Build a normalized copy of `s` PLUS an index map: map[i] is the original index of
// the i-th normalized character. Lets a fuzzy match be mapped back to an exact span.
function buildNormMap(s: string): { norm: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (ch === "‘" || ch === "’" || ch === "‛") ch = "'";
    else if (ch === "“" || ch === "”") ch = '"';
    else if (ch === "–" || ch === "—") ch = "-";
    if (/\s/.test(ch)) {
      if (prevSpace) continue;   // collapse runs of whitespace
      out.push(" "); map.push(i); prevSpace = true;
    } else {
      out.push(ch.toLowerCase()); map.push(i); prevSpace = false;
    }
  }
  // Handle a possible leading space from a leading-whitespace source (trim parity).
  return { norm: out.join(""), map };
}

// Locate an AI clause quote (`ne` = already-normalized excerpt) inside a normalized
// document (`normMut`), returning the ORIGINAL-text span [origStart, origEnd) plus the
// NORM span [normStart, normEnd) for blanking. Tries an exact normalized match first,
// then falls back to anchoring on the clause's opening + closing phrases (so a quote
// that differs only in the middle — the common cause of a clause being "appended" —
// is still placed in line).
function locateClauseSpan(
  normMut: string,
  map: number[],
  ne: string,
): { origStart: number; origEnd: number; normStart: number; normEnd: number } | null {
  if (ne.length < 6) return null;

  const exact = normMut.indexOf(ne);
  if (exact >= 0) {
    const normEnd = exact + ne.length;
    return { origStart: map[exact], origEnd: map[normEnd - 1] + 1, normStart: exact, normEnd };
  }

  // Anchor fallback: first 4 + last 4 words must appear verbatim, in order.
  const words = ne.split(" ").filter(Boolean);
  if (words.length >= 8) {
    const head = words.slice(0, 4).join(" ");
    const tail = words.slice(-4).join(" ");
    const p1 = normMut.indexOf(head);
    if (p1 >= 0) {
      const p2 = normMut.indexOf(tail, p1 + head.length);
      if (p2 >= 0) {
        const normEnd = p2 + tail.length;
        const spanLen = normEnd - p1;
        // reject an implausibly large span (grabbed across clauses)
        if (spanLen <= ne.length * 2 + 120) {
          return { origStart: map[p1], origEnd: map[normEnd - 1] + 1, normStart: p1, normEnd };
        }
      }
    }
  }
  return null;
}

// Reviewer highlight-to-comment on a document: the user selects a passage in the
// AI Co-Pilot and attaches a note. Stored on the document's ai_review so it sits
// alongside the AI clauses; also mirrored into the matter chat for the audit log.
export const addDocumentAnnotation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    document_id: z.string().uuid(),
    quote:       z.string().min(1).max(2000),
    comment:     z.string().min(1).max(4000),
  }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: doc } = await sb
      .from("legal_matter_documents").select("ai_review, matter_id, file_name").eq("id", data.document_id).single();
    if (!doc) throw new Error("Document not found");

    const review = doc.ai_review ?? {};
    const annotations = Array.isArray(review.annotations) ? review.annotations : [];
    annotations.push({
      quote: data.quote.trim(),
      comment: data.comment.trim(),
      author: userEmail ?? "Reviewer",
      // no Date.now() available server-side in some contexts; stamp with ISO now
      at: new Date().toISOString(),
    });
    review.annotations = annotations;

    const { error } = await sb.from("legal_matter_documents").update({ ai_review: review }).eq("id", data.document_id);
    if (error) throw new Error(error.message);

    await logComment(sb, {
      matter_id:    doc.matter_id,
      author_id:    userId,
      author_name:  userEmail ?? "Reviewer",
      content:      `Comment on "${doc.file_name}" — “${data.quote.trim().slice(0, 120)}${data.quote.length > 120 ? "…" : ""}”: ${data.comment.trim()}`,
      comment_type: "review_note",
    });

    return { ok: true, annotations };
  });

export const deleteDocumentAnnotation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ document_id: z.string().uuid(), index: z.number().int().min(0) }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { data: doc } = await sb.from("legal_matter_documents").select("ai_review").eq("id", data.document_id).single();
    const review = doc?.ai_review ?? {};
    if (Array.isArray(review.annotations) && review.annotations[data.index]) {
      review.annotations.splice(data.index, 1);
      await sb.from("legal_matter_documents").update({ ai_review: review }).eq("id", data.document_id);
    }
    return { ok: true };
  });

// Delete a document / version. Removes the row + best-effort the storage object.
// Deleting an original with derived versions re-parents them (parent set null),
// so nothing is silently orphaned mid-cascade.
export const deleteLegalDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ document_id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: doc } = await sb
      .from("legal_matter_documents")
      .select("matter_id, file_name, file_url, version")
      .eq("id", data.document_id)
      .single();
    if (!doc) throw new Error("Document not found");

    // Best-effort: remove the underlying storage object (public bucket key).
    try {
      const after = String(doc.file_url ?? "").split("/policies/")[1];
      const key = after ? decodeURIComponent(after.split("?")[0]) : "";
      if (key) await sb.storage.from("policies").remove([key]);
    } catch (e) {
      console.error("[legal] storage remove failed:", e);
    }

    const { error } = await sb.from("legal_matter_documents").delete().eq("id", data.document_id);
    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id:  doc.matter_id,
      event_type: "document_deleted",
      actor_id:   userId,
      actor_name: userEmail ?? "User",
      payload:    { file_name: doc.file_name, version: doc.version },
    });
    return { ok: true };
  });

// Generate a NEW document version from the accepted AI Co-Pilot suggestions.
// For DOCX sources the accepted redlines are applied into the real Word file
// (highlighted); for other sources an amended .doc is generated from the
// extracted text. The new row is version N+1, linked to the original (which
// keeps its "Original" tag as version 1).
export const createAmendedVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ document_id: z.string().uuid(), note: z.string().optional() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: doc, error } = await sb
      .from("legal_matter_documents").select("*").eq("id", data.document_id).single();
    if (error || !doc) throw new Error(error?.message ?? "Document not found");
    if (!doc.file_url) throw new Error("This document is restricted — cannot generate a version.");

    const review = doc.ai_review;
    const accepted = (review?.clauses ?? []).filter((c: any) => c.accepted && c.suggestion);
    if (accepted.length === 0) throw new Error("Accept at least one AI suggestion before generating a version.");

    // Version group: the original is the row with no parent; derived versions
    // point at it. Next version = max in the group + 1.
    const rootId = doc.parent_document_id ?? doc.id;
    const { data: group } = await sb
      .from("legal_matter_documents")
      .select("version")
      .or(`id.eq.${rootId},parent_document_id.eq.${rootId}`);
    const nextVersion = Math.max(1, ...(group ?? []).map((g: any) => Number(g.version) || 1)) + 1;

    // Source text: prefer text already extracted on the review; otherwise pull it
    // from the source file (DOCX / PDF / plain text). We work at the text level so
    // the amended draft is both viewable in-app and correct.
    let sourceText = String(review?.documentText ?? "");
    if (!sourceText.trim()) {
      const resp = await fetch(doc.file_url);
      if (!resp.ok) throw new Error(`Could not fetch source document (${resp.status})`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      const mime = doc.mime_type || resp.headers.get("content-type") || "";
      if (looksLikeDocx(mime, doc.file_name)) {
        sourceText = await docxToText(buffer);
      } else if (mime.includes("pdf") || /\.pdf($|\?)/i.test(doc.file_name)) {
        const pages = await extractPdfPages(buffer);
        sourceText = pages.map((pg) => pg.text).filter(Boolean).join("\n\n");
      } else {
        sourceText = buffer.toString("utf8");
      }
    }
    if (!sourceText.trim()) throw new Error("Could not read the document text to apply changes.");

    // Apply the accepted suggestions as a REDLINE: the old term is struck through
    // and the new term inserted, so the amended draft shows exactly what changed.
    // Four control-char markers delimit deletions and insertions.
    const DEL_O = String.fromCharCode(1), DEL_C = String.fromCharCode(2);
    const INS_O = String.fromCharCode(3), INS_C = String.fromCharCode(4);
    // Locate each accepted clause with a whitespace/quote-insensitive match against a
    // normalized copy of the source, then map back to the EXACT original span, so the
    // redline replaces the clause in place instead of appending it at the bottom.
    const { norm, map } = buildNormMap(sourceText);
    let normMut = norm;
    type Span = { start: number; end: number; before: string; after: string; comment: string; category: any; ref: string };
    const spans: Span[] = [];
    const unmatched: any[] = [];
    for (const c of accepted) {
      const suggestion = String(c.suggestion ?? "").trim();
      const ne = normStr(String(c.excerpt ?? ""));
      const found = locateClauseSpan(normMut, map, ne);
      if (found) {
        spans.push({ start: found.origStart, end: found.origEnd, before: sourceText.slice(found.origStart, found.origEnd), after: suggestion, comment: String(c.comment ?? "").trim(), category: c.category ?? null, ref: c.ref });
        // blank the matched NORM region (same length) so a later clause can't re-match it
        normMut = normMut.slice(0, found.normStart) + " ".repeat(found.normEnd - found.normStart) + normMut.slice(found.normEnd);
      } else {
        unmatched.push(c);
      }
    }

    // Apply located replacements right-to-left so earlier offsets don't shift.
    let redline = sourceText;
    for (const sp of [...spans].sort((a, b) => b.start - a.start)) {
      redline = redline.slice(0, sp.start) + DEL_O + sp.before + DEL_C + INS_O + sp.after + INS_C + redline.slice(sp.end);
    }

    // Change history in DOCUMENT order (located first, then any that had to be appended).
    const located = [...spans].sort((a, b) => a.start - b.start);
    const changes: any[] = located.map((sp) => ({ ref: sp.ref, before: sp.before, after: sp.after, comment: sp.comment, category: sp.category, located: true }));
    for (const c of unmatched) {
      changes.push({ ref: c.ref, before: String(c.excerpt ?? "").trim(), after: String(c.suggestion ?? "").trim(), comment: String(c.comment ?? "").trim(), category: c.category ?? null, located: false });
    }
    const appliedCount = located.length;
    const unmatchedCount = unmatched.length;
    const appliedClauses: any[] = changes.map((ch) => ({
      ref: ch.ref, excerpt: ch.after, severity: ch.located ? "compliant" : "caution", category: ch.category,
      comment: ch.located ? `New term (replaced: "${String(ch.before).slice(0, 120)}")` : "Appended (could not be located inline).",
      suggestion: "", accepted: true,
    }));
    if (unmatchedCount) {
      redline += "\n\n--- ADDITIONAL ACCEPTED AMENDMENTS ---\n" +
        unmatched.map((c) => INS_O + `${c.ref}: ${String(c.suggestion ?? "").trim()}` + INS_C).join("\n");
    }

    // Clean amended text (deletions removed, insertions kept) — used for the clean
    // view and for re-analysis of the draft.
    const amendedPlain = redline
      .replace(new RegExp(DEL_O + "[\\s\\S]*?" + DEL_C, "g"), "")
      .split(INS_O).join("").split(INS_C).join("");

    // Downloadable .doc rendered as a redline (strikethrough old / highlighted new).
    const baseName = String(doc.file_name).replace(/\.(docx?|pdf|txt)$/i, "").replace(/^v\d+\s*[—-]\s*/, "");
    const bodyHtml = escHtml(redline)
      .split(DEL_O).join('<del style="color:#b91c1c;background:#fee2e2">')
      .split(DEL_C).join("</del>")
      .split(INS_O).join('<ins style="color:#065f46;background:#d1fae5;text-decoration:none;font-weight:bold">')
      .split(INS_C).join("</ins>")
      .replace(/\n/g, "<br>");
    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>
<head><meta charset="utf-8"><title>Amended draft v${nextVersion}</title>
<style>body{font-family:'Times New Roman',serif;font-size:11pt;line-height:1.5;margin:2.5cm}.notice{font-size:9pt;color:#555;border:1px solid #999;padding:8pt;margin-bottom:18pt}del{color:#b91c1c}ins{color:#065f46;text-decoration:none}</style></head>
<body><div class="notice">AMENDED DRAFT v${nextVersion} (redline) — AI review suggestions applied. Struck-through = removed, highlighted = new term. Derived from "${escHtml(baseName)}". Review before execution.</div>
<div>${bodyHtml}</div></body></html>`;
    const outBuffer = Buffer.from(html, "utf8");
    const outMime = "application/msword";
    const ext = "doc";

    // Upload with a safe storage key; keep a human file name for display.
    const path = `legal/${Date.now()}-v${nextVersion}-amended.${ext}`;
    const up = await sb.storage.from("policies").upload(path, outBuffer, { upsert: false, contentType: outMime });
    if (up.error) throw new Error(`Upload failed: ${up.error.message}`);
    const fileUrl = sb.storage.from("policies").getPublicUrl(path).data.publicUrl;

    // Synthetic review so the amended draft opens in the viewer with the redline +
    // change history visible, without needing to re-run analysis.
    const newReview = {
      documentText: amendedPlain.slice(0, 200_000),
      redlineText: redline.slice(0, 250_000),
      changes,
      clauses: appliedClauses,
      verdict: unmatchedCount ? "caution" : "compliant",
      riskScore: 0,
      exposure: { financial: "low", regulatory: "low", operational: "low", reputational: "low" },
      summary: `Amended draft — ${appliedCount} change${appliedCount !== 1 ? "s" : ""} applied from the AI review${unmatchedCount ? `; ${unmatchedCount} appended for manual placement` : ""}. Re-run analysis to re-assess risk.`,
      amendedFrom: doc.file_name,
    };

    const { data: newDoc, error: insErr } = await sb
      .from("legal_matter_documents")
      .insert({
        matter_id:          doc.matter_id,
        file_name:          `v${nextVersion} — ${baseName}.${ext}`,
        file_url:           fileUrl,
        mime_type:          outMime,
        size_bytes:         outBuffer.length,
        doc_role:           "draft",
        version:            nextVersion,
        parent_document_id: rootId,
        version_note:       data.note?.trim() || `Amended from AI review — ${appliedCount} suggestion${appliedCount !== 1 ? "s" : ""} applied`,
        ai_review:          newReview,
        ai_review_status:   "done",
        ai_reviewed_at:     new Date().toISOString(),
        uploaded_by:        userId,
        uploaded_by_name:   userEmail ?? "Legal",
      })
      .select()
      .single();
    if (insErr) throw new Error(insErr.message);

    await logEvent(sb, {
      matter_id:  doc.matter_id,
      event_type: "version_created",
      actor_id:   userId,
      actor_name: userEmail ?? "Legal",
      payload:    { version: nextVersion, applied: appliedCount, from: doc.file_name },
    });

    return newDoc as any;
  });

// ===========================================================================
// CLUSTER 2 — Route D advisory suite
// ===========================================================================

// AI-proposed response/solution for the legal manager, drawn from the policy
// library + published knowledge base + historical precedents (similar matters).
export const generateProposedResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ matter_id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;

    const { data: m, error } = await sb
      .from("legal_matters")
      .select("id, title, description, matter_type")
      .eq("id", data.matter_id)
      .single();
    if (error || !m) throw new Error(error?.message ?? "Matter not found");

    // Historical precedent matching — surface similar prior matters.
    const { data: priors } = await sb
      .from("legal_matters")
      .select("reference_number, title, ai_response, ai_executive_summary")
      .in("status", ["resolved", "approved", "archived"])
      .neq("id", m.id)
      .limit(20);

    const { data: kb } = await sb
      .from("legal_kb_entries")
      .select("title, takeaways")
      .limit(12);

    const precedentBlock = (priors ?? []).length
      ? `\n\nHISTORICAL PRECEDENTS (prior matters — maintain a consistent position):\n${(priors ?? [])
          .map((p: any) => `- ${p.reference_number} "${p.title}": ${(p.ai_executive_summary || p.ai_response || "").slice(0, 300)}`)
          .join("\n")}`
      : "";
    const kbBlock = (kb ?? []).length
      ? `\n\nKNOWLEDGE BASE (signed-off positions):\n${(kb ?? []).map((e: any) => `- ${e.title}: ${e.takeaways}`).join("\n")}`
      : "";

    const prompt = `You are senior legal counsel AI for the Company — a Malaysian financial institution (also reused by other industries). Prepare a proposed advisory response for a legal manager to review, grounded in Malaysian law (Contracts Act 1950, PDPA 2010, Companies Act 2016; for financial services BNM policy, FSA 2013 / IFSA 2013, AMLA 2001) plus the knowledge base and precedents below.

MATTER: ${m.title}
DETAILS: ${m.description}${kbBlock}${precedentBlock}

Return ONLY valid JSON:
{
  "keyIssues": ["issue 1", "issue 2", ...],
  "proposedResponse": "the drafted advisory response (3-6 paragraphs) the legal manager can edit and send",
  "precedentsUsed": ["reference numbers actually relied on, if any"],
  "openQuestions": ["anything needing the manager's input"]
}`;

    const res = await generateWithFallback(
      { contents: [{ role: "user", parts: [{ text: prompt }] }], config: { responseMimeType: "application/json", maxOutputTokens: 8192 } },
      { tier: "quality" }
    );
    const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    let parsed: any;
    try {
      parsed = match ? JSON.parse(match[0]) : { proposedResponse: text };
    } catch {
      // Malformed model output — fall back to the raw text rather than 500.
      parsed = { proposedResponse: text };
    }

    const composed = [
      parsed.keyIssues?.length ? `Key issues:\n${parsed.keyIssues.map((i: string) => `• ${i}`).join("\n")}` : "",
      parsed.proposedResponse ?? "",
      parsed.precedentsUsed?.length ? `\nPrecedents relied on: ${parsed.precedentsUsed.join(", ")}` : "",
      parsed.openQuestions?.length ? `\nOpen questions for you:\n${parsed.openQuestions.map((q: string) => `• ${q}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");

    await sb.from("legal_matters").update({ ai_response: composed }).eq("id", data.matter_id);
    await logEvent(sb, {
      matter_id:  data.matter_id,
      event_type: "ai_response_generated",
      actor_name: "AI Advisory Engine",
      payload:    { precedents: parsed.precedentsUsed ?? [] },
    });

    return { ok: true, response: composed };
  });

export const referToGeneralCounsel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ matter_id: z.string().uuid(), note: z.string().optional() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { error } = await sb
      .from("legal_matters")
      .update({ referred_to_gc: true, referred_to_gc_at: new Date().toISOString() })
      .eq("id", data.matter_id);
    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id:  data.matter_id,
      event_type: "referred_to_gc",
      actor_id:   userId,
      actor_name: userEmail ?? "Legal Manager",
      payload:    { note: data.note },
    });
    if (data.note) {
      await logComment(sb, {
        matter_id: data.matter_id, author_id: userId, author_name: userEmail ?? "Legal Manager",
        content: `Referred to General Counsel: ${data.note}`, comment_type: "review_note",
      });
    }
    return { ok: true };
  });

// Cross-functional collaboration — loop in Tax/Compliance/Risk/Finance. Their
// notes stay isolated to this matter file.
export const tagFunctions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    matter_id: z.string().uuid(),
    functions: z.array(z.string()).min(1),
  }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: cur } = await sb.from("legal_matters").select("tagged_functions").eq("id", data.matter_id).single();
    const existing: string[] = Array.isArray(cur?.tagged_functions) ? cur.tagged_functions : [];
    const merged = Array.from(new Set([...existing, ...data.functions]));

    const { error } = await sb.from("legal_matters").update({ tagged_functions: merged }).eq("id", data.matter_id);
    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id: data.matter_id, event_type: "functions_tagged",
      actor_id: userId, actor_name: userEmail ?? "Legal Manager",
      payload: { functions: data.functions },
    });
    return { ok: true, tagged_functions: merged };
  });

// Publish finalized Route D takeaways into the Route C knowledge base.
export const publishToKnowledgeBase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    matter_id:   z.string().uuid(),
    title:       z.string().min(3),
    takeaways:   z.string().min(10),
  }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: m } = await sb.from("legal_matters").select("entity_code, reference_number, status").eq("id", data.matter_id).single();
    if (!m) throw new Error("Matter not found");
    // Spec: takeaways enter the KB only after the matter is signed off (approved).
    if (m.status !== "approved") {
      throw new Error("Publish to the knowledge base only after the matter is approved / signed off.");
    }

    const { data: entry, error } = await sb
      .from("legal_kb_entries")
      .insert({
        entity_code:  DEFAULT_ORG,
        title:        data.title,
        takeaways:    data.takeaways,
        source_matter_id: data.matter_id,
        source_reference: m.reference_number ?? null,
        published_by: userId,
        published_by_name: userEmail ?? "Legal",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id: data.matter_id, event_type: "kb_published",
      actor_id: userId, actor_name: userEmail ?? "Legal",
      payload: { title: data.title },
    });
    return entry;
  });

export const listKnowledgeBase = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = context.supabase as any;
    const { data: rows, error } = await sb.from("legal_kb_entries").select("*").order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// Seed the starter knowledge base (Malaysian banking + cross-industry positions).
// Idempotent: inserts only the seed titles not already present.
export const seedKnowledgeBase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = context.supabase as any;
    const { userEmail } = actor(context);

    const { data: existing } = await sb.from("legal_kb_entries").select("title");
    const have = new Set((existing ?? []).map((e: any) => e.title));
    const toInsert = LEGAL_KB_SEED.filter((e) => !have.has(e.title)).map((e) => ({
      entity_code:       DEFAULT_ORG,
      title:             e.title,
      takeaways:         `[${e.category}] ${e.takeaways}`,
      source_reference:  "STARTER-KB",
      published_by_name: userEmail ?? "Legal (seed)",
    }));

    if (toInsert.length === 0) return { inserted: 0, total: have.size };

    const { error } = await sb.from("legal_kb_entries").insert(toInsert);
    if (error) throw new Error(error.message);
    return { inserted: toInsert.length, total: have.size + toInsert.length };
  });

// ===========================================================================
// CLUSTER 3 — Step 6 lifecycle + repository
// ===========================================================================

export const setMatterLifecycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    matter_id:       z.string().uuid(),
    expiry_date:     z.string().optional(),      // contract expiry / renewal date
    retention_years: z.number().int().min(1).max(30).optional(),
  }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const update: any = {};
    if (data.expiry_date) update.expiry_date = data.expiry_date;
    if (data.retention_years) {
      const base = new Date(); // retention runs from now (archival)
      const until = new Date(base);
      until.setFullYear(until.getFullYear() + data.retention_years);
      update.retention_until = until.toISOString();
      update.destroy_after = until.toISOString();
    }
    const { error } = await sb.from("legal_matters").update(update).eq("id", data.matter_id);
    if (error) throw new Error(error.message);
    return { ok: true, ...update };
  });

// Lifecycle alerts — matters approaching expiry/renewal or past retention (for
// the expiry tracker + destruction prompts). Windowed client-side after fetch.
export const listLifecycleAlerts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = context.supabase as any;
    const { data: rows, error } = await sb
      .from("legal_matters")
      .select("id, reference_number, title, entity_code, expiry_date, retention_until, destroy_after, status")
      .eq("workspace_id", "legal")
      .or("expiry_date.not.is.null,destroy_after.not.is.null");
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// Post-execution AI knowledge agent — reasons over the vault (resolved/approved/
// archived matters) + published KB to answer recurring practical queries.
export const vaultKnowledgeSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ query: z.string().min(3) }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;

    const mq = sb
      .from("legal_matters")
      .select("reference_number, title, description, ai_response, ai_executive_summary, matter_type")
      .eq("workspace_id", "legal")
      .in("status", ["resolved", "approved", "archived"])
      .limit(40);

    const kq = sb.from("legal_kb_entries").select("title, takeaways, source_reference");

    const [{ data: matters }, { data: kb }] = await Promise.all([mq, kq]);

    const corpus = [
      ...(kb ?? []).map((e: any) => `[KB ${e.source_reference ?? ""}] ${e.title}: ${e.takeaways}`),
      ...(matters ?? []).map((m: any) => `[${m.reference_number} · ${m.matter_type}] ${m.title}: ${(m.ai_executive_summary || m.ai_response || m.description || "").slice(0, 400)}`),
    ].join("\n\n");

    if (!corpus.trim()) {
      return { answer: "The vault has no executed matters or knowledge base entries yet to reason over.", citations: [] };
    }

    const prompt = `You are the Company's post-execution Legal Knowledge Agent. Answer the query using ONLY the repository below (executed matters + knowledge base). Cite the reference numbers you rely on. If the repository doesn't cover it, say so and suggest opening a new matter.

REPOSITORY:
${corpus.slice(0, 120_000)}

QUERY: ${data.query}

Return ONLY valid JSON: {"answer": "...", "citations": ["reference numbers cited"]}`;

    const res = await generateWithFallback(
      { contents: [{ role: "user", parts: [{ text: prompt }] }], config: { responseMimeType: "application/json", maxOutputTokens: 4096 } },
      { tier: "quality" }
    );
    const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    try {
      const parsed = JSON.parse(match ? match[0] : text);
      return { answer: parsed.answer ?? text, citations: parsed.citations ?? [] };
    } catch {
      return { answer: text || "No answer.", citations: [] };
    }
  });

// ===========================================================================
// CLUSTER 4 — collaboration + external
// ===========================================================================

export const updateExecSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ matter_id: z.string().uuid(), summary: z.string() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { error } = await sb
      .from("legal_matters")
      .update({ ai_executive_summary: data.summary })
      .eq("id", data.matter_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const shareWithCounterparty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    matter_id:       z.string().uuid(),
    recipient_name:  z.string(),
    recipient_email: z.string().email(),
    document_ids:    z.array(z.string().uuid()).min(1),
    message:         z.string().optional(),
  }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { userId, userEmail } = actor(context);

    const { data: docs } = await sb
      .from("legal_matter_documents")
      .select("file_name")
      .in("id", data.document_ids);

    const { data: share, error } = await sb
      .from("legal_matter_shares")
      .insert({
        matter_id:       data.matter_id,
        recipient_name:  data.recipient_name,
        recipient_email: data.recipient_email,
        document_ids:    data.document_ids,
        document_names:  (docs ?? []).map((d: any) => d.file_name),
        message:         data.message ?? null,
        sent_by:         userId,
        sent_by_name:    userEmail ?? "User",
        sent_at:         new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await logEvent(sb, {
      matter_id:  data.matter_id,
      event_type: "shared_external",
      actor_id:   userId,
      actor_name: userEmail ?? "User",
      payload:    { recipient: data.recipient_email, docs: (docs ?? []).length },
    });
    return share;
  });

// Simulate the counterparty opening/downloading the shared package (tracked
// interaction loop). In production this is fired by the access-controlled link.
export const recordShareDownload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ share_id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase as any;
    const { data: share } = await sb.from("legal_matter_shares").select("matter_id, recipient_name").eq("id", data.share_id).single();
    const { error } = await sb
      .from("legal_matter_shares")
      .update({ downloaded_at: new Date().toISOString() })
      .eq("id", data.share_id);
    if (error) throw new Error(error.message);
    if (share?.matter_id) {
      await logEvent(sb, {
        matter_id:  share.matter_id,
        event_type: "share_downloaded",
        actor_name: share.recipient_name ?? "Counterparty",
        payload:    { share_id: data.share_id },
      });
    }
    return { ok: true };
  });
