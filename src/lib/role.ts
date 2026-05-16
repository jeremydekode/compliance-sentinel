import { useEffect, useState } from "react";

export type UserRole = "compliance" | "legal";

export const ROLE_META: Record<UserRole, { label: string; short: string; color: string }> = {
  compliance: { label: "Compliance Officer", short: "Compliance", color: "text-blue-700" },
  legal:      { label: "Head of Legal",       short: "Legal",      color: "text-violet-700" },
};

const STORAGE_KEY = "user_role";
const listeners = new Set<(r: UserRole) => void>();
let currentRole: UserRole = "compliance";

if (typeof window !== "undefined") {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "compliance" || stored === "legal") currentRole = stored;
}

export function setRole(role: UserRole) {
  currentRole = role;
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, role);
  listeners.forEach((l) => l(role));
}

export function getRole(): UserRole {
  return currentRole;
}

export function useRole(): [UserRole, (r: UserRole) => void] {
  const [role, setLocal] = useState<UserRole>(currentRole);
  useEffect(() => {
    const cb = (r: UserRole) => setLocal(r);
    listeners.add(cb);
    setLocal(currentRole);
    return () => { listeners.delete(cb); };
  }, []);
  return [role, setRole];
}
