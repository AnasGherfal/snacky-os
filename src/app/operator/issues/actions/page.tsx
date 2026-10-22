import { redirect } from 'next/navigation';
/** Field work lives in Machine issues, not a second CRM task list. */
export default function Page(){ redirect('/operator/issues'); }
