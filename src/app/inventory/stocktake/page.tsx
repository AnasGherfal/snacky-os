import {requireCurrentProfileForPath} from '@/lib/auth';
import {StorageStocktakeWorkspace} from '@/components/StorageStocktakeWorkspace';

export const dynamic='force-dynamic';

export default async function StorageStocktakePage(){
 const profile=await requireCurrentProfileForPath('/inventory/stocktake');
 return <StorageStocktakeWorkspace userId={profile.id}/>;
}
