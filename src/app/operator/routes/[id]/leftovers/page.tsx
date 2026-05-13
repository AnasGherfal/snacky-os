"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { PageHeader, SecondaryButton, SectionCard, PrimaryButton } from "@/components/ui";
import { recordLeftovers, completeRoute } from "@/lib/operator-actions";

interface LeftoverItem {
  productId: string;
  productName: string;
  quantity: number;
}

export default function LeftoversPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const routeId = params.id;

  const [items, setItems] = useState<LeftoverItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [leftoverQtys, setLeftoverQtys] = useState<Record<string, number>>({});

  useEffect(() => {
    const fetchPickedItems = async () => {
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

  const totalLeftovers = Object.values(leftoverQtys).reduce((a, b) => a + b, 0);

  return (
    <AppShell>
      <div className="space-y-6 max-w-2xl">
        <PageHeader
          title="Return Leftovers"
          subtitle="Enter quantities of each product you're returning to storage."
          action={<SecondaryButton href={`/operator/routes/${routeId}`}>Back</SecondaryButton>}
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
                  <div className="flex items-end justify-between gap-4">
                    <div className="flex-1">
                      <p className="font-semibold text-slate-900">{item.productName}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        Picked: {item.quantity} units
                      </p>
                    </div>
                    <div className="flex items-end gap-2">
                      <input
                        type="number"
                        min="0"
                        max={item.quantity}
                        value={leftoverQtys[item.productId] || 0}
                        onChange={(e) =>
                          setLeftoverQtys((prev) => ({
                            ...prev,
                            [item.productId]: Math.max(
                              0,
                              Math.min(item.quantity, parseInt(e.target.value) || 0)
                            ),
                          }))
                        }
                        className="field-input w-20"
                      />
                      <span className="text-xs text-slate-500 mb-2">units</span>
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

            <div className="flex gap-3">
              <SecondaryButton
                href={`/operator/routes/${routeId}`}
                type="button"
              >
                Cancel
              </SecondaryButton>
              <button
                onClick={handleCompleteRoute}
                disabled={submitting}
                className="flex-1 btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Completing..." : "Complete Route"}
              </button>
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
