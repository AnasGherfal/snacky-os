import {CrmWorkspace} from '@/components/CrmWorkspace';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{id:string}>}){return <CrmWorkspace section="task" id={(await params).id}/>;}
