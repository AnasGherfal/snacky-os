import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { getDefaultPathForRole } from "@/lib/authz";

export default async function Home() {
  const profile = await getCurrentProfile();
  redirect(profile ? getDefaultPathForRole(profile) : "/login");
}
