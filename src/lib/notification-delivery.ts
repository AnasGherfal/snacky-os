import "server-only";
import { type SupabaseClient } from "@supabase/supabase-js";
import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

type RouteAssignmentNotificationInput = {
  routeId: string;
  routeDate: string;
  operatorTeamMemberId: string | null;
  stopCount?: number | null;
  assignedBy?: string | null;
};

type PushSubscriptionRecord = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  device_label: string | null;
  is_active: boolean;
};

type NotificationSummary = {
  id: string;
  type: string;
  title: string;
  message: string;
  action_url: string | null;
  related_route_id: string | null;
  read_at: string | null;
  created_at: string;
};

type NotificationPayload = {
  type: string;
  title: string;
  body: string;
  url: string;
  routeId: string;
  routeDate: string;
  assignedBy: string | null;
};

type PushSubscriptionInput = {
  endpoint?: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  expirationTime?: number | null;
};

let vapidConfigured = false;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown) {
  const text = cleanText(value);
  return text || null;
}

function shortErrorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
  return [row.code, row.message, row.details, row.hint]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");
}

function getVapidConfig() {
  const subject = cleanText(process.env.VAPID_SUBJECT);
  const publicKey = cleanText(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const privateKey = cleanText(process.env.VAPID_PRIVATE_KEY);

  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

function ensureWebPushConfigured() {
  const vapid = getVapidConfig();
  if (!vapid) return null;
  if (!vapidConfigured) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    vapidConfigured = true;
  }
  return vapid;
}

async function resolveRecipientUserId(
  supabase: NonNullable<SupabaseClient>,
  operatorTeamMemberId: string,
): Promise<string | null> {
  const profileResult = await supabase.from("profiles").select("id").eq("team_member_id", operatorTeamMemberId).maybeSingle<{ id: string }>();
  if (profileResult.error) {
    console.warn("[notifications] Failed to resolve profile for team member", {
      team_member_id: operatorTeamMemberId,
      error: shortErrorText(profileResult.error),
    });
  }
  if (profileResult.data?.id) return profileResult.data.id;

  const teamMemberResult = await supabase.from("team_members").select("auth_user_id").eq("id", operatorTeamMemberId).maybeSingle<{ auth_user_id: string | null }>();
  if (teamMemberResult.error) {
    console.warn("[notifications] Failed to resolve auth user for team member", {
      team_member_id: operatorTeamMemberId,
      error: shortErrorText(teamMemberResult.error),
    });
  }

  return cleanText(teamMemberResult.data?.auth_user_id);
}

function buildRouteAssignmentPayload(input: {
  routeId: string;
  routeDate: string;
  assignedBy: string | null;
  stopCount: number | null;
}): NotificationPayload {
  const stopCount = Number.isFinite(Number(input.stopCount ?? 0)) ? Math.max(0, Math.floor(Number(input.stopCount ?? 0))) : 0;
  const body = stopCount > 0
    ? `You have ${stopCount} machine stop${stopCount === 1 ? "" : "s"} ready for ${input.routeDate}.`
    : `A new route for ${input.routeDate} is ready in Snacky OS.`;

  return {
    type: "route_assigned",
    title: `Route assigned for ${input.routeDate}`,
    body,
    url: `/operator/routes/${input.routeId}`,
    routeId: input.routeId,
    routeDate: input.routeDate,
    assignedBy: input.assignedBy,
  };
}

async function updateSubscriptionState(
  supabase: NonNullable<SupabaseClient>,
  subscriptionId: string,
  patch: Partial<Pick<PushSubscriptionRecord, "is_active" | "user_agent" | "device_label">> & {
    last_used_at?: string | null;
    failed_at?: string | null;
    failure_reason?: string | null;
  },
) {
  const { error } = await supabase
    .from("push_subscriptions")
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId);
  if (error) {
    console.warn("[notifications] Failed to update push subscription state", {
      subscription_id: subscriptionId,
      error: shortErrorText(error),
    });
  }
}

async function sendPushToSubscription(
  supabase: NonNullable<SupabaseClient>,
  subscription: PushSubscriptionRecord,
  payload: NotificationPayload,
) {
  const vapid = ensureWebPushConfigured();
  if (!vapid) {
    return { sent: false, skipped: "missing_vapid_configuration" as const };
  }

  const pushSubscription: WebPushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  };

  try {
    await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
    await updateSubscriptionState(supabase, subscription.id, {
      last_used_at: new Date().toISOString(),
      failed_at: null,
      failure_reason: null,
      is_active: true,
    });
    return { sent: true as const };
  } catch (error) {
    const statusCode = Number((error as { statusCode?: unknown } | null)?.statusCode ?? 0);
    const reason = shortErrorText(error) || "Push notification delivery failed.";
    await updateSubscriptionState(supabase, subscription.id, {
      failed_at: new Date().toISOString(),
      failure_reason: reason,
      is_active: statusCode === 404 || statusCode === 410 ? false : subscription.is_active,
    });
    return { sent: false as const, statusCode, reason };
  }
}

export async function savePushSubscription(
  supabase: NonNullable<SupabaseClient>,
  userId: string,
  input: PushSubscriptionInput,
  context?: { deviceLabel?: string | null; userAgent?: string | null },
) {
  const endpoint = cleanText(input.endpoint);
  const p256dh = cleanText(input.keys?.p256dh);
  const auth = cleanText(input.keys?.auth);
  if (!endpoint || !p256dh || !auth) {
    return { saved: false, reason: "invalid_subscription_payload" as const };
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint,
      p256dh,
      auth,
      user_agent: optionalText(context?.userAgent),
      device_label: optionalText(context?.deviceLabel),
      is_active: true,
      last_used_at: now,
      failed_at: null,
      failure_reason: null,
      updated_at: now,
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    return { saved: false, reason: shortErrorText(error) || "Could not save the push subscription." };
  }

  return { saved: true };
}

export async function deactivatePushSubscriptionsForUser(
  supabase: NonNullable<SupabaseClient>,
  userId: string,
  reason = "manual_logout",
) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("push_subscriptions")
    .update({
      is_active: false,
      failed_at: now,
      failure_reason: reason,
      updated_at: now,
    })
    .eq("user_id", userId)
    .eq("is_active", true);

  if (error) {
    return { updated: false, reason: shortErrorText(error) || "Could not deactivate push subscriptions." };
  }

  return { updated: true };
}

export async function loadNotificationsForUser(
  supabase: NonNullable<SupabaseClient>,
  userId: string,
  limit = 10,
) {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const [{ data: notifications, error: notificationError }, { count: unreadCount, error: unreadCountError }] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, type, title, message, action_url, related_route_id, read_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(safeLimit),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null),
  ]);

  if (notificationError) {
    return { notifications: [] as NotificationSummary[], unreadCount: 0, error: shortErrorText(notificationError) };
  }

  if (unreadCountError) {
    console.warn("[notifications] Failed to load unread notification count", {
      user_id: userId,
      error: shortErrorText(unreadCountError),
    });
  }

  return {
    notifications: (notifications ?? []) as NotificationSummary[],
    unreadCount: unreadCount ?? 0,
  };
}

export async function markAllNotificationsReadForUser(supabase: NonNullable<SupabaseClient>, userId: string) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: now })
    .eq("user_id", userId)
    .is("read_at", null);

  if (error) {
    return { updated: false, reason: shortErrorText(error) || "Could not mark notifications read." };
  }

  return { updated: true };
}

export async function notifyRouteAssigned(
  supabase: NonNullable<SupabaseClient> | null,
  input: RouteAssignmentNotificationInput,
) {
  const routeId = cleanText(input.routeId);
  const routeDate = cleanText(input.routeDate);
  const operatorTeamMemberId = cleanText(input.operatorTeamMemberId);
  if (!routeId || !routeDate || !operatorTeamMemberId) {
    return { skipped: true as const, reason: "missing_route_notification_context" };
  }

  const adminClient = getSupabaseAdminClient() ?? supabase;
  if (!adminClient) {
    return { skipped: true as const, reason: "missing_notification_client" };
  }

  const recipientUserId = await resolveRecipientUserId(adminClient, operatorTeamMemberId);
  if (!recipientUserId) {
    console.warn("[notifications] Could not resolve recipient user for route assignment", {
      route_id: routeId,
      operator_team_member_id: operatorTeamMemberId,
    });
    return { skipped: true as const, reason: "missing_recipient_user" };
  }

  const payload = buildRouteAssignmentPayload({
    routeId,
    routeDate,
    assignedBy: optionalText(input.assignedBy),
    stopCount: input.stopCount ?? null,
  });
  const now = new Date().toISOString();

  const { error: notificationError } = await adminClient.from("notifications").upsert(
    {
      user_id: recipientUserId,
      type: payload.type,
      title: payload.title,
      message: payload.body,
      action_url: payload.url,
      related_route_id: payload.routeId,
    },
    { onConflict: "type,user_id,related_route_id" },
  );

  if (notificationError) {
    console.warn("[notifications] Failed to save route notification", {
      route_id: routeId,
      recipient_user_id: recipientUserId,
      error: shortErrorText(notificationError),
    });
  }

  const { data: subscriptions, error: subscriptionError } = await adminClient
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, user_agent, device_label, is_active")
    .eq("user_id", recipientUserId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (subscriptionError) {
    console.warn("[notifications] Failed to load push subscriptions for route notification", {
      route_id: routeId,
      recipient_user_id: recipientUserId,
      error: shortErrorText(subscriptionError),
    });
    return {
      skipped: false as const,
      notificationSaved: !notificationError,
      pushResults: [] as Array<{ subscriptionId: string; sent: boolean; skipped?: string; reason?: string; statusCode?: number }>,
    };
  }

  const pushResults = await Promise.allSettled(
    ((subscriptions ?? []) as PushSubscriptionRecord[]).map((subscription) => sendPushToSubscription(adminClient, subscription, payload)),
  );

  const normalizedPushResults = pushResults.map((result, index) => {
    const subscription = (subscriptions ?? [])[index] as PushSubscriptionRecord | undefined;
    if (!subscription) {
      return { subscriptionId: `unknown-${index}`, sent: false, reason: "missing_subscription" };
    }
    if (result.status === "fulfilled") {
      return { subscriptionId: subscription.id, ...result.value };
    }
    return {
      subscriptionId: subscription.id,
      sent: false,
      reason: shortErrorText(result.reason) || "Push notification failed.",
    };
  });

  const deliveredCount = normalizedPushResults.filter((result) => result.sent).length;
  const failedCount = normalizedPushResults.length - deliveredCount;

  if (normalizedPushResults.length) {
    console.info("[notifications] Route assignment delivery completed", {
      route_id: routeId,
      route_date: routeDate,
      recipient_user_id: recipientUserId,
      subscription_count: normalizedPushResults.length,
      delivered_count: deliveredCount,
      failed_count: failedCount,
      assigned_by: optionalText(input.assignedBy),
      stop_count: input.stopCount ?? null,
      timestamp: now,
    });
  }

  return {
    skipped: false as const,
    notificationSaved: !notificationError,
    recipientUserId,
    pushResults: normalizedPushResults,
  };
}

