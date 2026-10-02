import {CrmWorkspace,type CrmSearchParams} from '@/components/CrmWorkspace';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<CrmSearchParams>}){return <CrmWorkspace section="location" searchParams={await searchParams}/>;}
