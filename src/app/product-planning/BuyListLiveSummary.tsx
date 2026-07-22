"use client";

import { useEffect, useState } from "react";

function money(value: number) {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} LYD`;
}

export function BuyListLiveSummary({
  formId,
  initialCount,
  initialTotal,
  initialMissingCostCount,
}: {
  formId: string;
  initialCount: number;
  initialTotal: number;
  initialMissingCostCount: number;
}) {
  const [summary, setSummary] = useState({ count: initialCount, total: initialTotal, missing: initialMissingCostCount });

  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;

    const update = () => {
      const quantityInputs = new Map(
        Array.from(form.querySelectorAll<HTMLInputElement>("[data-buy-quantity]")).map((input) => [String(input.dataset.buyQuantity ?? ""), input]),
      );
      const lineTotals = new Map(
        Array.from(form.querySelectorAll<HTMLElement>("[data-buy-line-total]")).map((node) => [String(node.dataset.buyLineTotal ?? ""), node]),
      );
      let count = 0;
      let total = 0;
      let missing = 0;

      for (const checkbox of Array.from(form.querySelectorAll<HTMLInputElement>('[data-buy-list-checkbox="true"]'))) {
        const productId = String(checkbox.dataset.productId ?? "");
        const input = quantityInputs.get(productId);
        const output = lineTotals.get(productId);
        const quantity = Math.max(0, Math.floor(Number(input?.value ?? 0) || 0));
        const unitCost = Number(input?.dataset.unitCost ?? Number.NaN);

        if (!checkbox.checked || quantity <= 0) {
          if (output) output.textContent = checkbox.checked ? "0.00 LYD" : "Not in list";
          continue;
        }

        count += 1;
        if (Number.isFinite(unitCost) && unitCost > 0) {
          const lineTotal = Math.round(quantity * unitCost * 100) / 100;
          total += lineTotal;
          if (output) output.textContent = money(lineTotal);
        } else {
          missing += 1;
          if (output) output.textContent = "Cost missing";
        }
      }

      setSummary({ count, total: Math.round(total * 100) / 100, missing });
    };

    update();
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    return () => {
      form.removeEventListener("input", update);
      form.removeEventListener("change", update);
    };
  }, [formId]);

  return (
    <div className="mb-4 grid gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:grid-cols-3" aria-live="polite">
      <div><div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Selected products</div><div className="mt-1 text-2xl font-semibold text-emerald-950">{summary.count}</div></div>
      <div><div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Live estimated total</div><div className="mt-1 text-2xl font-semibold text-emerald-950">{money(summary.total)}</div></div>
      <div><div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Missing last costs</div><div className="mt-1 text-2xl font-semibold text-emerald-950">{summary.missing}</div></div>
    </div>
  );
}
