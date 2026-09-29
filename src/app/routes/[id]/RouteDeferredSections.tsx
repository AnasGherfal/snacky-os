import { DataTable, EmptyState, StatusBadge } from "@/components/ui";
import { RouteCompletionImages, type RouteCompletionStop } from "@/components/RouteCompletionImages";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { privateStorageObjectUrl, REFILL_PHOTO_BUCKET } from "@/lib/storage-buckets";

type Locale = "ar" | "en";
type StopDescriptor = { id: string; title: string; subtitle: string };

function tr(locale: Locale, en: string, ar: string) {
  return locale === "ar" ? ar : en;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isMissingTable(error: any, tableName: string) {
  return error?.code === "PGRST205" && String(error?.message ?? "").includes(tableName);
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [row.code, row.message, row.details, row.hint].map((value) => String(value ?? "")).filter(Boolean).join(" ");
}

function isMissingColumn(error: unknown, columns: string[]) {
  const text = errorText(error).toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (!["42703", "PGRST204"].includes(code) && !text.includes("schema cache") && !text.includes("column")) return false;
  return columns.some((column) => text.includes(column.toLowerCase()));
}

function routeActivityActionLabel(locale: Locale, action: string | null | undefined) {
  const value = String(action ?? "").toLowerCase();
  if (value === "created") return tr(locale, "Created", "تم الإنشاء");
  if (value === "updated") return tr(locale, "Updated", "تم التحديث");
  if (value === "assigned") return tr(locale, "Assigned", "تم التعيين");
  if (value === "started") return tr(locale, "Started", "بدأ");
  if (value === "completed") return tr(locale, "Completed", "مكتمل");
  if (value === "cancelled" || value === "canceled") return tr(locale, "Cancelled", "ملغاة");
  if (value === "reviewed") return tr(locale, "Reviewed", "تمت المراجعة");
  if (value === "cash_collected") return tr(locale, "Cash collected", "تم تحصيل الكاش");
  if (value === "inventory_moved") return tr(locale, "Inventory moved", "تم نقل المخزون");
  return value.replaceAll("_", " ");
}

function routeEntityLabel(locale: Locale, entity: string) {
  const value = String(entity ?? "").toLowerCase();
  if (value === "storage") return tr(locale, "Storage", "المخزن");
  if (value === "operator_bag") return tr(locale, "Operator bag", "حقيبة المشغل");
  if (value === "machine") return tr(locale, "Machine", "الجهاز");
  if (value === "supplier") return tr(locale, "Supplier", "المورد");
  if (value === "waste") return tr(locale, "Waste", "هالك");
  if (value === "cash_collection") return tr(locale, "Cash collection", "تحصيل كاش");
  if (value === "route_stop") return tr(locale, "Route stop", "موقع الجولة");
  if (value === "route") return tr(locale, "Route", "الجولة");
  return value.replaceAll("_", " ");
}

function routeRoleLabel(locale: Locale, role: string | null | undefined) {
  const value = String(role ?? "").toLowerCase();
  if (value === "owner") return tr(locale, "Owner", "المالك");
  if (value === "admin") return tr(locale, "Admin", "الإدارة");
  if (value === "supervisor") return tr(locale, "Supervisor", "مشرف");
  if (value === "operator") return tr(locale, "Operator", "مشغل");
  if (value === "finance") return tr(locale, "Finance", "المالية");
  if (value === "warehouse") return tr(locale, "Warehouse", "المخزن");
  return value.replaceAll("_", " ");
}

export function RouteDeferredSectionSkeleton({ label }: { label: string }) {
  return (
    <section className="surface-card p-4" aria-busy="true">
      <h2 className="text-lg font-semibold">{label}</h2>
      <div className="mt-4 space-y-3">
        <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
      </div>
    </section>
  );
}

export async function RouteCompletionImagesSection({
  routeId,
  locale,
  stops,
}: {
  routeId: string;
  locale: Locale;
  stops: StopDescriptor[];
}) {
  if (!stops.length) return null;
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return null;

  let result: any = await supabase
    .from("machine_refill_history")
    .select("id, legacy_refill_id, route_stop_id, refill_at, machine_id, machine_name, operator_email, machine_photo_url, machine_photo_path, raw_record, operator:team_members(full_name)")
    .eq("route_id", routeId)
    .order("refill_at", { ascending: false });

  if (result.error && isMissingColumn(result.error, ["route_id", "route_stop_id"])) {
    result = await supabase
      .from("machine_refill_history")
      .select("id, legacy_refill_id, refill_at, machine_id, machine_name, operator_email, machine_photo_url, machine_photo_path, raw_record, operator:team_members(full_name)")
      .in("legacy_refill_id", stops.map((stop) => `route_stop:${stop.id}`))
      .order("refill_at", { ascending: false });
  }

  if (result.error) {
    if (!isMissingTable(result.error, "machine_refill_history")) {
      console.error("[routes:detail:deferred] Failed to load route completion images", { routeId, error: result.error });
    }
    return (
      <section className="surface-card p-4">
        <h2 className="text-lg font-semibold">{tr(locale, "Completion images", "صور الإكمال")}</h2>
        <p className="mt-2 text-sm text-slate-500">{tr(locale, "Completion images could not be loaded right now.", "تعذر تحميل صور الإكمال حالياً.")}</p>
      </section>
    );
  }

  const imagesByStopId = new Map<string, RouteCompletionStop["images"]>();
  (result.data ?? []).forEach((row: any) => {
    const legacyRefillId = String(row.legacy_refill_id ?? "");
    const rowStopId = row.route_stop_id ? String(row.route_stop_id) : legacyRefillId.startsWith("route_stop:") ? legacyRefillId.replace("route_stop:", "") : "";
    if (!rowStopId) return;
    const savedUrl = String(row.machine_photo_url ?? "").trim();
    const savedPath = String(row.machine_photo_path ?? "").trim();
    const photoUrl = savedUrl && (savedUrl.startsWith("/") || savedUrl.startsWith("http://") || savedUrl.startsWith("https://"))
      ? savedUrl
      : privateStorageObjectUrl(REFILL_PHOTO_BUCKET, savedPath || savedUrl);
    const operator = firstRelation(row.operator);
    const rawRecord = row.raw_record && typeof row.raw_record === "object" ? row.raw_record : {};
    const images = imagesByStopId.get(rowStopId) ?? [];
    images.push({
      id: String(row.id ?? `${rowStopId}-${images.length}`),
      url: photoUrl,
      storagePath: savedPath || null,
      uploadedAt: row.refill_at ?? null,
      uploadedBy: (operator as any)?.full_name ?? row.operator_email ?? (rawRecord as any).operator_name ?? null,
      label: tr(locale, `${row.machine_name ?? "Machine"} completion image`, `صورة إكمال ${row.machine_name ?? "الجهاز"}`),
    });
    imagesByStopId.set(rowStopId, images);
  });

  const hydratedStops: RouteCompletionStop[] = stops.map((stop) => ({
    ...stop,
    images: imagesByStopId.get(stop.id) ?? [],
  }));

  return (
    <section className="surface-card p-4">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">{tr(locale, "Completion images", "صور الإكمال")}</h2>
        <p className="mt-1 text-sm text-slate-500">{tr(locale, "Final machine photos uploaded when the operator completes each stop.", "صور الجهاز النهائية المرفوعة عندما يكمل المشغل كل موقع.")}</p>
      </div>
      <RouteCompletionImages stops={hydratedStops} />
    </section>
  );
}

export async function RouteActivitySection({
  routeId,
  locale,
  stopIds,
  cashIds,
}: {
  routeId: string;
  locale: Locale;
  stopIds: string[];
  cashIds: string[];
}) {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return null;
  const queries: PromiseLike<any>[] = [
    supabase
      .from("system_activity_logs")
      .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
      .eq("entity_type", "route")
      .eq("entity_id", routeId)
      .order("created_at", { ascending: false })
      .limit(100),
  ];
  if (stopIds.length) {
    queries.push(
      supabase
        .from("system_activity_logs")
        .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
        .eq("entity_type", "route_stop")
        .in("entity_id", stopIds)
        .order("created_at", { ascending: false })
        .limit(100),
    );
  }
  if (cashIds.length) {
    queries.push(
      supabase
        .from("system_activity_logs")
        .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
        .eq("entity_type", "cash_collection")
        .in("entity_id", cashIds)
        .order("created_at", { ascending: false })
        .limit(100),
    );
  }
  queries.push(
    supabase
      .from("system_activity_logs")
      .select("id, action, entity_type, entity_label, actor_name, actor_role, summary, created_at")
      .contains("metadata", { route_id: routeId })
      .order("created_at", { ascending: false })
      .limit(100),
  );

  const results = await Promise.all(queries);
  results.forEach((result: any) => {
    if (result.error) console.error("[routes:detail:deferred] Failed to load route activity", { routeId, error: result.error });
  });
  const rows = results
    .flatMap((result: any) => result.data ?? [])
    .filter((activity: any, index: number, all: any[]) => all.findIndex((row: any) => row.id === activity.id) === index)
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 100);

  return (
    <section className="surface-card p-4">
      <h2 className="text-lg font-semibold">{tr(locale, "Route activity", "نشاط الجولة")}</h2>
      <p className="mt-1 text-sm text-slate-500">{tr(locale, "Audit trail for route creation, picking, stop completion, cash review, issues, and leftover return.", "سجل تدقيق لإنشاء الجولة، والتحميل، وإكمال المواقع، ومراجعة الكاش، والأعطال، وإرجاع المتبقي.")}</p>
      {!rows.length ? (
        <div className="mt-4">
          <EmptyState title={tr(locale, "No route activity yet", "لا يوجد نشاط للجولة بعد")} body={tr(locale, "Route actions will appear here as operators and admins work through the route.", "ستظهر إجراءات الجولة هنا أثناء تنفيذ المشغلين والإداريين للجولة.")} />
        </div>
      ) : (
        <div className="mt-4">
          <DataTable headers={[tr(locale, "Created", "الإنشاء"), tr(locale, "Action", "الإجراء"), tr(locale, "Entity", "العنصر"), tr(locale, "User", "المستخدم"), tr(locale, "Summary", "الملخص")]}>
            {rows.map((activity: any) => (
              <tr key={activity.id}>
                <td>{new Date(activity.created_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US")}</td>
                <td><StatusBadge status={activity.action} label={routeActivityActionLabel(locale, activity.action)} /></td>
                <td>{routeEntityLabel(locale, activity.entity_type)}</td>
                <td>{activity.actor_name ?? routeRoleLabel(locale, activity.actor_role) ?? "-"}</td>
                <td>{activity.summary ?? activity.entity_label ?? "-"}</td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
    </section>
  );
}
