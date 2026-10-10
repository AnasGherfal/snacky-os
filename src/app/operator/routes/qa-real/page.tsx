import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { hasRole } from "@/lib/authz";
import { RealMachineRouteLoader } from "@/components/testing-lab/RealMachineRouteLoader";

export const dynamic = "force-dynamic";

/** Route-format QA with real machine/SKU snapshots, never any production writes. */
export default async function OwnerRealMachineQaRoutePage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasRole(profile, "owner")) {
    redirect("/unauthorized");
  }
  return <RealMachineRouteLoader />;
}
