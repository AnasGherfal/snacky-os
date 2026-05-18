"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ClientAppShell as AppShell } from "@/components/ClientAppShell";
import { QuantityStepper } from "@/components/QuantityStepper";
import { ErrorState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
import { recordLeftovers, completeRoute } from "@/lib/operator-actions";

interface LeftoverItem {
  productId: string;
  productName: string;
  quantity: number;
}

export default function LeftoversPage() {
  const router = useRouter();
  const params = useParams<{ id?: string | string[] }>();
  const rawRouteId = params?.id;
  const routeId = Array.isArray(rawRouteId) ? rawRouteId[0] ?? "" : rawRouteId ?? "";
  const routeHref = routeId ? `/operator/routes/${routeId}` : "/operator";

  const [items, setItems] = useState<LeftoverItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [leftoverQtys, setLeftoverQtys] = useState<Record<string, number>>({});

  useEffect(() => {
    const fetchPickedItems = async () => {
      if (!routeId) {
        setError("Route id is missing. Go back to your operator routes and open the route again.");
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/operator/routes/${routeId}/picked-items`);
        if (!response.ok) throw new Error("Failed to fetch picked items");
        const data = await response.json();
        setItems(data.items || []);
        // Initialize with all quantities (operator will reduce if needed)
        const initialQtys: Record<string, number> = {};
        data.items?.forEach((item: LeftoverItem) => {
          initialQtys[item.productId] = item.quantity;
        });
        setLeftoverQtys(initialQtys);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load picked items");
      } finally {
        setLoading(false);
      }
    };
    fetchPickedItems();
  }, [routeId]);

  const handleCompleteRoute = async () => {
    setSubmitting(true);
    setError("");
    try {
      // Record leftovers
      const leftoverItems = items
        .filter((item) => (leftoverQtys[item.productId] || 0) > 0)
        .map((item) => ({
          productId: item.productId,
          quantity: leftoverQtys[item.productId] || 0,
        }));

      await recordLeftovers({ routeId, leftoverItems });

      // Complete the route
      await completeRoute(routeId);

      router.push("/operator/routes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete route");
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-12">
          <p className="text-slate-500">Loading picked items...</p>
        </div>
      </AppShell>
    );
  }

  if (!routeId) {
    return (
      <AppShell>
        <ErrorState
          title="Route id missing"
          body="This leftovers page was opened without a valid route id."
          action={<SecondaryButton href="/operator">Back to operator home</SecondaryButton>}
        />
      </AppShell>
    );
  }

  const totalLeftovers = Object.values(leftoverQtys).reduce((a, b) => a + b, 0);

  return (
    <AppShell>
      <div className="space-y-6 max-w-2xl">
        <PageHeader
          title="Return Leftovers"
          subtitle="Enter quantities of each product you're returning to storage."
          action={<SecondaryButton href={routeHref}>Back</SecondaryButton>}
        />

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {items.length === 0 ? (
          <div className="rounded-lg bg-blue-50 border border-blue-200 p-6 text-center">
            <p className="text-blue-800 font-medium">No items to return</p>
            <p className="text-sm text-blue-700 mt-1">You used all the stock you picked.</p>
            <button
              onClick={handleCompleteRoute}
              disabled={submitting}
              className="mt-4 btn-primary"
            >
              {submitting ? "Completing..." : "Complete Route"}
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-800">
              <strong>Instructions:</strong> Enter the quantity of each item you're returning to storage. Leave blank or 0 for items you used completely.
            </div>

            <div className="space-y-3">
              {items.map((item) => (
                <div key={item.productId} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-900">{item.productName}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        Picked: {item.quantity} units
                      </p>
                    </div>
                    <div className="w-full sm:w-44">
                      <div className="mb-1 text-xs font-medium text-slate-500">Return units</div>
                      <QuantityStepper
                        value={leftoverQtys[item.productId] || 0}
                        max={item.quantity}
                        onChange={(quantity) => setLeftoverQtys((prev) => ({ ...prev, [item.productId]: quantity }))}
                        inputLabel={`${item.productName} leftover quantity`}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <SectionCard>
              <div className="p-4">
                <div className="text-sm text-slate-500 mb-1">Total leftovers to return</div>
                <div className="text-3xl font-bold text-slate-900">{totalLeftovers}</div>
                <p className="text-xs text-slate-600 mt-2">units</p>
              </div>
            </SectionCard>

            <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-2 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
              <button
                onClick={handleCompleteRoute}
                disabled={submitting}
                className="flex-1 btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Completing..." : "Complete Route"}
              </button>
              <SecondaryButton
                href={routeHref}
                type="button"
              >
                Cancel
              </SecondaryButton>
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
              <strong>Important:</strong> Make sure you've returned all leftover stock to storage and confirmed it with your supervisor before completing your route.
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
