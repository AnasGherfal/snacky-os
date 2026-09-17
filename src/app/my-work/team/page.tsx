import {CrmManagement} from '@/components/CrmManagement';
import type {CrmSearchParams} from '@/components/CrmWorkspace';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<CrmSearchParams>}){return <CrmManagement searchParams={await searchParams}/>;}
