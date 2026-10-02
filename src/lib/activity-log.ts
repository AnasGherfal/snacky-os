"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { UserProfile } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

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
  idempotencyKey?: string | null;
};

const sensitiveKeyPattern =
  /password|secret|token|api[_-]?key|apikey|service[_-]?role|authorization|cookie|private[_-]?key|client[_-]?secret|credential|session|jwt/i;
const sensitiveAssignmentPattern =
  /(temporary[_ -]?password|password|supabase[_ -]?service[_ -]?role[_ -]?key|service[_ -]?role[_ -]?key|service[_ -]?role|client[_ -]?secret|private[_ -]?key|secret|api[_ -]?key|authorization|refresh[_ -]?token|access[_ -]?token|token|jwt|session)\s*[:=]\s*["']?[^"',\s}]+/gi;
const bearerTokenPattern = /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi;

function scrubText(value: string) {
  return value.replace(sensitiveAssignmentPattern, "$1=[redacted]").replace(bearerTokenPattern, "$1 [redacted]");
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

function stableActivityLogId(idempotencyKey: string) {
  const hex = createHash("sha256")
    .update(`snacky-system-activity-log:${idempotencyKey}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export async function logActivity(input: ActivityInput) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return;

  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get("x-forwarded-for");
  const ipAddress = forwardedFor?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip");

  const idempotencyKey = String(input.idempotencyKey ?? "").trim();
  const activityId = idempotencyKey ? stableActivityLogId(idempotencyKey) : null;
  const payload = {
    ...(activityId ? { id: activityId } : {}),
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
  };
  const { error } = activityId
    ? await supabase.from("system_activity_logs").upsert(payload, { onConflict: "id", ignoreDuplicates: true })
    : await supabase.from("system_activity_logs").insert(payload);

  if (error) {
    console.error("[activity-log] Failed to write activity log", error);
  }
}
