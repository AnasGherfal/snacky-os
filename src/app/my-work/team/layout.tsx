import type {ReactNode} from 'react';
import {crmRecurringEnabled} from '@/lib/crm-recurring';
import styles from './management.module.css';

export default function Layout({children}:{children:ReactNode}) {
  if (!crmRecurringEnabled) return <>{children}</>;
  return <div className={styles.workspace}>{children}</div>;
}
