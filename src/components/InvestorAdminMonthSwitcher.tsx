"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function InvestorAdminMonthSwitcher({
  ar, agreementId, month, months,
}: { ar: boolean; agreementId: string; month: string; months: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <label className="block min-w-0 text-sm font-medium text-slate-700">
    {ar ? "الشهر" : "Month"}
    <select
      aria-label={ar ? "اختر الشهر للمراجعة" : "Select month to review"}
      className="field-input mt-1 w-full sm:w-52"
      disabled={pending}
      value={month}
      onChange={event => {
        const target = event.target.value;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(target)) return;
        startTransition(() => {
          router.replace(`/finance/investors?${new URLSearchParams({agreement: agreementId,month:target})}`, {scroll:false});
        });
      }}>
      {months.map(value => <option key={value} value={value}>{value}</option>)}
    </select>
  </label>;
}
