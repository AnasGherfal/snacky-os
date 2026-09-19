import {uuidPattern} from './crm-workspace';

export type LeadFilters = Record<string,string>;
export type LeadSearchParams = Record<string,string|string[]|undefined>;
const allowed = ['q','scope','window','status','type','area','assigned_to','archived','practice','created_from','created_to','offset'] as const;

/** All filtering and ordering stay with the existing permission-checked CRM RPC. */
export function leadFilters(params:LeadSearchParams):LeadFilters {
  const out:LeadFilters={};
  for(const key of allowed){
    const value=params[key];
    if(typeof value==='string' && value.trim())out[key]=value.trim().slice(0,4000);
  }
  if(out.offset && !/^\d{1,6}$/.test(out.offset))delete out.offset;
  return out;
}
export function leadListHref(filters:LeadFilters,changes:LeadFilters={}):string {
  const merged={...filters,...changes},query=new URLSearchParams();
  for(const key of allowed){
    if(key==='offset' && !Object.hasOwn(changes,'offset'))continue;
    if(merged[key])query.set(key,merged[key]);
  }
  return '/locations-pipeline'+(query.size?'?'+query.toString():'');
}
export function leadPageRange(total:number,offset:number,count:number):string {
  return count>0?`${offset+1}–${offset+count} / ${total}`:`0 / ${total}`;
}
export function leadDate(value:string|null|undefined,ar:boolean):string {
  if(!value || !/^\d{4}-\d{2}-\d{2}$/.test(value))return ar?'لم يُحدد':'Not scheduled';
  const date=new Date(value+'T12:00:00Z');
  if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==value)return ar?'تاريخ غير صالح':'Invalid date';
  return new Intl.DateTimeFormat(ar?'ar-LY':'en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Tripoli'}).format(date);
}
export function usableLeadId(value:unknown):value is string {
  return typeof value==='string'&&uuidPattern.test(value);
}
export type LeadRow={
  id:string;kind:string;title:string;status:string;priority?:string|null;
  assigned_to?:string|null;assigned_name?:string|null;next_action?:string|null;
  due_date?:string|null;due_time?:string|null;overdue?:boolean;archived?:boolean;is_practice?:boolean;
  data?:{area?:string|null;city?:string|null;place_type?:string|null;contact_person_name?:string|null;contact_phone?:string|null;contact_whatsapp?:string|null;contact_email?:string|null};
};
export type LeadWorkspaceData={
  me:string;staff:boolean;manager:boolean;rows:LeadRow[];
  total:number;offset:number;page_size:number;directory:{id:string;name:string;role?:string}[];
};
