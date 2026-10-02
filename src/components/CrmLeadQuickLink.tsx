'use client';
import {useRouter} from 'next/navigation';
import styles from './CrmLeadQuickLink.module.css';
export function CrmLeadQuickLink({id,title,ar}:{id:string;title:string;ar:boolean}){
 const router=useRouter();
 return <button type="button" className={styles.quick} aria-label={`${ar?'تحديث سريع':'Quick update'} — ${title}`} onClick={()=>{const url=new URL(window.location.href);url.searchParams.set('quick',id);url.searchParams.delete('quick_action');router.push(url.pathname+url.search,{scroll:false});}}>{ar?'تحديث سريع':'Quick update'}</button>;
}
