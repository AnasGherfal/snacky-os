import type { ReactNode } from 'react';
import { InvestorHistoryLayout } from '@/components/InvestorHistoryLayout';

export const dynamic = 'force-dynamic';

export default function InvestorsLayout({ children }: { children: ReactNode }) {
  return <InvestorHistoryLayout ownerOnly>{children}</InvestorHistoryLayout>;
}
