import {redirect} from 'next/navigation';
import {PersonalWorkToday} from '@/components/PersonalWorkToday';
import {personalWorkContext} from '@/lib/personal-work-server';
import {loadPersonalWork,isPersonalView,isPersonalSection} from '@/lib/personal-work';
export const dynamic='force-dynamic';
export const revalidate=0;
export default async function MyDay({searchParams}:{searchParams:Promise<{view?:string;section?:string}>}){
 const context=await personalWorkContext();
 if(!context.authorized)redirect('/unauthorized');
 const params=await searchParams,view=isPersonalView(params.view)?params.view:'active';
 return <PersonalWorkToday name={context.name} initial={await loadPersonalWork(context.read,view)} initialView={view} initialSection={isPersonalSection(params.section)?params.section:undefined}/>;
}
