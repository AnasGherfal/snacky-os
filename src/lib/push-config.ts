import "server-only";
import { type SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export type PushConfigSource = "environment" | "database";

type PushConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

export type PushConfigResult =
  | { configured: true; config: PushConfig; source: PushConfigSource }
  | { configured: false; reason: string };

const DEFAULT_SUBJECT = "mailto:notifications@snacky.ly";
let configuredFingerprint = "";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return clean(error);
  const row = error as Record<string, unknown>;
  return [row.code, row.message, row.details, row.hint].map(clean).filter(Boolean).join(" ");
}

function environmentConfig(): PushConfig | null {
  const subject = clean(process.env.VAPID_SUBJECT);
  const publicKey = clean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const privateKey = clean(process.env.VAPID_PRIVATE_KEY);
  return subject && publicKey && privateKey ? { subject, publicKey, privateKey } : null;
}

async function readStoredConfig(client: SupabaseClient): Promise<PushConfigResult> {
  const { data, error } = await client
    .from("push_notification_config")
    .select("public_key, private_key, subject")
    .eq("singleton", true)
    .maybeSingle<{ public_key: string; private_key: string; subject: string }>();

  if (error) {
    const text = errorText(error).toLowerCase();
    return {
      configured: false,
      reason: text.includes("push_notification_config") || text.includes("pgrst205")
        ? "migration_required"
        : text || "config_load_failed",
    };
  }

  const subject = clean(data?.subject);
  const publicKey = clean(data?.public_key);
  const privateKey = clean(data?.private_key);
  return subject && publicKey && privateKey
    ? { configured: true, config: { subject, publicKey, privateKey }, source: "database" }
    : { configured: false, reason: "config_missing" };
}

async function createStoredConfig(client: SupabaseClient): Promise<PushConfigResult> {
  const keys = webpush.generateVAPIDKeys();
  const candidate: PushConfig = {
    subject: clean(process.env.VAPID_SUBJECT) || DEFAULT_SUBJECT,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };

  const { error } = await client.from("push_notification_config").upsert(
    {
      singleton: true,
      subject: candidate.subject,
      public_key: candidate.publicKey,
      private_key: candidate.privateKey,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "singleton" },
  );

  if (error) {
    const text = errorText(error).toLowerCase();
    return {
      configured: false,
      reason: text.includes("push_notification_config") || text.includes("pgrst205")
        ? "migration_required"
        : text || "config_create_failed",
    };
  }

  // Re-read the persisted row so simultaneous first requests always receive the same winning key pair.
  return readStoredConfig(client);
}

export async function ensurePushConfig(supabase?: SupabaseClient | null): Promise<PushConfigResult> {
  const fromEnvironment = environmentConfig();
  if (fromEnvironment) return { configured: true, config: fromEnvironment, source: "environment" };

  const client = getSupabaseAdminClient() ?? supabase ?? null;
  if (!client) return { configured: false, reason: "missing_service_role_client" };

  const stored = await readStoredConfig(client);
  if (stored.configured) return stored;
  if (stored.reason === "migration_required") return stored;
  return createStoredConfig(client);
}

export async function configureWebPush(supabase?: SupabaseClient | null) {
  const result = await ensurePushConfig(supabase);
  if (!result.configured) return result;

  const fingerprint = `${result.config.subject}:${result.config.publicKey}`;
  if (configuredFingerprint !== fingerprint) {
    webpush.setVapidDetails(result.config.subject, result.config.publicKey, result.config.privateKey);
    configuredFingerprint = fingerprint;
  }
  return result;
}
