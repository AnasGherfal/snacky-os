import {CompanyHub} from '@/components/CompanyHub';
export const dynamic='force-dynamic';
export default async function Page({params,searchParams}:{params:Promise<{parts:string[]}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){return <CompanyHub parts={(await params).parts} searchParams={await searchParams}/>;}
