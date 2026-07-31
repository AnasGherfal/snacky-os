import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, ErrorState, PageHeader, SectionCard } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath } from "@/lib/authz";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { getServerI18n } from "@/lib/i18n/server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function tr(locale: "ar" | "en", en: string, ar: string) { return locale === "ar" ? ar : en; }
function validMonth(value: string) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${year}-${String(monthNumber).padStart(2, "0")}-01`;
  const next = monthNumber === 12 ? `${year + 1}-01-01` : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  return { start, next };
}

export default async function RoutePerformancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { locale } = await getServerI18n();
  const profile = await getCurrentProfile();
  if (!profile || !canAccessPath({ id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products, teamMemberId: profile.team_member_id, activeStatus: profile.active_status }, "/reports")) redirect("/unauthorized");

  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const requestedMonth = (await searchParams).month ?? defaultMonth;
  const month = validMonth(requestedMonth) ? requestedMonth : defaultMonth;
  const { start, next } = monthBounds(month);
  const authClient = await getAuthenticatedSupabaseServerClient();
  if (!authClient) return <ErrorState title={tr(locale, "Dashboard unavailable", "لوحة البيانات غير متاحة")} body={tr(locale, "Supabase is not configured.", "لم يتم إعداد Supabase.")} />;
  const client = getSupabaseAdminClient() ?? authClient;

  const { data: routes, error: routesError } = await client
    .from("routes")
    .select("id, route_date, operator_id, status, completed_at")
    .gte("route_date", start)
    .lt("route_date", next)
    .order("route_date", { ascending: true });
  if (routesError) return <ErrorState title={tr(locale, "Could not load route performance", "تعذر تحميل أداء الجولات")} body={routesError.message} />;

  const routeRows = routes ?? [];
  const routeIds = routeRows.map((route: any) => route.id);
  const operatorIds = Array.from(new Set(routeRows.map((route: any) => route.operator_id).filter(Boolean)));
  const [stopsResult, operatorsResult] = await Promise.all([
    routeIds.length
      ? client.from("route_stops").select("id, route_id, machine_id, status").in("route_id", routeIds)
      : Promise.resolve({ data: [], error: null }),
    operatorIds.length
      ? client.from("team_members").select("id, full_name").in("id", operatorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (stopsResult.error) return <ErrorState title={tr(locale, "Could not load machine stops", "تعذر تحميل مواقع الأجهزة")} body={stopsResult.error.message} />;

  const completedStops = (stopsResult.data ?? []).filter((stop: any) => ["completed", "done"].includes(String(stop.status ?? "").toLowerCase()));
  const machineIds = Array.from(new Set(completedStops.map((stop: any) => stop.machine_id).filter(Boolean)));
  const { data: machines } = machineIds.length
    ? await client.from("machines").select("id, name, machine_code, location:locations(id, name, area)").in("id", machineIds)
    : { data: [] };

  const routeById = new Map(routeRows.map((route: any) => [route.id, route]));
  const operatorById = new Map((operatorsResult.data ?? []).map((operator: any) => [operator.id, operator]));
  const machineById = new Map((machines ?? []).map((machine: any) => [machine.id, machine]));

  const machineStats = new Map<string, { machineId: string; fills: number; operators: Set<string>; routes: Set<string> }>();
  const operatorStats = new Map<string, { operatorId: string; routes: Set<string>; stops: number; machines: Set<string> }>();
  completedStops.forEach((stop: any) => {
    const route: any = routeById.get(stop.route_id);
    const machine = machineStats.get(stop.machine_id) ?? { machineId: stop.machine_id, fills: 0, operators: new Set<string>(), routes: new Set<string>() };
    machine.fills += 1;
    machine.routes.add(stop.route_id);
    if (route?.operator_id) machine.operators.add(route.operator_id);
    machineStats.set(stop.machine_id, machine);
    if (route?.operator_id) {
      const operator = operatorStats.get(route.operator_id) ?? { operatorId: route.operator_id, routes: new Set<string>(), stops: 0, machines: new Set<string>() };
      operator.routes.add(stop.route_id);
      operator.stops += 1;
      operator.machines.add(stop.machine_id);
      operatorStats.set(route.operator_id, operator);
    }
  });

  const completedRoutes = routeRows.filter((route: any) => String(route.status ?? "").toLowerCase() === "completed").length;
  const machineRows = Array.from(machineStats.values()).sort((a, b) => b.fills - a.fills);
  const operatorRows = Array.from(operatorStats.values()).sort((a, b) => b.stops - a.stops);
  const monthLabel = new Date(`${month}-01T12:00:00`).toLocaleDateString(locale === "ar" ? "ar-LY" : "en-US", { month: "long", year: "numeric" });

  return <div className="space-y-6" dir={locale === "ar" ? "rtl" : "ltr"}>
    <PageHeader title={tr(locale, "Monthly route performance", "أداء الجولات الشهري")} subtitle={tr(locale, `Routes, machine fills, and operator work for ${monthLabel}.`, `الجولات وتعبئة الأجهزة وعمل المشغلين خلال ${monthLabel}.`)} breadcrumbs={[{ label: tr(locale, "Reports", "التقارير"), href: "/reports" }, { label: tr(locale, "Route performance", "أداء الجولات") }]} />

    <form className="surface-card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{tr(locale, "Month", "الشهر")}</span><input className="field-input" type="month" name="month" defaultValue={month} /></label>
      <button className="btn-primary" type="submit">{tr(locale, "Show month", "عرض الشهر")}</button>
    </form>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">{tr(locale, "Routes created", "الجولات المنشأة")}</div><div className="mt-1 text-3xl font-semibold">{routeRows.length}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">{tr(locale, "Routes completed", "الجولات المكتملة")}</div><div className="mt-1 text-3xl font-semibold">{completedRoutes}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">{tr(locale, "Machine stops completed", "مواقع الأجهزة المكتملة")}</div><div className="mt-1 text-3xl font-semibold">{completedStops.length}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">{tr(locale, "Machines serviced", "الأجهزة التي تمت خدمتها")}</div><div className="mt-1 text-3xl font-semibold">{machineStats.size}</div></div></SectionCard>
      <SectionCard><div className="p-4"><div className="text-sm text-slate-500">{tr(locale, "Active operators", "المشغلون النشطون")}</div><div className="mt-1 text-3xl font-semibold">{operatorStats.size}</div></div></SectionCard>
    </div>

    <section className="surface-card p-4"><h2 className="text-lg font-semibold">{tr(locale, "Machine fill frequency", "عدد مرات تعبئة كل جهاز")}</h2><p className="mt-1 text-sm text-slate-500">{tr(locale, "Each completed machine stop counts as one fill visit.", "يُحسب كل موقع جهاز مكتمل كزيارة تعبئة واحدة.")}</p>{!machineRows.length ? <EmptyState title={tr(locale, "No completed machine stops", "لا توجد مواقع أجهزة مكتملة")} body={tr(locale, "Completed fills for this month will appear here.", "ستظهر تعبئات هذا الشهر هنا بعد إكمالها.")} /> : <DataTable headers={[tr(locale, "Machine", "الجهاز"), tr(locale, "Fill visits", "مرات التعبئة"), tr(locale, "Routes", "الجولات"), tr(locale, "Operators", "المشغلون")] }>{machineRows.map((row) => <tr key={row.machineId}><td><Link className="link-secondary" href={`/machines/${row.machineId}`}>{formatMachineDisplayName(machineById.get(row.machineId) ?? null, { includeArea: true })}</Link></td><td className="font-semibold">{row.fills}</td><td>{row.routes.size}</td><td>{Array.from(row.operators).map((id) => operatorById.get(id)?.full_name).filter(Boolean).join("، ") || "-"}</td></tr>)}</DataTable>}</section>

    <section className="surface-card p-4"><h2 className="text-lg font-semibold">{tr(locale, "Operator performance", "أداء المشغلين")}</h2><p className="mt-1 text-sm text-slate-500">{tr(locale, "Completed routes and machine stops by operator.", "الجولات ومواقع الأجهزة المكتملة لكل مشغل.")}</p>{!operatorRows.length ? <EmptyState title={tr(locale, "No operator activity", "لا يوجد نشاط للمشغلين")} body={tr(locale, "Completed operator work for this month will appear here.", "سيظهر عمل المشغلين المكتمل لهذا الشهر هنا.")} /> : <DataTable headers={[tr(locale, "Operator", "المشغل"), tr(locale, "Routes", "الجولات"), tr(locale, "Machine stops", "مواقع الأجهزة"), tr(locale, "Unique machines", "أجهزة مختلفة")] }>{operatorRows.map((row) => <tr key={row.operatorId}><td><Link className="link-secondary" href={`/team/${row.operatorId}`}>{operatorById.get(row.operatorId)?.full_name ?? tr(locale, "Unknown operator", "مشغل غير معروف")}</Link></td><td>{row.routes.size}</td><td className="font-semibold">{row.stops}</td><td>{row.machines.size}</td></tr>)}</DataTable>}</section>
  </div>;
}
