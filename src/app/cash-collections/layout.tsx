import Link from 'next/link';
import type { ReactNode } from 'react';
import { getServerI18n } from '@/lib/i18n/server';
export default async function CashCollectionsLayout({ children }: { children: ReactNode }) {
  const { locale } = await getServerI18n();
  return <div className="space-y-4"><div className="surface-card text-sm" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
    <Link href="/cash-handling" className="link-secondary">{locale === 'ar' ? 'تسليم وعد النقد: وضع العلبة في المخزن، استلامها وعدها' : 'Cash handling: storage drop-off, pickup and delegated counting'}</Link>
  </div>{children}</div>;
}
