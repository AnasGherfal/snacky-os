import Link from "next/link";
import { redirect } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable, EmptyState, ErrorState, FormField, PageHeader, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { moneyLabel, routeAccessDifficultyLabel, routeDistanceZoneLabel, routeExtraTypeLabel } from "@/lib/payroll";
import { deleteRoutePayExtra, markRoutePayDisputed, recalculateRoutePay, saveRoutePayExtra, verifyRoutePay } from "@/lib/payroll-actions";
import { loadRoutePayData } from "@/lib/payroll-server";

export const dynamic = "force-dynamic";

export default async function RoutePayDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; verified?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");

  const { id } = await params;
  const query = await searchParams;
  const routeData = await loadRoutePayData(id);
  if (!routeData) {
    return (
      <>
        <ErrorState title="Route pay unavailable" body="Snacky OS could not load route payroll data for this route." action={<SecondaryButton href="/payroll">Back to payroll</SecondaryButton>} />
      </>
    );
  }

  const calculation = routeData.calculation;
  const breakdown = routeData.breakdown;

  return (
    <>
      <PageHeader
        title={`Route pay - ${routeData.route.route_date ?? id.slice(0, 8)}`}
        subtitle="Stored route pay breakdown for audit, payroll verification, and monthly salary periods."
        breadcrumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Route pay detail" }]}
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton href="/payroll">Back to payroll</SecondaryButton>
            <SecondaryButton href={`/routes/${id}`}>Open route detail</SecondaryButton>
            {breakdown?.payroll_period_id ? <SecondaryButton href={`/payroll/periods/${breakdown.payroll_period_id}`}>Open payroll period</SecondaryButton> : null}
          </div>
        }
      />

      {query.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{query.error}</div> : null}
      {query.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Route pay breakdown saved.</div> : null}
      {query.verified ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Route pay verified and ready for payroll.</div> : null}

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="surface-card">
          <div className="text-sm text-slate-500">Route status</div>
          <div className="mt-2"><StatusBadge status={routeData.route.status} /></div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Operator</div>
          <div className="mt-2 text-lg font-semibold text-slate-900">{routeData.operator?.full_name ?? "Unassigned"}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Stops</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{routeData.stops.length}</div>
        </div>
        <div className="surface-card">
          <div className="text-sm text-slate-500">Current route pay</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{calculation ? moneyLabel(calculation.totalPay) : "-"}</div>
        </div>
      </div>

      {!routeData.payProfile || !calculation ? (
        <ErrorState
          title="Route pay cannot be calculated yet"
          body={routeData.route.operator_id ? "This route needs a payroll profile for its assigned operator before pay can be calculated." : "Assign an operator to this route before building payroll."}
          action={routeData.route.operator_id ? <PrimaryButton href={`/payroll/profiles/${routeData.route.operator_id}`}>Open pay profile</PrimaryButton> : <SecondaryButton href={`/routes/${id}`}>Open route</SecondaryButton>}
        />
      ) : (
        <>
          <form className="surface-card mb-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Calculation inputs</h2>
              <p className="mt-1 text-sm text-slate-500">Distance and load difficulty can be entered manually now. The schema is ready for future map-based route distance APIs.</p>
            </div>

            <input type="hidden" name="route_id" value={id} />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <FormField label="Storage location" required>
                <select name="storage_location_id" defaultValue={calculation.storageLocationId ?? routeData.selectedStorageLocation?.id ?? ""} className="field-input">
                  {routeData.storageLocations.map((storage) => (
                    <option key={storage.id} value={storage.id}>
                      {storage.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Distance km" hint="If filled, Snacky OS derives the distance zone from the saved KM value.">
                <input name="distance_km" type="number" min="0" step="0.01" defaultValue={calculation.distanceKm ?? ""} className="field-input" />
              </FormField>
              <FormField label="Distance zone" required hint="Used when KM is not entered yet.">
                <select name="distance_zone" defaultValue={calculation.distanceZone} className="field-input">
                  <option value="within_10_km">0-10 km</option>
                  <option value="km_11_20">11-20 km</option>
                  <option value="km_21_35">21-35 km</option>
                  <option value="km_36_50">36-50 km</option>
                  <option value="km_51_70">51-70 km</option>
                  <option value="km_70_plus">70+ km</option>
                </select>
              </FormField>
              <FormField label="Distance source" required>
                <select name="distance_source" defaultValue={calculation.distanceSource} className="field-input">
                  <option value="manual">Manual</option>
                  <option value="route_zone">Route zone</option>
                  <option value="location_zone">Location zone</option>
                  <option value="km_manual">Manual KM</option>
                  <option value="map_api">Map API</option>
                </select>
              </FormField>
              <FormField label="Load difficulty pay LYD" hint="Use this when the route workload deserves extra pay beyond fixed heavy-load extras.">
                <input name="load_difficulty_pay_lyd" type="number" min="0" step="0.01" defaultValue={calculation.loadDifficultyPay} className="field-input" />
              </FormField>
              <FormField label="Manual adjustment LYD" hint="Any manual adjustment requires a reason for audit.">
                <input name="manual_adjustment_lyd" type="number" step="0.01" defaultValue={calculation.manualAdjustment} className="field-input" />
              </FormField>
              <div className="md:col-span-2 xl:col-span-3">
                <FormField label="Manual adjustment reason">
                  <textarea name="manual_adjustment_reason" rows={3} defaultValue={calculation.manualAdjustmentReason ?? ""} className="field-input" placeholder="Why was the route pay adjusted manually?" />
                </FormField>
              </div>
            </div>

            {calculation.approvalRequired ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                This route is in the `70+ km` zone. Owner/admin approval is required before final payroll verification.
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">Distance zone</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">{routeDistanceZoneLabel(calculation.distanceZone)}</div>
                <div className="mt-2 text-sm text-slate-500">Applied pay: {moneyLabel(calculation.distancePay)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">Stop pay</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">{moneyLabel(calculation.stopPay)}</div>
                <div className="mt-2 text-sm text-slate-500">{calculation.stopCount} stops / total multiplier {calculation.totalStopMultiplier.toFixed(2)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">Final route pay</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">{moneyLabel(calculation.totalPay)}</div>
                <div className="mt-2 text-sm text-slate-500">Includes extras and manual adjustments.</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button formAction={recalculateRoutePay} className="btn-secondary">Recalculate route pay</button>
              <button formAction={verifyRoutePay} className="btn-primary">Verify route pay</button>
              <ConfirmDialog
                action={markRoutePayDisputed}
                triggerLabel="Mark disputed"
                title="Mark route pay as disputed?"
                description="Disputed routes stay out of clean payroll runs until the pay breakdown is corrected and verified again."
                confirmLabel="Mark disputed"
                buttonClassName="btn-danger"
                confirmButtonClassName="btn-danger"
                hiddenFields={[{ name: "route_id", value: id }]}
                reasonLabel="Dispute reason"
                reasonPlaceholder="Why should this route stay out of payroll right now?"
              />
            </div>
          </form>

          <section className="surface-card mb-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-slate-900">Stop breakdown</h2>
              <p className="mt-1 text-sm text-slate-500">Each stop pays the operator stop rate multiplied by the linked location multiplier.</p>
            </div>
            {!calculation.stopLines.length ? (
              <EmptyState title="No route stops" body="This route currently has no machine stops, so only base pay and route extras can be used." />
            ) : (
              <DataTable headers={["Order", "Machine", "Location", "Distance zone", "Difficulty", "Multiplier", "Stop pay"]}>
                {calculation.stopLines.map((stop) => (
                  <tr key={stop.route_stop_id}>
                    <td>{stop.stop_order}</td>
                    <td>
                      <div className="font-medium text-slate-900">{stop.machine_name}</div>
                      <div className="text-xs text-slate-500">{stop.machine_code ?? "-"}</div>
                    </td>
                    <td>{stop.location_name ?? "-"}</td>
                    <td>{routeDistanceZoneLabel(stop.distance_zone)}</td>
                    <td>{routeAccessDifficultyLabel(stop.access_difficulty)}</td>
                    <td>{stop.normalizedMultiplier.toFixed(2)}</td>
                    <td>{moneyLabel(stop.stopPay)}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>

          <section className="surface-card mb-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Route and stop extras</h2>
                <p className="mt-1 text-sm text-slate-500">Manual extras are audited separately, and automatic cash extras appear when the route has counted cash collections.</p>
              </div>
              <div className="text-sm font-medium text-slate-700">Total extras: {moneyLabel(calculation.extrasPay)}</div>
            </div>

            <form action={saveRoutePayExtra} className="mb-5 grid gap-4 md:grid-cols-5 md:items-end">
              <input type="hidden" name="route_id" value={id} />
              <FormField label="Extra type" required>
                <select name="extra_type" className="field-input" defaultValue="simple_fix_extra">
                  <option value="cash_collection_extra">Cash collection</option>
                  <option value="deep_cleaning_extra">Deep cleaning</option>
                  <option value="simple_fix_extra">Simple fix</option>
                  <option value="emergency_extra">Emergency visit</option>
                  <option value="friday_holiday_extra">Friday / holiday</option>
                  <option value="buying_trip_extra">Buying trip</option>
                  <option value="heavy_load_extra">Heavy load</option>
                </select>
              </FormField>
              <FormField label="Stop (optional)">
                <select name="route_stop_id" className="field-input" defaultValue="">
                  <option value="">Whole route</option>
                  {routeData.stops.map((stop) => (
                    <option key={stop.route_stop_id} value={stop.route_stop_id}>
                      Stop {stop.stop_order} - {stop.machine_name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Amount LYD" hint="Leave blank to use the default rule amount.">
                <input name="amount_lyd" type="number" min="0" step="0.01" className="field-input" placeholder="Optional" />
              </FormField>
              <div className="md:col-span-2">
                <FormField label="Notes">
                  <input name="notes" className="field-input" placeholder="Optional audit note for this extra." />
                </FormField>
              </div>
              <button className="btn-primary md:col-span-5">Add route extra</button>
            </form>

            {!calculation.extraLines.length ? (
              <EmptyState title="No extras recorded" body="Add manual extras here, or counted cash routes will add the default cash collection extra automatically." />
            ) : (
              <DataTable headers={["Source", "Type", "Amount", "Notes", "Action"]}>
                {calculation.extraLines.map((extra) => {
                  const savedExtra = routeData.extras.find((row) => row.route_stop_id === extra.routeStopId && row.extra_type === extra.extraType && Number(row.amount_lyd ?? 0) === extra.amount);
                  return (
                    <tr key={`${extra.source}-${extra.extraType}-${extra.routeStopId ?? "route"}-${extra.amount}`}>
                      <td><StatusBadge status={extra.source} /></td>
                      <td>{routeExtraTypeLabel(extra.extraType)}</td>
                      <td>{moneyLabel(extra.amount)}</td>
                      <td>{extra.notes ?? "-"}</td>
                      <td>
                        {extra.source === "manual" && savedExtra ? (
                          <form action={deleteRoutePayExtra}>
                            <input type="hidden" name="route_id" value={id} />
                            <input type="hidden" name="extra_id" value={savedExtra.id ?? ""} />
                            <button className="btn-danger">Delete</button>
                          </form>
                        ) : (
                          <span className="text-sm text-slate-400">Auto</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            )}
          </section>

          <section className="surface-card">
            <h2 className="text-lg font-semibold text-slate-900">Saved audit summary</h2>
            {!breakdown ? (
              <EmptyState title="No saved route pay breakdown yet" body="Recalculate route pay once to store the audit snapshot that payroll periods and route review will use." />
            ) : (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <div className="text-sm text-slate-500">Last recalculated</div>
                  <div className="mt-1 font-medium text-slate-900">{breakdown.recalculated_at ? new Date(breakdown.recalculated_at).toLocaleString("en-US") : "-"}</div>
                </div>
                <div>
                  <div className="text-sm text-slate-500">Payroll period</div>
                  <div className="mt-1 font-medium text-slate-900">
                    {breakdown.payroll_period_id ? <Link href={`/payroll/periods/${breakdown.payroll_period_id}`} className="link-secondary">Open linked period</Link> : "Not linked yet"}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-slate-500">Manual adjustment</div>
                  <div className="mt-1 font-medium text-slate-900">{moneyLabel(breakdown.manual_adjustment_lyd ?? 0)}</div>
                  <div className="mt-1 text-sm text-slate-500">{breakdown.manual_adjustment_reason ?? "No manual adjustment reason saved."}</div>
                </div>
                <div>
                  <div className="text-sm text-slate-500">Approval</div>
                  <div className="mt-1 font-medium text-slate-900">{breakdown.approval_required ? "Manager approval required" : "No extra approval required"}</div>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
