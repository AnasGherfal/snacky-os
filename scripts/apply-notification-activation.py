from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8-sig")


def write(path, text):
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(source, old, new, label):
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return source.replace(old, new, 1)


# Server-side VAPID configuration and test delivery.
path = "src/lib/notification-delivery.ts"
source = read(path)
source = replace_once(
    source,
    "  routeId: string;\n  routeDate: string;\n  assignedBy: string | null;",
    "  routeId?: string | null;\n  routeDate?: string | null;\n  assignedBy?: string | null;",
    "notification payload optional route fields",
)
start = source.index("let vapidConfigured = false;")
end = source.index("async function resolveRecipientUserId(")
replacement = r'''type VapidConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

type VapidResolution =
  | { config: VapidConfig; source: "environment" | "database" }
  | { config: null; reason: string };

const DEFAULT_VAPID_SUBJECT = "mailto:notifications@snacky.ly";
let vapidFingerprint = "";

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

function environmentVapidConfig(): VapidConfig | null {
  const subject = cleanText(process.env.VAPID_SUBJECT);
  const publicKey = cleanText(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const privateKey = cleanText(process.env.VAPID_PRIVATE_KEY);
  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

async function loadDatabaseVapidConfig(client: SupabaseClient): Promise<VapidResolution> {
  const result = await client
    .from("push_notification_config")
    .select("public_key, private_key, subject")
    .eq("singleton", true)
    .maybeSingle<{ public_key: string; private_key: string; subject: string }>();

  if (result.error) {
    const text = shortErrorText(result.error).toLowerCase();
    const reason = text.includes("push_notification_config") || text.includes("pgrst205")
      ? "migration_required"
      : "config_load_failed";
    return { config: null, reason };
  }

  const publicKey = cleanText(result.data?.public_key);
  const privateKey = cleanText(result.data?.private_key);
  const subject = cleanText(result.data?.subject);
  if (!publicKey || !privateKey || !subject) return { config: null, reason: "config_missing" };
  return { config: { publicKey, privateKey, subject }, source: "database" };
}

async function createDatabaseVapidConfig(client: SupabaseClient): Promise<VapidResolution> {
  const generated = webpush.generateVAPIDKeys();
  const config: VapidConfig = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: cleanText(process.env.VAPID_SUBJECT) || DEFAULT_VAPID_SUBJECT,
  };
  const now = new Date().toISOString();
  const result = await client.from("push_notification_config").upsert(
    {
      singleton: true,
      public_key: config.publicKey,
      private_key: config.privateKey,
      subject: config.subject,
      updated_at: now,
    },
    { onConflict: "singleton" },
  );
  if (result.error) {
    const text = shortErrorText(result.error).toLowerCase();
    return {
      config: null,
      reason: text.includes("push_notification_config") || text.includes("pgrst205")
        ? "migration_required"
        : "config_create_failed",
    };
  }
  return { config, source: "database" };
}

async function resolveVapidConfig(supabase?: SupabaseClient | null): Promise<VapidResolution> {
  const environment = environmentVapidConfig();
  if (environment) return { config: environment, source: "environment" };

  const client = getSupabaseAdminClient() ?? supabase ?? null;
  if (!client) return { config: null, reason: "missing_admin_client" };

  const stored = await loadDatabaseVapidConfig(client);
  if (stored.config) return stored;
  if (stored.reason === "migration_required") return stored;
  return createDatabaseVapidConfig(client);
}

export async function ensurePushNotificationConfig(supabase?: SupabaseClient | null) {
  const result = await resolveVapidConfig(supabase);
  if (!result.config) return { configured: false as const, reason: result.reason };
  return {
    configured: true as const,
    publicKey: result.config.publicKey,
    source: result.source,
  };
}

async function ensureWebPushConfigured(supabase?: SupabaseClient | null) {
  const result = await resolveVapidConfig(supabase);
  if (!result.config) return null;
  const fingerprint = `${result.config.subject}:${result.config.publicKey}`;
  if (vapidFingerprint !== fingerprint) {
    webpush.setVapidDetails(result.config.subject, result.config.publicKey, result.config.privateKey);
    vapidFingerprint = fingerprint;
  }
  return result.config;
}

'''
source = source[:start] + replacement + source[end:]
source = replace_once(
    source,
    "  const vapid = ensureWebPushConfigured();",
    "  const vapid = await ensureWebPushConfigured(supabase);",
    "await VAPID configuration",
)
insert_marker = "export async function notifyRouteAssigned("
test_function = r'''export async function sendTestPushNotification(
  supabase: NonNullable<SupabaseClient>,
  userId: string,
) {
  const adminClient = getSupabaseAdminClient() ?? supabase;
  const config = await ensurePushNotificationConfig(adminClient);
  if (!config.configured) {
    return { sent: false as const, deliveredCount: 0, subscriptionCount: 0, reason: config.reason };
  }

  const subscriptionResult = await adminClient
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, user_agent, device_label, is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (subscriptionResult.error) {
    return {
      sent: false as const,
      deliveredCount: 0,
      subscriptionCount: 0,
      reason: shortErrorText(subscriptionResult.error) || "subscription_load_failed",
    };
  }

  const subscriptions = (subscriptionResult.data ?? []) as PushSubscriptionRecord[];
  if (!subscriptions.length) {
    return { sent: false as const, deliveredCount: 0, subscriptionCount: 0, reason: "no_active_subscription" };
  }

  const payload: NotificationPayload = {
    type: "push_test",
    title: "Snacky OS notifications are working",
    body: "This device can now receive route assignments before the app is opened.",
    url: "/operator/routes",
    routeId: null,
    routeDate: null,
    assignedBy: null,
  };

  await adminClient.from("notifications").insert({
    user_id: userId,
    type: payload.type,
    title: payload.title,
    message: payload.body,
    action_url: payload.url,
    related_route_id: null,
  });

  const settled = await Promise.allSettled(
    subscriptions.map((subscription) => sendPushToSubscription(adminClient, subscription, payload)),
  );
  const deliveredCount = settled.filter((item) => item.status === "fulfilled" && item.value.sent).length;
  return {
    sent: deliveredCount > 0,
    deliveredCount,
    subscriptionCount: subscriptions.length,
    reason: deliveredCount > 0 ? null : "delivery_failed",
  };
}

'''
if source.count(insert_marker) != 1:
    raise RuntimeError("test push insertion marker missing")
source = source.replace(insert_marker, test_function + insert_marker, 1)
write(path, source)


# Browser subscription setup and test button.
path = "src/components/NotificationCenter.tsx"
source = read(path)
source = replace_once(
    source,
    '''  const [loadingPush, setLoadingPush] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pushStatus, setPushStatus] = useState<"checking" | "unsupported" | "blocked" | "available" | "enabled">("checking");
  const [message, setMessage] = useState<string | null>(null);
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
  const supportsPush = typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window && Boolean(vapidPublicKey);''',
    '''  const [loadingPush, setLoadingPush] = useState(false);
  const [loadingTest, setLoadingTest] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pushStatus, setPushStatus] = useState<"checking" | "unsupported" | "blocked" | "available" | "enabled">("checking");
  const [pushConfigStatus, setPushConfigStatus] = useState<"checking" | "ready" | "unavailable">("checking");
  const [vapidPublicKey, setVapidPublicKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const browserSupportsPush = typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;''',
    "notification center state",
)
refresh_start = source.index("  const refreshPushStatus = async () => {")
refresh_end = source.index("  const markAllRead = async () => {")
refresh_block = r'''  const loadPushConfiguration = async () => {
    if (!browserSupportsPush) {
      setPushStatus("unsupported");
      setPushConfigStatus("unavailable");
      return "";
    }
    setPushConfigStatus("checking");
    try {
      const response = await fetch("/api/push-config", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as { configured?: boolean; publicKey?: string; error?: string } | null;
      const publicKey = typeof payload?.publicKey === "string" ? payload.publicKey.trim() : "";
      if (!response.ok || !payload?.configured || !publicKey) {
        setPushConfigStatus("unavailable");
        setMessage(payload?.error ?? "Push notification setup is not ready yet.");
        return "";
      }
      setVapidPublicKey(publicKey);
      setPushConfigStatus("ready");
      return publicKey;
    } catch (error) {
      console.warn("[notifications] Could not load push configuration", errorText(error));
      setPushConfigStatus("unavailable");
      setMessage("Push notification setup could not be loaded.");
      return "";
    }
  };

  const refreshPushStatus = async (resolvedPublicKey = vapidPublicKey) => {
    if (!browserSupportsPush) {
      setPushStatus("unsupported");
      return;
    }
    if (!resolvedPublicKey) {
      setPushStatus("available");
      return;
    }
    if (Notification.permission === "denied") {
      setPushStatus("blocked");
      return;
    }
    if (Notification.permission !== "granted") {
      setPushStatus("available");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration() ?? await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.getSubscription();
      setPushStatus(subscription ? "enabled" : "available");
    } catch (error) {
      console.warn("[notifications] Could not inspect push subscription", errorText(error));
      setPushStatus("available");
    }
  };

'''
source = source[:refresh_start] + refresh_block + source[refresh_end:]
enable_start = source.index("  const enablePush = async () => {")
enable_end = source.index("  useEffect(() => {", enable_start)
enable_block = r'''  const enablePush = async () => {
    if (!browserSupportsPush) {
      setMessage("Push notifications are not supported in this browser. On iPhone, install Snacky OS to the Home Screen first.");
      setPushStatus("unsupported");
      return;
    }

    setLoadingPush(true);
    setMessage(null);
    try {
      const publicKey = vapidPublicKey || await loadPushConfiguration();
      if (!publicKey) return;

      if (Notification.permission === "default") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setPushStatus(permission === "denied" ? "blocked" : "available");
          setMessage("Notifications were not allowed.");
          return;
        }
      }
      if (Notification.permission === "denied") {
        setPushStatus("blocked");
        setMessage("Notifications are blocked in this browser. Enable them in browser settings first.");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const response = await fetch("/api/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), deviceLabel: detectDeviceLabel() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not save the subscription.");
      }

      setPushStatus("enabled");
      setMessage("Push notifications are enabled on this device. Send a test to verify delivery.");
    } catch (error) {
      console.warn("[notifications] Failed to enable push", errorText(error));
      setMessage(error instanceof Error ? error.message : "Could not enable push notifications.");
      setPushStatus(Notification.permission === "denied" ? "blocked" : "available");
    } finally {
      setLoadingPush(false);
    }
  };

  const sendTestPush = async () => {
    setLoadingTest(true);
    setMessage(null);
    try {
      const response = await fetch("/api/notifications/test", { method: "POST" });
      const payload = (await response.json().catch(() => null)) as { sent?: boolean; error?: string } | null;
      if (!response.ok || !payload?.sent) throw new Error(payload?.error ?? "Test notification failed.");
      setMessage("Test notification sent. It should appear on this device now.");
      void loadNotifications();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Test notification failed.");
    } finally {
      setLoadingTest(false);
    }
  };

'''
source = source[:enable_start] + enable_block + source[enable_end:]
first_effect_start = source.index("  useEffect(() => {\n    const initialLoad")
second_effect_start = source.index("  useEffect(() => {\n    if (!open) return;", first_effect_start)
new_effect = r'''  useEffect(() => {
    const refresh = async () => {
      void loadNotifications();
      const publicKey = await loadPushConfiguration();
      await refreshPushStatus(publicKey);
    };
    const initialLoad = window.setTimeout(() => { void refresh(); }, 0);
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

'''
source = source[:first_effect_start] + new_effect + source[second_effect_start:]
label_start = source.index("  const pushStatusLabel = useMemo(() => {")
label_end = source.index("\n\n  return (", label_start)
label_block = r'''  const pushStatusLabel = useMemo(() => {
    if (pushStatus === "checking" || pushConfigStatus === "checking") return "Preparing push notifications...";
    if (pushStatus === "unsupported") return "Push is not supported in this browser.";
    if (pushConfigStatus === "unavailable") return "Push setup needs attention.";
    if (pushStatus === "blocked") return "Push notifications are blocked.";
    if (pushStatus === "enabled") return "Push enabled on this device.";
    return "Push available on this device.";
  }, [pushStatus, pushConfigStatus]);'''
source = source[:label_start] + label_block + source[label_end:]
old_button = '''              <button
                type="button"
                onClick={() => void enablePush()}
                disabled={loadingPush || pushStatus === "enabled"}
                className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loadingPush ? <Loader2 className="h-4 w-4 animate-spin" /> : pushStatus === "enabled" ? "Enabled" : "Enable"}
              </button>'''
new_button = '''              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => void enablePush()}
                  disabled={loadingPush || pushStatus === "enabled" || pushConfigStatus === "checking"}
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadingPush ? <Loader2 className="h-4 w-4 animate-spin" /> : pushStatus === "enabled" ? "Enabled" : "Enable"}
                </button>
                {pushStatus === "enabled" ? (
                  <button
                    type="button"
                    onClick={() => void sendTestPush()}
                    disabled={loadingTest}
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-800 disabled:opacity-60"
                  >
                    {loadingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
                  </button>
                ) : null}
              </div>'''
source = replace_once(source, old_button, new_button, "notification buttons")
write(path, source)


# Show the notification bell on desktop as well as mobile.
path = "src/components/Topbar.tsx"
source = read(path)
source = replace_once(source, '<div className="md:hidden">\n               <NotificationCenter compact />', '<div>\n               <NotificationCenter compact />', "desktop notification center")
write(path, source)


# Document optional environment override; database-backed keys remain the default.
path = ".env.example"
source = read(path)
source = replace_once(
    source,
    "NEXT_PUBLIC_APP_URL=https://your-vercel-domain.example\n",
    "NEXT_PUBLIC_APP_URL=https://your-vercel-domain.example\n\n# Optional Web Push override. When blank, Snacky OS securely creates one VAPID key pair in Supabase.\nVAPID_SUBJECT=mailto:notifications@snacky.ly\nNEXT_PUBLIC_VAPID_PUBLIC_KEY=\nVAPID_PRIVATE_KEY=\n",
    "VAPID env documentation",
)
write(path, source)

print("Notification activation integration applied.")
