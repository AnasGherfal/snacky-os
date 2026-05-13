"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { PageHeader, PrimaryButton, SecondaryButton, SectionCard } from "@/components/ui";
import { confirmPickList } from "@/lib/operator-actions";

interface PickItem {
  productId: string;
  productName: string;
  quantity: number;
  confirmedQty: number;
}

export default function PickListPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const routeId = params.id;
  const [pickItems, setPickItems] = useState<PickItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Fetch refill order data to build pick list
    const fetchPickList = async () => {
      try {
        const response = await fetch(`/api/operator/routes/${routeId}/pick-list`);
        if (!response.ok) throw new Error("Failed to fetch pick list");
        const data = await response.json();
        setPickItems(
          data.items.map((item: any) => ({
            productId: item.product_id,
            productName: item.product_name,
            quantity: item.final_qty_to_take || item.suggested_qty || 0,
            confirmedQty: item.final_qty_to_take || item.suggested_qty || 0,
          }))
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load pick list");
      } finally {
        setLoading(false);
      }
    };
    fetchPickList();
  }, [routeId]);

  const handleConfirmPick = async () => {
    setSubmitting(true);
    setError("");
    try {
      const items = pickItems.map((item) => ({
        productId: item.productId,
        quantity: item.confirmedQty,
      }));
      await confirmPickList(routeId, items);
      router.push(`/operator/routes/${routeId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm pick list");
      setSubmitting(false);
    }
  };

  const handleQtyChange = (productId: string, qty: number) => {
    setPickItems((prev) =>
      prev.map((item) =>
        item.productId === productId ? { ...item, confirmedQty: Math.max(0, qty) } : item
      )
    );
  };

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-12">
          <p className="text-slate-500">Loading pick list...</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6 max-w-2xl">
        <PageHeader
          title="Pick List"
          subtitle="Collect these items from storage in the quantities shown."
          action={<SecondaryButton href={`/operator/routes/${routeId}`}>Cancel</SecondaryButton>}
        />

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {pickItems.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center">
            <p className="text-slate-500">No items to pick for this route.</p>
          </div>
        ) : (
          <>
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-800">
              <strong>Instructions:</strong> Take exactly the quantities shown below from storage and put them in your operator bag.
            </div>

            <div className="space-y-3">
              {pickItems.map((item) => (
                <div key={item.productId} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex items-end justify-between gap-4">
                    <div className="flex-1">
                      <p className="font-semibold text-slate-900">{item.productName}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        Suggested: {item.quantity} units
                      </p>
                    </div>
                    <div className="flex items-end gap-2">
                      <input
                        type="number"
                        min="0"
                        value={item.confirmedQty}
                        onChange={(e) =>
                          handleQtyChange(item.productId, parseInt(e.target.value) || 0)
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
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Total items</p>
                    <p className="text-2xl font-bold text-slate-900">{pickItems.length}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Total units</p>
                    <p className="text-2xl font-bold text-slate-900">
                      {pickItems.reduce((sum, item) => sum + item.confirmedQty, 0)}
                    </p>
                  </div>
                </div>
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
                onClick={handleConfirmPick}
                disabled={submitting}
                className="flex-1 btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Confirming..." : "Confirm & Start Route"}
              </button>
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
              <strong>Important:</strong> Only pick what you can carry safely. If you cannot take all items, report it to your supervisor. Do not start the route without confirming your pick.
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
