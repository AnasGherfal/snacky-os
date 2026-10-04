'use client';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export default function BoardRefresh({ ar, generatedAt }: { ar: boolean; generatedAt: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const check = () => setStale(Date.now() - Date.parse(generatedAt) >= 5 * 60_000);
    check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [generatedAt]);
  return <div className="flex flex-wrap items-center gap-3">
    {stale ? <span role="status" className="text-sm font-semibold text-amber-900">{ar ? 'هذه الصفحة قديمة. حدّثها قبل الاعتماد عليها.' : 'This page is old. Refresh before relying on it.'}</span> : null}
    <button type="button" className="btn-secondary min-h-11" disabled={pending} onClick={() => start(() => router.refresh())}>
      {pending ? (ar ? 'جارٍ التحديث…' : 'Refreshing…') : (ar ? 'تحديث القراءات' : 'Refresh readings')}
    </button>
  </div>;
}
