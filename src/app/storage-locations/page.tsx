import Link from "next/link";
import { redirect } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PaginationControls } from "@/components/PaginationControls";
import { DataTable, EmptyState, ErrorState, PageHeader, PrimaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canManageStorageLocations } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { activateStorageLocation, archiveStorageLocation, deleteStorageLocation } from "@/lib/storage-location-actions";
import { getServerI18n } from "@/lib/i18n/server";
import {
  StorageLocationRow,
  storageLocationHelperBody,
  storageLocationHelperTitle,
  inventoryRowBelongsToLocation,
  normalizeStorageLocationType,
  storageLocationStatusLabel,
  storageLocationTypeLabel,
  storageLocationTypeHelperCards,
} from "@/lib/storage-locations";

export const dynamic = "force-dynamic";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function storageTypeLabel(value: string | null | undefined, locale: "en" | "ar") {
  return storageLocationTypeLabel(normalizeStorageLocationType(value), locale);
}

export default async function StorageLocationsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { locale } = await getServerI18n();
  const profile = await getCurrentProfile();
  if (!profile || !canManageStorageLocations(profile)) redirect("/unauthorized");

  const params = cleanSearchParams((await searchParams) as SearchParamsRecord);
  const { page, pageSize, from, to } = getPagination(params);
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <ErrorState title={locale === "ar" ? "مواقع التخزين غير متاحة" : "Storage locations unavailable"} body={locale === "ar" ? "Supabase غير مهيأ، لذلك لا يستطيع Snacky OS تحميل بيانات مواقع التخزين." : "Supabase is not configured, so Snacky OS cannot load storage location data."} />
      </>
    );
  }

  const [{ data: locations, count, error: locationsError }, { count: activeLocationCount }, { data: operators }] =
    await Promise.all([
      supabase
        .from("storage_locations")
        .select("id, name, address, active, location_type, related_operator_id, latitude, longitude, created_at, updated_at", { count: "exact" })
        .order("name")
        .range(from, to),
      supabase.from("storage_locations").select("id", { count: "exact", head: true }).eq("active", true),
      supabase.from("team_members").select("id, full_name, email").order("full_name"),
    ]);

  const setupError = locationsError;
  if (setupError) {
    console.error("[storage-locations] Failed to load page data", setupError);
    return (
      <>
        <ErrorState title={locale === "ar" ? "تعذر تحميل مواقع التخزين" : "Could not load storage locations"} body={locale === "ar" ? "تعذر على Snacky OS تحميل ملخص مواقع التخزين من Supabase." : "Snacky OS could not load the storage location summary from Supabase."} />
      </>
    );
  }

  const visibleLocations = (locations ?? []) as StorageLocationRow[];
  const storageIds = visibleLocations
    .filter((location) => !["operator_bag", "damaged", "expired"].includes(normalizeStorageLocationType(location.location_type)))
    .map((location) => location.id);
  const operatorBagIds = visibleLocations
    .filter((location) => normalizeStorageLocationType(location.location_type) === "operator_bag" && location.related_operator_id)
    .map((location) => location.related_operator_id as string);
  const [{ data: storageInventoryRows }, { data: operatorInventoryRows }] = await Promise.all([
    storageIds.length
      ? supabase.from("current_inventory_by_location").select("product_id, product_name, location_type, location_id, location_name, quantity_on_hand").eq("location_type", "storage").in("location_id", storageIds)
      : Promise.resolve({ data: [] }),
    operatorBagIds.length
      ? supabase.from("current_inventory_by_location").select("product_id, product_name, location_type, location_id, location_name, quantity_on_hand").eq("location_type", "operator_bag").in("location_id", operatorBagIds)
      : Promise.resolve({ data: [] }),
  ]);
  const inventoryRows = [...(storageInventoryRows ?? []), ...(operatorInventoryRows ?? [])];
  const movementSummaries = await Promise.all(
    visibleLocations.map(async (location) => {
      const type = normalizeStorageLocationType(location.location_type);
      const movementFilter = (query: any) => {
        if (type === "operator_bag") {
          if (!location.related_operator_id) return null;
          return query.or(`and(from_entity_type.eq.operator_bag,from_entity_id.eq.${location.related_operator_id}),and(to_entity_type.eq.operator_bag,to_entity_id.eq.${location.related_operator_id})`);
        }
        if (type === "damaged" || type === "expired") return query.eq("reason", type);
        return query.or(`and(from_entity_type.eq.storage,from_entity_id.eq.${location.id}),and(to_entity_type.eq.storage,to_entity_id.eq.${location.id})`);
      };
      const countQuery = movementFilter(supabase.from("inventory_movements").select("id", { count: "exact", head: true }));
      const latestQuery = movementFilter(supabase.from("inventory_movements").select("created_at").order("created_at", { ascending: false }).limit(1));
      if (!countQuery || !latestQuery) return [location.id, { movementCount: 0, lastMovementAt: null }] as const;
      const [{ count: movementCount }, { data: latestRows }] = await Promise.all([countQuery, latestQuery]);
      return [location.id, { movementCount: movementCount ?? 0, lastMovementAt: latestRows?.[0]?.created_at ?? null }] as const;
    }),
  );
  const movementSummaryByLocationId = new Map(movementSummaries);
  const operatorById = new Map((operators ?? []).map((operator: any) => [operator.id, operator]));
  const rows = visibleLocations
    .map((location) => ({
      location,
      operator: location.related_operator_id ? operatorById.get(location.related_operator_id) : null,
      summary: {
        productCount: inventoryRows.filter((row: any) => inventoryRowBelongsToLocation(row, location) && Number(row.quantity_on_hand ?? 0) !== 0).length,
        totalUnits: inventoryRows.filter((row: any) => inventoryRowBelongsToLocation(row, location)).reduce((sum: number, row: any) => sum + Number(row.quantity_on_hand ?? 0), 0),
        movementCount: movementSummaryByLocationId.get(location.id)?.movementCount ?? 0,
        lastMovementAt: movementSummaryByLocationId.get(location.id)?.lastMovementAt ?? null,
      },
    }))
    .sort((a, b) => Number(b.location.active) - Number(a.location.active) || storageLocationTypeLabel(a.location.location_type, "en").localeCompare(storageLocationTypeLabel(b.location.location_type, "en")) || a.location.name.localeCompare(b.location.name));

  const activeCount = activeLocationCount ?? 0;
  const archivedCount = Math.max(0, (count ?? 0) - activeCount);
  const totalUnits = rows.reduce((sum, row) => sum + row.summary.totalUnits, 0);

  return (
    <>
      <PageHeader
        title={locale === "ar" ? "مواقع التخزين" : "Storage Locations"}
        subtitle={locale === "ar" ? "أدر المخازن وحقائب المشغل والمواقع الداخلية المستخدمة في حركات المخزون." : "Manage warehouses, operator bags, and internal stock locations used by inventory movements."}
        action={<PrimaryButton href="/storage-locations/new">{locale === "ar" ? "إضافة موقع" : "Add location"}</PrimaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}

      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "ar" ? "المواقع النشطة" : "Active Locations"}</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{activeCount}</div>
          <p className="mt-1 text-sm text-slate-500">{locale === "ar" ? `${archivedCount} مؤرشفة` : `${archivedCount} archived`}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "ar" ? "الوحدات الحالية المعروضة" : "Shown Current Units"}</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{totalUnits}</div>
          <p className="mt-1 text-sm text-slate-500">{locale === "ar" ? "محسوبة للصفحة المعروضة" : "Calculated for the visible page"}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "ar" ? "أنواع المواقع" : "Location Types"}</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{new Set(rows.map((row) => row.location.location_type ?? "main_storage")).size}</div>
          <p className="mt-1 text-sm text-slate-500">{locale === "ar" ? "المخازن والحقائب والمركبات والمواقع الداخلية" : "Warehouses, bags, vehicles, and internal locations"}</p>
        </div>
      </div>

      <section className="mb-6 grid gap-3 md:grid-cols-3">
        {storageLocationTypeHelperCards.map((helper) => (
          <div key={helper.title.en} className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">{storageLocationHelperTitle(helper.title.en, locale)}</h2>
            <p className="mt-1 text-sm text-slate-500">{storageLocationHelperBody(helper.title.en, helper.body.en, locale)}</p>
          </div>
        ))}
      </section>

      {!rows.length ? (
        <EmptyState title={locale === "ar" ? "لا توجد مواقع تخزين بعد" : "No storage locations yet"} body={locale === "ar" ? "أضف مخزناً رئيسياً أو حقائب مشغل أو مواقع مخزون مؤقتة قبل إنشاء حركات المخزون." : "Add MAIN storage, operator bags, or temporary stock locations before creating inventory movements."} />
      ) : (
        <>
          <DataTable headers={locale === "ar" ? ["اسم الموقع", "النوع", "الحالة", "الإحداثيات", "عدد المنتجات الحالية", "إجمالي الوحدات الحالية", "آخر حركة", "الإجراءات"] : ["Location Name", "Type", "Status", "Coordinates", "Current Products Count", "Current Total Units", "Last Movement Date", "Actions"]}>
            {rows.map(({ location, operator, summary }) => {
              const canHardDelete = summary.movementCount === 0 && summary.totalUnits === 0;
              return (
                <tr key={location.id}>
                  <td>
                    <Link href={`/storage-locations/${location.id}`} className="link-secondary font-semibold">
                      {location.name}
                    </Link>
                    {operator ? <div className="mt-1 text-xs text-slate-500">{operator.full_name}</div> : null}
                  </td>
                  <td>{storageTypeLabel(location.location_type, locale)}</td>
                  <td><StatusBadge status={storageLocationStatusLabel(location.active, locale)} label={storageLocationStatusLabel(location.active, locale)} /></td>
                  <td>{location.latitude && location.longitude ? `${location.latitude}, ${location.longitude}` : "-"}</td>
                  <td>{summary.productCount}</td>
                  <td className="font-semibold text-slate-900">{summary.totalUnits}</td>
                  <td>{formatDate(summary.lastMovementAt)}</td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/storage-locations/${location.id}`} className="btn-secondary px-3 py-2">{locale === "ar" ? "عرض" : "View"}</Link>
                      <Link href={`/storage-locations/${location.id}/edit`} className="btn-secondary px-3 py-2">{locale === "ar" ? "تعديل" : "Edit"}</Link>
                      {location.active ? (
                        <ConfirmDialog
                          action={archiveStorageLocation}
                          triggerLabel={locale === "ar" ? "أرشفة" : "Archive"}
                          title={locale === "ar" ? "أرشفة موقع التخزين؟" : "Archive storage location?"}
                          description={locale === "ar" ? "تظل المواقع المؤرشفة في سجل الحركات لكنها لا يمكن استخدامها لحركات مخزون جديدة." : "Archived locations stay in movement history but cannot be used for new stock movements."}
                          confirmLabel={locale === "ar" ? "أرشفة الموقع" : "Archive location"}
                          buttonClassName="btn-secondary px-3 py-2"
                          hiddenFields={[{ name: "id", value: location.id }]}
                        />
                      ) : (
                        <form action={activateStorageLocation}>
                          <input type="hidden" name="id" value={location.id} />
                          <button className="btn-secondary px-3 py-2">{locale === "ar" ? "تفعيل" : "Activate"}</button>
                        </form>
                      )}
                      {canHardDelete ? (
                        <ConfirmDialog
                          action={deleteStorageLocation}
                          triggerLabel={locale === "ar" ? "حذف" : "Delete"}
                          title={locale === "ar" ? "حذف موقع التخزين نهائياً؟" : "Delete storage location permanently?"}
                          description={locale === "ar" ? "هذا مسموح فقط لأن الموقع لا يملك مخزوناً حالياً ولا سجل حركات." : "This is only allowed because the location has no current inventory and no movement history."}
                          confirmLabel={locale === "ar" ? "حذف نهائي" : "Delete permanently"}
                          buttonClassName="btn-danger px-3 py-2"
                          confirmButtonClassName="btn-danger"
                          hiddenFields={[{ name: "id", value: location.id }]}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
          <PaginationControls basePath="/storage-locations" searchParams={params} page={page} pageSize={pageSize} totalCount={count ?? 0} itemLabel="locations" />
        </>
      )}
    </>
  );
}
