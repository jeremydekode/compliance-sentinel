import { useEffect, useState } from "react";

export type WorkspaceId = "rmit" | "fatf" | "forms" | "simplify" | "simplify_v2" | "layout" | "policy" | "credit_risk" | "credit_risk_demo";

export const WORKSPACES: Record<WorkspaceId, {
  id: WorkspaceId;
  name: string;
  short: string;
  tagline: string;
  color: string;
  bgColor: string;
}> = {
  rmit: {
    id: "rmit",
    name: "BNM RMiT",
    short: "RMiT",
    tagline: "Tech Risk · Cyber Resilience",
    color: "text-blue-700",
    bgColor: "bg-blue-100",
  },
  fatf: {
    id: "fatf",
    name: "FATF AML/CFT",
    short: "FATF",
    tagline: "AML · CFT · Sanctions",
    color: "text-emerald-700",
    bgColor: "bg-emerald-100",
  },
  forms: {
    id: "forms",
    name: "Internal Forms",
    short: "Forms",
    tagline: "Form metadata propagation · Cross-reference updates",
    color: "text-amber-700",
    bgColor: "bg-amber-100",
  },
  simplify: {
    id: "simplify",
    name: "Document Simplification",
    short: "Simplify",
    tagline: "Plain-English rewrite · Verifiable redline",
    color: "text-violet-700",
    bgColor: "bg-violet-100",
  },
  simplify_v2: {
    id: "simplify_v2",
    name: "Simplify v2",
    short: "Simplify v2",
    tagline: "Audit · Restructure · Simplify",
    color: "text-fuchsia-700",
    bgColor: "bg-fuchsia-100",
  },
  layout: {
    id: "layout",
    name: "Retail Layout Planner",
    short: "Layout",
    tagline: "Sketch → digital layout · Rules-based fixture placement",
    color: "text-orange-700",
    bgColor: "bg-orange-100",
  },
  policy: {
    id: "policy",
    name: "Policy Change",
    short: "Policy",
    tagline: "New policy adoption · Impact analysis & rollout",
    color: "text-rose-700",
    bgColor: "bg-rose-100",
  },
  credit_risk: {
    id: "credit_risk",
    name: "Credit Risk Alert",
    short: "Credit Risk",
    tagline: "Credit application screening · KB-referenced risk flags",
    color: "text-red-700",
    bgColor: "bg-red-100",
  },
  credit_risk_demo: {
    id: "credit_risk_demo",
    name: "Credit Risk Demo",
    short: "CR Demo",
    tagline: "Demo environment · Mocked data · Safe to show",
    color: "text-orange-700",
    bgColor: "bg-orange-100",
  },
};

const STORAGE_KEY = "workspace_id";
const listeners = new Set<(w: WorkspaceId) => void>();
let currentWorkspace: WorkspaceId = "rmit";

if (typeof window !== "undefined") {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && stored in WORKSPACES) currentWorkspace = stored as WorkspaceId;
}

export function setWorkspace(w: WorkspaceId) {
  currentWorkspace = w;
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, w);
  listeners.forEach((l) => l(w));
}

export function getWorkspace(): WorkspaceId {
  return currentWorkspace;
}

export function useWorkspace(): [WorkspaceId, (w: WorkspaceId) => void] {
  const [w, setLocal] = useState<WorkspaceId>(currentWorkspace);
  useEffect(() => {
    const cb = (v: WorkspaceId) => setLocal(v);
    listeners.add(cb);
    setLocal(currentWorkspace);
    return () => { listeners.delete(cb); };
  }, []);
  return [w, setWorkspace];
}
