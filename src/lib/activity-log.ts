"use server";

import { headers } from "next/headers";
import { UserProfile } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type ActivityInput = {
  profile?: UserProfile | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: Record<string, unknown> | null;
  summary?: string | null;
};

const sensitiveKeyPattern = /password|secret|token|apikey|api_key|service_role|authorization|cookie/i;
const sensitiveTextPattern =
  /(password|temporary password|secret|api[_ -]?key|service[_ -]?role|authorization|bearer|refresh[_ -]?token|access[_ -]?token)\s*[:=]\s*["']?[^"',\s}]+/gi;

function scrubText(value: string) {
  return value.replace(sensitiveTextPattern, "$1=[redacted]");
}

function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[redacted]" : sanitize(nestedValue),
      ]),
    );
  }
  return value;
}

export async function logActivity(input: ActivityInput) {
  const supabase = getSupabaseServerClient();
  if (!supabase) return;

  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get("x-forwarded-for");
  const ipAddress = forwardedFor?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip");

  const { error } = await supabase.from("system_activity_logs").insert({
    actor_user_id: input.profile?.id ?? null,
    actor_team_member_id: input.profile?.team_member_id ?? null,
    actor_name: input.profile?.full_name ?? null,
    actor_role: input.profile?.role ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    entity_label: input.entityLabel ? scrubText(input.entityLabel) : null,
    before_data: sanitize(input.beforeData) ?? null,
    after_data: sanitize(input.afterData) ?? null,
    metadata: sanitize(input.metadata ?? {}) ?? {},
    ip_address: ipAddress ?? null,
    user_agent: requestHeaders.get("user-agent"),
    summary: input.summary ? scrubText(input.summary) : null,
  });

  if (error) {
    console.error("[activity-log] Failed to write activity log", error);
  }
}
