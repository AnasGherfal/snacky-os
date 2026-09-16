'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
export type CompanyNoticeState = {
  attention_count: number;
  required_count: number;
};
/** A failed/missing Company module never blocks existing notifications or work. */
export function useCompanyNotices(enabled: boolean) {
  const [data, setData] = useState<CompanyNoticeState | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true,
      busy = false;
    let controller: AbortController | null = null;
    async function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      controller = new AbortController();
      const timer = window.setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch('/api/company/notices', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw Error('Unavailable');
        const result = await response.json();
        if (
          !Number.isSafeInteger(result.attention_count) ||
          !Number.isSafeInteger(result.required_count)
        )
          throw Error('Invalid');
        if (alive) {
          setData(result);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      } finally {
        window.clearTimeout(timer);
        busy = false;
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60000);
    const onRefresh = () => void refresh();
    window.addEventListener('focus', onRefresh);
    window.addEventListener('snacky-company-updated', onRefresh);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', onRefresh);
      window.removeEventListener('snacky-company-updated', onRefresh);
    };
  }, [enabled]);
  return { data, failed };
}
export function CompanyNoticesPanel({
  data,
  failed,
  ar,
  close,
}: {
  data: CompanyNoticeState | null;
  failed: boolean;
  ar: boolean;
  close: () => void;
}) {
  return (
    <section
      className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3"
      dir={ar ? 'rtl' : 'ltr'}
    >
      <h3 className="text-sm font-semibold">
        {ar
          ? 'تحديثات الشركة والقراءة المطلوبة'
          : 'Company updates & required reading'}
      </h3>
      {failed ? (
        <p role="status" className="text-xs">
          {ar
            ? 'تعذر التحقق من التحديثات. هذا لا يعني عدم وجود تحديثات.'
            : 'Could not verify updates. This does not mean there are none.'}
        </p>
      ) : data ? (
        <p className="text-sm">
          {data.attention_count}{' '}
          {ar ? 'تحديث يحتاج انتباهك' : 'updates need your attention'} ·{' '}
          {data.required_count}{' '}
          {ar ? 'إقرار مطلوب' : 'acknowledgements required'}
        </p>
      ) : (
        <p className="text-xs">{ar ? 'جارٍ التحقق…' : 'Checking…'}</p>
      )}
      <Link
        className="btn-secondary min-h-11 w-full"
        href="/company/updates"
        onClick={close}
      >
        {ar ? 'عرض التحديثات' : 'View updates'}
      </Link>
      <p className="text-xs text-slate-500">
        {ar
          ? 'الاطلاع على إشعار لا يُنهي مهمة ولا يسجّل إقراراً.'
          : 'Reading an alert does not complete a task or acknowledge a policy.'}
      </p>
    </section>
  );
}
