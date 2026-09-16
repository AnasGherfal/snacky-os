# One-shot reviewed source edits. Runs only on the named unmerged feature branch.
# Removed together with its workflow after the verified branch-only commit.
from pathlib import Path

def edit(file,old,new):
 p=Path(file);s=p.read_text();assert s.count(old)==1,(file,old,s.count(old));p.write_text(s.replace(old,new))

edit('src/app/api/company/command/route.ts',"import {revalidatePath}","import {readCompanyBody} from '@/lib/company-request';\nimport {revalidatePath}")
edit('src/app/api/company/command/route.ts',"const text=await request.text();if(text.length>100000)throw new Error('Request too large.');command=validCompanyCommand(JSON.parse(text));", "const bytes=await readCompanyBody(request,256000);command=validCompanyCommand(JSON.parse(new TextDecoder().decode(bytes)));")
edit('src/app/api/company/command/route.ts',"catch{return companyJson", "catch(error){if(error instanceof Error&&'code' in error&&error.code==='request_too_large')return companyFailure(error);return companyJson")
edit('src/app/api/company/files/route.ts',"import {createHash}","import {readCompanyBody} from '@/lib/company-request';\nimport {createHash}")
edit('src/app/api/company/files/route.ts',"const form=await request.formData(),file=", "const bytesBody=await readCompanyBody(request,companyFileLimit+100000);\n  const form=await new Response(bytesBody as BodyInit,{headers:{'Content-Type':request.headers.get('content-type')??''}}).formData(),file=")
edit('src/app/api/company/files/[id]/route.ts',"import {NextResponse}","import {companyDownloadName} from '@/lib/company-request';\nimport {NextResponse}")
edit('src/app/api/company/files/[id]/route.ts',"encodeURIComponent(file.original_name)","encodeURIComponent(companyDownloadName(file.original_name))")
edit('src/lib/company-server.ts'," if(code==='42501')", " if(code==='request_too_large')return companyJson({ok:false,code:'too_large',message:'The request is too large. Use a smaller file or a Drive master link.',retryable:false},413);\n if(code==='42501')")
edit('src/lib/company-hub.ts',"export type CompanyItem = {id:","export type CompanyItem = {has_unpublished_changes?:boolean;id:")
edit('src/components/CompanyHelp.tsx',"const query=section==='lead'?'Visit a potential location':section==='issue'?'Handle a customer issue':section==='obligation'?'Follow up location rent':'';", "const workPath=section==='lead'?'/locations-pipeline':section==='issue'?'/issues':section==='obligation'?'/relationships/obligations':'';")
edit('src/components/CompanyHelp.tsx',"query?`/company/guides?q=${encodeURIComponent(query)}`", "workPath?`/company/guides?work_path=${encodeURIComponent(workPath)}`")
edit('src/components/CompanyHub.tsx',"['q','offset','state','version']","['q','offset','state','version','work_path']")
edit('src/components/CompanyHub.tsx','<PageHeader title={title}', '''{record?<nav aria-label={tr('Breadcrumb','مسار الصفحة')} className="flex flex-wrap items-center gap-2 text-sm text-slate-500 print:hidden"><Link href="/company" className="hover:underline">{tr('Company','الشركة')}</Link><span aria-hidden="true">/</span><Link className="hover:underline" href={`/company/${record.data.section}`}>{companyLabels[record.data.section][ar?1:0]}</Link><span aria-hidden="true">/</span><span aria-current="page" className="break-words text-slate-900">{title}</span></nav>:null}
  <PageHeader title={title}''')
p=Path('src/components/CompanyHub.tsx');s=p.read_text();start=s.index('<style>{`');end=s.index('`}</style>',start)+len('`}</style>')
s=s[:start]+'''<style>{`.company-print-heading { display: none; } @media print {
html, body { background: white !important; height: auto !important; overflow: visible !important; }
.app-shell, .app-shell > div, .app-shell main, .app-shell main > div, .company-hub { display: block !important; height: auto !important; max-height: none !important; overflow: visible !important; }
.app-shell > aside, .app-shell > div > header, .app-shell main nav, .company-hub > :not(.company-print-article):not(style), [class~="print:hidden"] { display: none !important; }
.company-print-heading { display: block; }
.company-print-article { position: static !important; width: 100%; max-width: none !important; margin: 0 !important; border: 0 !important; box-shadow: none !important; padding: 0 !important; }
.company-print-article h1, .company-print-article h2 { break-after: avoid; }
@page { margin: 1.5cm; }
}`}</style>'''+s[end:];p.write_text(s)
edit('src/components/CompanyHub.tsx','company-print-article surface-card space-y-5 break-words','company-print-article surface-card mx-auto max-w-4xl space-y-5 break-words')
edit('src/components/CompanyHub.tsx','<label className="min-w-0 flex-1 text-sm">', '{filters.work_path?<input type="hidden" name="work_path" value={filters.work_path}/>:null}<label className="min-w-0 flex-1 text-sm">')
edit('src/components/CompanyHub.tsx','href={`/company/items/${row.id}`} className="surface-card',"href={`/company/items/${row.id}${section==='manage'&&row.has_unpublished_changes?'?draft=1':''}`} className=\"surface-card")
edit('src/components/CompanyHub.tsx','{row.current_version>0&&row.data.requires_ack',"{manager&&row.has_unpublished_changes?<span className=\"font-semibold text-amber-800\">{tr('Unpublished changes','تعديلات غير منشورة')}</span>:null}{row.current_version>0&&row.data.requires_ack")
file='supabase/migrations/20260916150634_company_hub.sql'
edit(file,'create schema if not exists company_private;',"""-- Fail before writing when the required CRM release is missing.
do $$begin
 if to_regprocedure('public.snacky_crm_workspace_v1(text,uuid,jsonb)') is null
  or to_regprocedure('public.snacky_crm_api_request_guard()') is null
  or not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='crm_storage_boundary') then
  raise exception 'Install and verify the connected-relations release (five 20260915 migrations) before Company Hub.' using errcode='55000';
 end if;
end $$;
create schema if not exists company_private;""")
edit(file,"select auth.uid() is not null and public.snacky_current_team_member_id() is not null", "select auth.uid() is not null and exists(select 1 from public.team_members t where t.id=public.snacky_current_team_member_id() and t.active_status='active' and t.active is not false)")
edit(file,"coalesce(v.data,i.draft) data,v.published_at,r.read_at,r.ack_at,", "(case when manage and s='manage' then i.draft else coalesce(v.data,i.draft) end) data,(manage and (v.data is null or v.data<>i.draft)) has_unpublished_changes,v.published_at,r.read_at,r.ack_at,")
edit(file,"   and (q='' or position", "   and (coalesce(p_filters->>'work_path','')='' or data->>'work_path'=p_filters->>'work_path')\n   and (q='' or position")
p=Path(file);s=p.read_text();needle="public.snacky_current_profile_has_any_role(array['owner','admin']) and split_part(name,'/',1)=auth.uid()::text";assert s.count(needle)==2;s=s.replace(needle,"public.snacky_current_profile_has_any_role(array['owner','admin']) and public.snacky_company_file_access(name) and split_part(name,'/',1)=auth.uid()::text");p.write_text(s)
# Keep the new bounded-body tests in the normal read-only release workflow.
edit('.github/workflows/company-hub-check.yml','scripts/test-company-hub.mjs scripts/test-company-release-gate.mjs','scripts/test-company-hub.mjs scripts/test-company-release-gate.mjs scripts/test-company-request.mjs')
