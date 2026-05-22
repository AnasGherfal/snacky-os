import Link from "next/link";
import { EmptyState, ErrorState, PageHeader, PrimaryButton, SecondaryButton, SectionCard, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOperatorRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function OperatorPage() {
  const supabase = getSupabaseServerClient();
  const profile = await getCurrentProfile();
  const today = new Date().toISOString().split("T")[0];

  if (!supabase) {
    return (
      <>
        <ErrorState title="Operator routes unavailable" body="Supabase is not configured, so Snacky OS cannot load assigned routes." />
      </>
    );
  }

  let routesQuery = supabase
    .from("routes")
    .select("id, route_date, status, operator_id, route_stops(id, status)")
    .gte("route_date", today)
    .order("route_date", { ascending: true });

  if (routesQuery && isOperatorRole(profile)) {
    routesQuery = routesQuery.eq("operator_id", profile?.team_member_id ?? "");
  }

  const { data: routes, error: routesError } = await routesQuery;
  if (routesError) {
    console.error("[operator] Failed to load assigned routes", routesError);
    return (
      <>
        <ErrorState title="Could not load assigned routes" body="Snacky OS could not load the operator route list." action={<SecondaryButton href="/operator">Retry</SecondaryButton>} />
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <PageHeader
          title="Operator"
          subtitle="Assigned refill routes and daily execution workflow."
          action={<PrimaryButton href="/operator/routes">All my routes</PrimaryButton>}
        />

        {!routes?.length ? (
          <EmptyState title="No assigned routes" body="Assigned routes for today and upcoming dates will appear here." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {routes.map((route: any) => {
              const completedStops = route.route_stops?.filter((stop: any) => stop.status === "completed").length ?? 0;
              const totalStops = route.route_stops?.length ?? 0;
              return (
                <Link key={route.id} href={`/operator/routes/${route.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 transition hover:shadow-md">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">{route.route_date}</div>
                      <div className="mt-1 text-sm text-slate-500">{completedStops}/{totalStops} stops completed</div>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={route.status} />
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-slate-200">
                    <div className="h-2 rounded-full bg-emerald-500" style={{ width: totalStops ? `${Math.round((completedStops / totalStops) * 100)}%` : "0%" }} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        <SectionCard>
          <div className="p-4">
            <h2 className="text-base font-semibold text-slate-900">Route workflow</h2>
            <div className="mt-3 grid gap-3 text-sm text-slate-600 md:grid-cols-5">
              {["Pick stock", "Visit stops", "Fill machines", "Record cash", "Return leftovers"].map((step) => (
                <div key={step} className="rounded-lg border border-slate-200 bg-white p-3 font-medium text-slate-800">
                  {step}
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
