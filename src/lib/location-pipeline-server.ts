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

function errorTextValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function extractMissingRelation(message: string) {
  const relationMatch = message.match(/relation ["']?(?:public\.)?([a-z0-9_]+)["']? does not exist/i);
  if (relationMatch) return relationMatch[1] ?? null;

  const tableMatch = message.match(/table ["']?(?:public\.)?([a-z0-9_]+)["']?/i);
  return tableMatch?.[1] ?? null;
}

function extractMissingColumn(message: string) {
  const columnMatch = message.match(/column ["']?([a-z0-9_]+)["']?/i);
  return columnMatch?.[1] ?? null;
}

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
  const message = errorTextValue(payload?.message) || String(error ?? "Unknown Supabase error");
  const details = errorTextValue(payload?.details);
  const hint = errorTextValue(payload?.hint);
  const combined = [message, details, hint].filter(Boolean).join(" ");
  const missingRelation = extractMissingRelation(combined);
  const missingColumn = extractMissingColumn(combined);
  const lowerCombined = combined.toLowerCase();

  return {
    code: typeof payload?.code === "string" ? payload.code : null,
    message,
    details: details || null,
    hint: hint || null,
    missing_relation: missingRelation,
    missing_column: missingColumn,
    possible_rls_blocked:
      payload?.code === "42501"
      || lowerCombined.includes("permission denied")
      || lowerCombined.includes("row-level security"),
  };
}

export function locationPipelineLoadFailureBody(error: unknown, noun = "location leads") {
  const payload = locationPipelineErrorPayload(error);
  if (payload.missing_relation) {
    return `Snacky OS could not load ${noun} because database table public.${payload.missing_relation} is missing. Run migration 202606170002_emergency_stabilization_location_leads_payroll.sql.`;
  }
  if (payload.missing_column) {
    return `Snacky OS could not load ${noun} because a required database column (${payload.missing_column}) is missing. Run migration 202606170002_emergency_stabilization_location_leads_payroll.sql.`;
  }
  if (payload.possible_rls_blocked) {
    return `Snacky OS could not load ${noun} because database permissions blocked the query.`;
  }
  return `Snacky OS could not load ${noun} right now.`;
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
