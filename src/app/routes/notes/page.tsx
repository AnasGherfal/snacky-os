import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, isAdminRole } from "@/lib/authz";
import { cleanSearchParams, getPagination, SearchParamsRecord } from "@/lib/pagination";
import { PaginationControls } from "@/components/PaginationControls";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type ClosingNote = {
  id: string;
  route_id: string;
  operator_id: string | null;
  reason: string | null;
  created_at: string;
  status: string;
  returned_units: number | null;
  discrepancy_units: number | null;
};

function isUsefulNote(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text.length > 1 && /[\\p{L}\\p{N}]/u.test(text);
}

function formatWhen(value: string, locale: "en" | "ar") {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-US", {
    timeZone: "Africa/Tripoli",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(time);
}

export default async function OperatorNotesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const { locale } = await getServerI18n();
  const profile = await getCurrentProfile();
  if (!profile || !isAdminRole(profile) || !canAccessPath({
    id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id, activeStatus: profile.active_status,
  }, "/routes")) redirect("/unauthorized");

  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return <ErrorState title="Operator notes unavailable" body="Snacky OS cannot connect to the database." />;
  const params = cleanSearchParams(await searchParams);
  const { page, pageSize, from, to } = getPagination(params);
  const selectedOperator = String(params.operator ?? "").trim();
  const validOperator = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(selectedOperator) ? selectedOperator : "";

  const [{ data: team, error: teamError }, notesResult] = await Promise.all([
    supabase.from("team_members").select("id, full_name").order("full_name"),
    (validOperator
      ? supabase.from("route_inventory_reconciliations")
          .select("id, route_id, operator_id, reason, status, created_at, returned_units, discrepancy_units", { count: "exact" })
          .eq("operator_id", validOperator)
      : supabase.from("route_inventory_reconciliations")
          .select("id, route_id, operator_id, reason, status, created_at, returned_units, discrepancy_units", { count: "exact" }))
      .not("reason", "is", null)
      .neq("reason", "")
      .order("created_at", { ascending: false })
      .range(from, to),
  ]);

  if (notesResult.error) {
    console.error("[routes:notes] Could not load operator closing notes", notesResult.error);
    return <ErrorState title={locale === "ar" ? "تعذر تحميل ملاحظات المشغلين" : "Could not load operator notes"} body={locale === "ar" ? "حاول تحديث الصفحة." : "Refresh and try again."} />;
  }
  if (teamError) console.warn("[routes:notes] Operator names partially unavailable", teamError);

  const notes = ((notesResult.data ?? []) as ClosingNote[]).filter(note => isUsefulNote(note.reason));
  const routeIds = [...new Set(notes.map(note => note.route_id))];
  const { data: routeRows, error: routeError } = routeIds.length
    ? await supabase.from("routes").select("id, route_date").in("id", routeIds)
    : { data: [], error: null };
  if (routeError) console.warn("[routes:notes] Route dates partially unavailable", routeError);
  const routeById = new Map((routeRows ?? []).map(row => [row.id, row.route_date]));
  const nameById = new Map((team ?? []).map(member => [member.id, member.full_name]));
  const operators = (team ?? []).filter(member => member.id && member.full_name);

  return (
    <>
      <PageHeader
        title={locale === "ar" ? "ملاحظات المشغلين" : "Operator notes"}
        subtitle={locale === "ar"
          ? "الملاحظات التي كتبها المشغلون عند إنهاء الجولات، مرتبة من الأحدث. هذه الملاحظات لا تعني الموافقة على فروق المخزون."
          : "Notes entered by operators when finishing routes, newest first. A note is not approval of an inventory difference."}
        breadcrumbs={[{ label: locale === "ar" ? "الجولات" : "Routes", href: "/routes" }, { label: locale === "ar" ? "ملاحظات المشغلين" : "Operator notes" }]}
        action={<SecondaryButton href="/routes">{locale === "ar" ? "العودة للجولات" : "Back to routes"}</SecondaryButton>}
      />
      <div className="mb-5 flex flex-wrap gap-2">
        <Link href="/routes/notes" className={!validOperator ? "btn-primary" : "btn-secondary"}>{locale === "ar" ? "كل المشغلين" : "All operators"}</Link>
        {operators.filter(member => /noury|yamen/i.test(member.full_name)).map(member => (
          <Link key={member.id} href={`/routes/notes?operator=${member.id}`}
            className={validOperator === member.id ? "btn-primary" : "btn-secondary"}>
            {member.full_name}
          </Link>
        ))}
      </div>
      {!notes.length ? (
        <EmptyState title={locale === "ar" ? "لا توجد ملاحظات في هذه الصفحة" : "No notes on this page"}
          body={locale === "ar" ? "الملاحظات التي تركها المشغل عند إنهاء الجولة ستظهر هنا." : "Route-closing notes will appear here when operators leave them."} />
      ) : (
        <div className="space-y-3">
          {notes.map(note => (
            <section key={note.id} className="surface-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="font-semibold text-slate-900">
                  {nameById.get(note.operator_id ?? "") ?? (locale === "ar" ? "المشغل" : "Operator")}
                  <span className="ml-2 font-normal text-slate-500">{routeById.get(note.route_id) ?? ""}</span>
                </div>
                <time className="text-slate-500" dateTime={note.created_at}>{formatWhen(note.created_at, locale)}</time>
              </div>
              <p dir="auto" className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-sm leading-7 text-slate-900">{note.reason?.trim()}</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <span>{locale === "ar"
                  ? `المرتجع المسجل: ${note.returned_units ?? 0} · فرق يحتاج للمراجعة: ${note.discrepancy_units ?? 0}`
                  : `Returned: ${note.returned_units ?? 0} · Recorded difference: ${note.discrepancy_units ?? 0}`}</span>
                <div className="flex flex-wrap gap-3">
                  <Link href={`/routes/${note.route_id}`} className="link-secondary">{locale === "ar" ? "عرض الجولة" : "View route"}</Link>
                  <Link href={`/routes/inventory-review?route=${note.route_id}`} className="link-secondary">{locale === "ar" ? "مراجعة الفروقات" : "Review differences"}</Link>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
      <div className="mt-5">
        <PaginationControls basePath="/routes/notes" searchParams={params} page={page} pageSize={pageSize}
          totalCount={notesResult.count ?? 0} itemLabel={locale === "ar" ? "ملاحظات" : "notes"} />
      </div>
    </>
  );
}
