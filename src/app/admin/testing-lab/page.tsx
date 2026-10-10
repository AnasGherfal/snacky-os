import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import TestingLabClient from "./TestingLabClient";

export const dynamic = "force-dynamic";

/** Private, side-effect-free operational test area. No production route is created. */
export default async function OwnerTestingLabPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.active_status !== "active" || !hasRole(profile, "owner")) redirect("/unauthorized");
  return <TestingLabClient />;
}
