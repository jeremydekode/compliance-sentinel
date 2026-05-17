import { useEffect, useState } from "react";

export type WorkspaceId = "rmit" | "fatf" | "forms";

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
};

const STORAGE_KEY = "workspace_id";
const listeners = new Set<(w: WorkspaceId) => void>();
let currentWorkspace: WorkspaceId = "rmit";

if (typeof window !== "undefined") {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "rmit" || stored === "fatf") currentWorkspace = stored;
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
