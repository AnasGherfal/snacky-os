import { AppRole } from "@/lib/authz";

export const tempPasswordCookie = "snacky-temp-password";

export const roleDescriptions: Record<AppRole, string> = {
  owner: "Full system access, company settings, users, operations, financials, and review.",
  admin: "Manages daily operations, master data, routes, users, inventory, and review screens.",
  supervisor: "Oversees routes, operators, refills, inventory visibility, issues, and cash review.",
  operator: "Uses the mobile workflow for assigned routes only. No costs, profit, or admin pages.",
  warehouse: "Works with products and storage inventory without access to financial or admin controls.",
  finance: "Reviews sales, cash collections, variance, and machine financial performance.",
  viewer: "Read-only dashboard access for basic operational visibility.",
};

export function formatLastLogin(value: string | null | undefined) {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
