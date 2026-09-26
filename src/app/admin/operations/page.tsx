import {redirect} from 'next/navigation';
import {OwnerOperationsWorkspace} from '@/components/OwnerOperationsOverview';
import {ownerOperationsContext} from '@/lib/owner-operations-server';
import {loadOperations} from '@/lib/owner-operations';
export const dynamic='force-dynamic';
export const revalidate=0;
export default async function OwnerOperationsPage(){
 const context=await ownerOperationsContext();
 if(!context.authorized)redirect('/unauthorized');
 return <OwnerOperationsWorkspace initial={await loadOperations(context.read)}/>;
}
