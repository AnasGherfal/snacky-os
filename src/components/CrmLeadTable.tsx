import Link from 'next/link';
import {crmContactLink,crmHref,crmStatus,locationTypes} from '@/lib/crm-workspace';
import {leadDate,type LeadRow} from '@/lib/crm-lead-list';
import styles from './CrmLeads.module.css';

function Stage({row,ar}:{row:LeadRow;ar:boolean}){
  const positive=['accepted','machine_placed'].includes(row.status);
  const interested=['interested','offer_sent','negotiating'].includes(row.status);
  return <span className={`${styles.stage} ${positive?styles.positive:interested?styles.interested:styles.neutral}`}>{crmStatus(row.status,ar)}</span>;
}
function Flags({row,ar}:{row:LeadRow;ar:boolean}){
  return <>{row.archived?<span className={styles.flag}>{ar?'مؤرشف':'Archived'}</span>:null}{row.is_practice?<span className={styles.flag}>{ar?'تدريب':'Practice'}</span>:null}</>;
}
function Contact({row,ar}:{row:LeadRow;ar:boolean}){
  const d=row.data??{},phone=d.contact_phone,whatsapp=d.contact_whatsapp||phone;
  const call=crmContactLink('phone',phone),chat=crmContactLink('whatsapp',whatsapp),email=crmContactLink('email',d.contact_email);
  return <div className={styles.contact}>
    {d.contact_person_name?<span className={styles.contactName}>{d.contact_person_name}</span>:null}
    {phone?<span dir="ltr" className={styles.number}>{phone}</span>:null}
    <div className={styles.contactActions}>
      {call?<a href={call} aria-label={`${ar?'اتصال':'Call'} — ${row.title}`}>{ar?'اتصال':'Call'}</a>:null}
      {chat?<a href={chat} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp — ${row.title}`}>WhatsApp</a>:null}
      {email?<a href={email} aria-label={`${ar?'بريد':'Email'} — ${row.title}`}>{ar?'بريد':'Email'}</a>:null}
    </div>
    {!d.contact_person_name&&!phone&&!chat&&!email?<span className={styles.muted}>{ar?'لا توجد بيانات تواصل':'No contact recorded'}</span>:null}
  </div>;
}
function NextAction({row,ar}:{row:LeadRow;ar:boolean}){
  return <span className={row.next_action?.trim()?styles.nextAction:styles.missing}>{row.next_action?.trim()||(ar?'حدّد الخطوة القادمة':'Set a next action')}</span>;
}
function Due({row,ar}:{row:LeadRow;ar:boolean}){
  return <div className={styles.due}>
    {row.due_date?<time dateTime={row.due_date}>{leadDate(row.due_date,ar)}</time>:<span className={styles.missing}>{ar?'لم يُحدد موعد':'No date set'}</span>}
    {row.due_time?<span dir="ltr">{row.due_time.slice(0,5)}</span>:null}
    {row.overdue?<span className={styles.overdue}>{ar?'متأخر':'Overdue'}</span>:null}
  </div>;
}
function Owner({row,ar}:{row:LeadRow;ar:boolean}){
  return <span className={!row.assigned_to?styles.missing:undefined}>{row.assigned_name||(row.assigned_to?(ar?'الاسم غير متاح':'Name unavailable'):(ar?'غير مسند':'Unassigned'))}</span>;
}
function LeadName({row,ar}:{row:LeadRow;ar:boolean}){
  const d=row.data??{},type=locationTypes.find(t=>t[0]===d.place_type);
  const meta=[type?.[ar?2:1]??d.place_type,d.area||d.city].filter(Boolean).join(' · ');
  return <div className={styles.nameCell}>
    <Link className={styles.leadName} href={crmHref('lead',row.id)}>{row.title}<span aria-hidden="true" className={styles.openArrow}>↗</span></Link>
    {meta?<span className={styles.muted}>{meta}</span>:null}
    <div className={styles.flags}><Flags row={row} ar={ar}/></div>
  </div>;
}

/** Display only: no client-side re-sorting, mutations or unscoped fetches. */
export function CrmLeadTable({rows,ar}:{rows:LeadRow[];ar:boolean}){
  const headings=ar?['الجهة / المنطقة','التواصل','المرحلة','الخطوة القادمة','موعد المتابعة','المسؤول']:['Place / area','Contact','Stage','Next action','Follow-up due','Owner'];
  return <>
    <div className={styles.desktop}>
      <div className={styles.tableRegion} role="region" aria-label={ar?'جدول الجهات والزيارات؛ يمكن تمريره أفقياً':'Leads and visits table; scroll horizontally when needed'} tabIndex={0}>
        <table className={styles.table}>
          <caption className={styles.srOnly}>{ar?'الجهات المسموح لك بعرضها؛ افتح اسم الجهة لعرض سجلها أو تعديله.':'Permitted leads. Open a place name to view or edit its record.'}</caption>
          <colgroup><col style={{width:'23%'}}/><col style={{width:'18%'}}/><col style={{width:'13%'}}/><col style={{width:'23%'}}/><col style={{width:'12%'}}/><col style={{width:'11%'}}/></colgroup>
          <thead><tr>{headings.map(h=><th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{rows.map(row=><tr key={row.id} className={row.overdue?styles.lateRow:undefined}>
            <th scope="row"><LeadName row={row} ar={ar}/></th>
            <td><Contact row={row} ar={ar}/></td>
            <td><Stage row={row} ar={ar}/>{['high','urgent','critical'].includes(row.priority??'')?<span className={styles.priority}>{ar?'أولوية عالية':'High priority'}</span>:null}</td>
            <td><NextAction row={row} ar={ar}/></td><td><Due row={row} ar={ar}/></td><td><Owner row={row} ar={ar}/></td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
    <ol className={styles.mobile} aria-label={ar?'الجهات والزيارات':'Leads and visits'}>
      {rows.map(row=><li key={row.id} className={row.overdue?styles.lateRow:undefined}>
        <div className={styles.mobileHeading}><LeadName row={row} ar={ar}/><Stage row={row} ar={ar}/></div>
        <p className={styles.mobileNext}><span className={styles.fieldLabel}>{ar?'الخطوة القادمة':'Next action'}</span><NextAction row={row} ar={ar}/></p>
        <dl className={styles.mobileMeta}><div><dt>{ar?'الموعد':'Due'}</dt><dd><Due row={row} ar={ar}/></dd></div><div><dt>{ar?'المسؤول':'Owner'}</dt><dd><Owner row={row} ar={ar}/></dd></div></dl>
        <Contact row={row} ar={ar}/>
      </li>)}
    </ol>
  </>;
}
