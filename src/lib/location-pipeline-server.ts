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

export function locationPipelineErrorPayload(error: unknown) {
  const payload = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } : null;
  return {
    code: typeof payload?.code === "string" ? payload.code : null,
    message: typeof payload?.message === "string" ? payload.message : String(error ?? "Unknown Supabase error"),
    details: typeof payload?.details === "string" ? payload.details : null,
    hint: typeof payload?.hint === "string" ? payload.hint : null,
  };
}

export function logLocationPipelineError({
  action,
  table,
  profile,
  error,
  extra,
}: {
  action: string;
  table: string;
  profile: Awaited<ReturnType<typeof getCurrentProfile>> | null | undefined;
  error: unknown;
  extra?: Record<string, unknown>;
}) {
  console.error(`[locations-pipeline] ${action}`, {
    table,
    current_user_id: profile?.id ?? null,
    current_user_role: profile?.role ?? null,
    current_user_roles: profile?.roles ?? [],
    current_team_member_id: profile?.team_member_id ?? null,
    supabase_error: locationPipelineErrorPayload(error),
    ...(extra ?? {}),
  });
}

export async function loadLocationPipelineContactUsers() {
  const admin = getSupabaseAdminClient();
  if (!admin) return [] as LocationPipelineContactUser[];

  const { data, error } = await admin.from("team_members").select("id, full_name, role").order("full_name");
  if (error) {
    logLocationPipelineError({
      action: "Failed to load contact users",
      table: "team_members",
      profile: null,
      error,
    });
    return [] as LocationPipelineContactUser[];
  }

  return (data ?? []) as LocationPipelineContactUser[];
}
