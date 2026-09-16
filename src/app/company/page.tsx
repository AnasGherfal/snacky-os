import {CompanyHub} from '@/components/CompanyHub';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <CompanyHub searchParams={await searchParams}/>;}
