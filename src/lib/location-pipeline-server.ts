import "server-only";

import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canManageLocationPipeline } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export type LocationPipelineContactUser = {
  id: string;
  full_name: string;
  role: string | null;
};

export async function requireLocationPipelineAccess(pathname: string) {
  const profile = await getCurrentProfile();
  if (!profile || !canManageLocationPipeline(profile)) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    throw new Error(`Supabase is not configured for ${pathname}.`);
  }

  return { profile, supabase };
}

export async function loadLocationPipelineContactUsers() {
  const admin = getSupabaseAdminClient();
  if (!admin) return [] as LocationPipelineContactUser[];

  const { data, error } = await admin.from("team_members").select("id, full_name, role").order("full_name");
  if (error) {
    console.error("[locations-pipeline] Failed to load contact users", error);
    return [] as LocationPipelineContactUser[];
  }

  return (data ?? []) as LocationPipelineContactUser[];
}
