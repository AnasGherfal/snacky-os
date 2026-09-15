import type { ReactNode } from 'react';
import { InvestorHistoryLayout } from '@/components/InvestorHistoryLayout';

export const dynamic = 'force-dynamic';

export default function InvestorPortalLayout({ children }: { children: ReactNode }) {
  return <InvestorHistoryLayout>{children}</InvestorHistoryLayout>;
}
