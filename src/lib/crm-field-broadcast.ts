export type CrmFieldBroadcastRequest={
  request_id:string;
  issue_id:string;
  title:string;
  due_date:string;
  priority:'low'|'normal'|'high'|'urgent';
  notes?:string;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateCrmFieldBroadcast(value:unknown):CrmFieldBroadcastRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');
 const raw=value as Record<string,unknown>;
 const request_id=String(raw.request_id??''),issue_id=String(raw.issue_id??''),title=String(raw.title??'').trim(),due_date=String(raw.due_date??''),priority=String(raw.priority??'normal') as CrmFieldBroadcastRequest['priority'];
 const notes=raw.notes===undefined?undefined:String(raw.notes);
 if(!uuid.test(request_id)||!uuid.test(issue_id)||title.length<3||title.length>300||!/^(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(due_date)||!['low','normal','high','urgent'].includes(priority))throw Error('invalid');
 if(notes!==undefined&&notes.length>3000)throw Error('invalid');
 return {request_id,issue_id,title,due_date,priority,...(notes===undefined?{}:{notes})};
}
export function crmFieldBroadcastReceiptMatches(request:CrmFieldBroadcastRequest,result:unknown){
 if(!result||typeof result!=='object')return false;
 const row=result as Record<string,unknown>;
 return row.ok===true&&row.request_id===request.request_id&&row.issue_id===request.issue_id&&typeof row.task_id==='string'&&uuid.test(String(row.task_id))&&typeof row.version==='string';
}
