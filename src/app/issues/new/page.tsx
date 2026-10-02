import {CrmWorkspace,type CrmSearchParams} from '@/components/CrmWorkspace';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<CrmSearchParams>}){
 const params=await searchParams;
 return <CrmWorkspace section="issue" create searchParams={params}/>;
}
