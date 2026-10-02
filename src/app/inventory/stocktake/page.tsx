import {requireCurrentProfileForPath} from '@/lib/auth';
import {stocktakeUuid} from '@/lib/storage-stocktake';
import {StorageStocktakeWorkspace} from '@/components/StorageStocktakeWorkspace';
export const dynamic='force-dynamic';
export default async function StorageStocktakePage({searchParams}:{searchParams:Promise<{id?:string}>}){
 const profile=await requireCurrentProfileForPath('/inventory/stocktake');
 const query=await searchParams;
 const initialId=typeof query.id==='string'&&stocktakeUuid.test(query.id)?query.id:null;
 return <StorageStocktakeWorkspace userId={profile.id} initialId={initialId}/>;
}
