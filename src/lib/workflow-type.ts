// ----------------------------------------------------------------------------
// Workflow-type discrimination + per-type UI copy.
//
// A report's workflow is one of three flavours. We resolve it defensively from
// either the top-level `workflow_type` column (the canonical source, set by the
// policy-change server fn) or, for older rows, from flags inside summary_json:
//   - policy_change : explicit workflow_type === "policy_change"
//   - form_update   : legacy UC1 rows flagged via summary_json.uc1_form_update
//   - regulatory    : the default for everything else
//
// The copy maps drive the stage headings / CTA labels in the approval workflow
// so a policy-change report reads "Policy Review" / "Approve & Apply" while the
// regulatory flow keeps its original wording.
// ----------------------------------------------------------------------------

export type WorkflowType = "regulatory" | "form_update" | "policy_change";

export function workflowTypeOf(report: any): WorkflowType {
  if (report?.workflow_type === "policy_change") return "policy_change";
  const s = report?.summary_json ?? report?.summary ?? {};
  if (s?.workflow_type === "policy_change") return "policy_change";
  if (s?.uc1_form_update) return "form_update";
  return (report?.workflow_type as WorkflowType) || "regulatory";
}

const DEFAULT_COPY = {
  phaseA: "Compliance Review",
  submitCta: "Submit to Legal",
  legal: "Awaiting Legal Sign-Off",
  exec: "Approve & Publish",
};

const POLICY_CHANGE_COPY = {
  phaseA: "Policy Review",
  submitCta: "Submit Policy to Legal",
  legal: "Awaiting Legal Sign-Off",
  exec: "Approve & Apply",
};

export function workflowCopy(t: WorkflowType) {
  return t === "policy_change" ? POLICY_CHANGE_COPY : DEFAULT_COPY;
}
