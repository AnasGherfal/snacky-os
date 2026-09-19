'use client';
import Link from 'next/link';
import {CrmLeadQuickLink} from '@/components/CrmLeadQuickLink';
import {crmContactLink,crmHref,crmStatus,locationTypes} from '@/lib/crm-workspace';
import {leadDate,type LeadRow} from '@/lib/crm-lead-list';
import type {FocusSelection} from '@/lib/crm-lead-focus';
import styles from './CrmLeads.module.css';
function Stage({row,ar}:{row:LeadRow;ar:boolean}){
 const positive=['accepted','machine_placed'].includes(row.status),interested=['interested','offer_sent','negotiating'].includes(row.status);
 return <span className={`${styles.stage} ${positive?styles.positive:interested?styles.interested:styles.neutral}`}>{crmStatus(row.status,ar)}</span>;
}
function Flags({row,ar}:{row:LeadRow;ar:boolean}){
 return <>{row.focused?<span className={styles.focusBadge} title={ar?'اختارت الإدارة هذه الجهة للتركيز':'Selected by management'}><span aria-hidden="true">★ </span>{ar?'تركيز حتى':'Focus through'} {leadDate(row.focus_until,ar)}</span>:null}{row.needs_research&&!['machine_placed','rejected'].includes(row.status)?<span className={styles.flag}>{ar?'بيانات التواصل ناقصة':'Contact details needed'}</span>:null}{row.archived?<span className={styles.flag}>{ar?'مؤرشف':'Archived'}</span>:null}{row.is_practice?<span className={styles.flag}>{ar?'تدريب':'Practice'}</span>:null}</>;
}
function Contact({row,ar}:{row:LeadRow;ar:boolean}){
 const d=row.data??{},phone=d.contact_phone,whatsapp=d.contact_whatsapp||phone;
 const call=crmContactLink('phone',phone),chat=crmContactLink('whatsapp',whatsapp),email=crmContactLink('email',d.contact_email);
 return <div className={styles.contact}>{d.contact_person_name?<span className={styles.contactName}>{d.contact_person_name}</span>:null}{phone?<span dir="ltr" className={styles.number}>{phone}</span>:null}<div className={styles.contactActions}>{call?<a href={call} aria-label={`${ar?'اتصال':'Call'} — ${row.title}`}>{ar?'اتصال':'Call'}</a>:null}{chat?<a href={chat} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp — ${row.title}`}>WhatsApp</a>:null}{email?<a href={email} aria-label={`${ar?'بريد':'Email'} — ${row.title}`}>{ar?'بريد':'Email'}</a>:null}</div>{!d.contact_person_name&&!phone&&!chat&&!email?<span className={styles.muted}>{ar?'لا توجد بيانات تواصل':'No contact recorded'}</span>:null}</div>;
}
function NextAction({row,ar}:{row:LeadRow;ar:boolean}){
 if(['machine_placed','rejected'].includes(row.status))return <span className={styles.muted}>{row.status==='machine_placed'?(ar?'متابعة الخدمة في سجل الموقع':'Service follow-up in the location record'):(ar?'انتهت متابعة الفرصة':'Prospecting closed')}</span>;
 return <span className={row.next_action?.trim()?styles.nextAction:styles.missing}>{row.next_action?.trim()||(ar?'حدّد الخطوة القادمة':'Set a next action')}</span>;
}
function Due({row,ar}:{row:LeadRow;ar:boolean}){
 if(['machine_placed','rejected'].includes(row.status))return <span className={styles.muted}>{ar?'لا توجد متابعة مبيعات':'No prospecting due'}</span>;
 return <div className={styles.due}>{row.due_date?<time dateTime={row.due_date}>{leadDate(row.due_date,ar)}</time>:<span className={styles.missing}>{ar?'لم يُحدد موعد':'No date set'}</span>}{row.due_time?<span dir="ltr">{row.due_time.slice(0,5)}</span>:null}{row.overdue?<span className={styles.overdue}>{ar?'متأخر':'Overdue'}</span>:null}</div>;
}
function Owner({row,ar}:{row:LeadRow;ar:boolean}){return <span className={!row.assigned_to?styles.missing:undefined}>{row.assigned_name||(row.assigned_to?(ar?'الاسم غير متاح':'Name unavailable'):(ar?'غير مسند':'Unassigned'))}</span>;}
function LeadName({row,ar}:{row:LeadRow;ar:boolean}){
 const d=row.data??{},type=locationTypes.find(t=>t[0]===d.place_type),meta=[type?.[ar?2:1]??d.place_type,d.area||d.city].filter(Boolean).join(' · ');
 return <div className={styles.nameCell}><Link className={styles.leadName} href={crmHref('lead',row.id)}>{row.title}<span aria-hidden="true" className={styles.openArrow}>↗</span></Link>{meta?<span className={styles.muted}>{meta}</span>:null}{row.status==='machine_placed'&&d.converted_location_id?<Link className={styles.locationLink} href={crmHref('location',d.converted_location_id)}>{ar?'فتح سجل الموقع':'Open location record'}</Link>:null}<div className={styles.flags}><Flags row={row} ar={ar}/></div>{!row.archived?<CrmLeadQuickLink id={row.id} title={row.title} ar={ar}/>:null}</div>;
}
/** Display only: quick controls load current permission-checked detail before offering edits. */
export function CrmLeadTable({rows,ar,selection}:{rows:LeadRow[];ar:boolean;selection?:{items:FocusSelection[];locked:boolean;toggle:(row:LeadRow)=>void}}){
 const select=(row:LeadRow)=>selection?<label className={styles.pick}><input type="checkbox" aria-label={`${ar?'تحديد':'Select'} — ${row.title}`} checked={selection.items.some(x=>x.id===row.id)} disabled={selection.locked||row.archived||['machine_placed','rejected'].includes(row.status)||!row.data?.version||(selection.items.length>=20&&!selection.items.some(x=>x.id===row.id))} onChange={()=>selection.toggle(row)}/><span className={styles.srOnly}>{ar?'تحديد الجهة':'Select lead'}</span></label>:null;
 const headings=ar?['الجهة / المنطقة','التواصل','المرحلة','الخطوة القادمة','موعد المتابعة','الموظف المسؤول']:['Place / area','Contact','Stage','Next action','Follow-up due','Assigned to'];
 return <><div className={styles.desktop}><div className={styles.tableRegion} role="region" aria-label={ar?'جدول الجهات والزيارات؛ يمكن تمريره أفقياً':'Leads and visits table; scroll horizontally when needed'} tabIndex={0}><table className={styles.table}><caption className={styles.srOnly}>{ar?'الجهات المسموح لك بعرضها؛ افتح اسم الجهة لعرض سجلها أو تعديله.':'Permitted leads. Open a place name to view or edit its record.'}</caption><colgroup>{selection?<col style={{width:52}}/>:null}<col style={{width:'23%'}}/><col style={{width:'18%'}}/><col style={{width:'13%'}}/><col style={{width:'23%'}}/><col style={{width:'12%'}}/><col style={{width:'11%'}}/></colgroup><thead><tr>{selection?<th scope="col"><span className={styles.srOnly}>{ar?'اختيار':'Select'}</span></th>:null}{headings.map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.id} className={row.focused?styles.focusRow:row.overdue?styles.lateRow:undefined}>{selection?<td>{select(row)}</td>:null}<th scope="row"><LeadName row={row} ar={ar}/></th><td><Contact row={row} ar={ar}/></td><td><Stage row={row} ar={ar}/>{['high','urgent','critical'].includes(row.priority??'')?<span className={styles.priority}>{ar?'أولوية عالية':'High priority'}</span>:null}</td><td><NextAction row={row} ar={ar}/></td><td><Due row={row} ar={ar}/></td><td><Owner row={row} ar={ar}/></td></tr>)}</tbody></table></div></div>
 <ol className={styles.mobile} aria-label={ar?'الجهات والزيارات':'Leads and visits'}>{rows.map(row=><li key={row.id} className={row.focused?styles.focusRow:row.overdue?styles.lateRow:undefined}><div className={styles.mobileHeading}>{select(row)}<LeadName row={row} ar={ar}/><Stage row={row} ar={ar}/></div><p className={styles.mobileNext}><span className={styles.fieldLabel}>{ar?'الخطوة القادمة':'Next action'}</span><NextAction row={row} ar={ar}/></p><dl className={styles.mobileMeta}><div><dt>{ar?'الموعد':'Due'}</dt><dd><Due row={row} ar={ar}/></dd></div><div><dt>{ar?'الموظف المسؤول':'Assigned to'}</dt><dd><Owner row={row} ar={ar}/></dd></div></dl><Contact row={row} ar={ar}/></li>)}</ol></>;
}
