import Link from 'next/link';
import {getCurrentProfile,getAuthenticatedSupabaseServerClient} from '@/lib/auth';
import {hasAnyRole} from '@/lib/authz';
import {getServerI18n} from '@/lib/i18n/server';
import {collaborationRoles,validateCollaborationWorkspace} from '@/lib/crm-collaboration';
import styles from './CrmCollaboration.module.css';
export async function CrmNotesSummary(){
 const p=await getCurrentProfile();if(!p||p.active_status!=='active'||!hasAnyRole(p,collaborationRoles))return null;
 const {locale}=await getServerI18n(),ar=locale==='ar',manager=hasAnyRole(p,['owner','admin']);let pending:number|null=null;
 try{const db=await getAuthenticatedSupabaseServerClient();if(!db)throw Error('unavailable');const {data,error}=await db.rpc('snacky_crm_collaboration_workspace_v1',{p_kind:'notes',p_id:null,p_filter:'open',p_offset:0}).abortSignal(AbortSignal.timeout(5000));if(error)throw error;const result=validateCollaborationWorkspace(data);if(result.kind==='notes')pending=result.pending;}catch{/* Keep the existing work page available; unknown is not zero. */}
 return <section className={styles.summary} dir={ar?'rtl':'ltr'}><div><strong>{ar?'ملاحظات للإدارة':'Notes to management'}{pending!==null?' · '+pending:''}</strong><p>{pending===null?(ar?'تعذر التحقق من الملاحظات. افتحها لإعادة المحاولة.':'Notes could not be checked. Open them to retry.'):manager?(ar?'مستجدات وطلبات الفريق بانتظار ردك أو المتابعة.':'Team updates and decisions awaiting your reply or follow-up.'):(ar?'سجّلي المستجدات والطلبات هنا، وتابعي رد الإدارة.':'Record updates and requests here, and follow management replies.')}</p></div><Link className={styles.secondary} href="/my-work/notes">{ar?'فتح الملاحظات':'Open notes'}</Link></section>;
}
