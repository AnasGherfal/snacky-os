-- Expand the existing location pipeline into a lightweight Snacky CRM.
-- This is additive: existing leads and active operational locations are preserved.

alter table public.location_pipeline_leads
  add column if not exists source text not null default 'manual',
  add column if not exists priority text not null default 'normal',
  add column if not exists assigned_to_user_id uuid references public.team_members(id) on delete set null,
  add column if not exists next_action text,
  add column if not exists next_action_date date,
  add column if not exists last_activity_at timestamptz,
  add column if not exists imported_source text,
  add column if not exists imported_category text;

-- The original pipeline constraint predates visit / negotiation stages.
alter table public.location_pipeline_leads
  drop constraint if exists location_pipeline_leads_status_check;

alter table public.location_pipeline_leads
  add constraint location_pipeline_leads_status_check
  check (
    status in (
      'want_to_contact',
      'contacted',
      'interested',
      'meeting_needed',
      'visit_scheduled',
      'visited',
      'offer_sent',
      'negotiating',
      'trial_contract',
      'accepted',
      'rejected',
      'follow_up_later',
      'machine_placed'
    )
  );

alter table public.location_pipeline_leads
  drop constraint if exists location_pipeline_leads_source_check;
alter table public.location_pipeline_leads
  add constraint location_pipeline_leads_source_check
  check (source in ('manual', 'owner', 'customer_support', 'field_outreach', 'inbound', 'referral', 'archive_import', 'other'));

alter table public.location_pipeline_leads
  drop constraint if exists location_pipeline_leads_priority_check;
alter table public.location_pipeline_leads
  add constraint location_pipeline_leads_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));

create index if not exists idx_location_pipeline_leads_assignee
  on public.location_pipeline_leads(assigned_to_user_id, next_action_date);
create index if not exists idx_location_pipeline_leads_next_action
  on public.location_pipeline_leads(next_action_date, status);
create index if not exists idx_location_pipeline_leads_source
  on public.location_pipeline_leads(source, updated_at desc);
create index if not exists idx_location_pipeline_leads_priority
  on public.location_pipeline_leads(priority, updated_at desc);

create table if not exists public.location_pipeline_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.location_pipeline_leads(id) on delete cascade,
  activity_type text not null,
  summary text not null,
  outcome text,
  occurred_at timestamptz not null default now(),
  next_action text,
  next_action_date date,
  created_by_user_id uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint location_pipeline_activities_type_check
    check (activity_type in ('call', 'whatsapp', 'visit', 'meeting', 'proposal', 'email', 'note', 'status_change', 'other')),
  constraint location_pipeline_activities_summary_check
    check (length(trim(summary)) between 1 and 2000)
);

create index if not exists idx_location_pipeline_activities_lead
  on public.location_pipeline_activities(lead_id, occurred_at desc, created_at desc);

-- CRM users can work on prospects and support handoffs without receiving
-- supervisor/finance/inventory privileges.
create or replace function public.snacky_current_profile_can_manage_location_pipeline()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'crm']);
$$;

grant execute on function public.snacky_current_profile_can_manage_location_pipeline() to authenticated;

alter table public.location_pipeline_activities enable row level security;

drop policy if exists "snacky_location_pipeline_activities_select" on public.location_pipeline_activities;
drop policy if exists "snacky_location_pipeline_activities_insert" on public.location_pipeline_activities;
drop policy if exists "snacky_location_pipeline_activities_update" on public.location_pipeline_activities;

create policy "snacky_location_pipeline_activities_select"
on public.location_pipeline_activities for select
to authenticated
using (public.snacky_current_profile_can_manage_location_pipeline());

create policy "snacky_location_pipeline_activities_insert"
on public.location_pipeline_activities for insert
to authenticated
with check (public.snacky_current_profile_can_manage_location_pipeline());

create policy "snacky_location_pipeline_activities_update"
on public.location_pipeline_activities for update
to authenticated
using (public.snacky_current_profile_can_manage_location_pipeline())
with check (public.snacky_current_profile_can_manage_location_pipeline());

grant select, insert, update on public.location_pipeline_activities to authenticated;

-- Import the historical prospect archive supplied by Snacky. Rows that already
-- exist in the CRM, or that already exist as active locations, are not duplicated.
with seed(
  place_name, place_type, area, contact_person_name, contact_person_job_title,
  contact_phone, status, contact_date, notes, priority, imported_category
) as (
  values
    ('جامعة الرفاق', 'university', 'شارع الجمهورية', 'الأستاذ فوزي', 'مدير مكتب البحث العلمي', '913200877', 'contacted', date '2025-12-25', 'بإنتظار رد', 'normal', 'الجهات التي تم التواصل معها'),
    ('أكاديمية الدراسات العليا', 'university', 'روزنج', 'دكتور بشير الشطي', 'مدير قسم إدارة الخدمات', '930995471', 'interested', date '2026-01-13', 'موافقة مبدئية', 'high', 'الجهات التي تم التواصل معها'),
    ('المستشفى الدولي', 'hospital', 'روزنج', 'الأستاذ ابوراوي', 'عضو مجلس الإدارة', null, 'interested', date '2026-01-13', 'موافقة مبدئية', 'high', 'الجهات التي تم التواصل معها'),
    ('عين زارة مول', 'mall', 'عين زارة', 'أستاذة غيداء', 'مسؤولة التسويق', '914334972', 'rejected', date '2026-01-07', 'مرفوض', 'low', 'الجهات التي تم التواصل معها'),
    ('قاليري مول', 'mall', 'بن عاشور', null, null, null, 'visit_scheduled', date '2026-01-17', 'تم التواصل وتحديد موعد للزيارة', 'normal', 'الجهات التي تم التواصل معها'),
    ('فيرست مول', 'mall', null, 'أستاذة رانيا', 'المسؤولة عن المستثمرين', '910649977', 'contacted', date '2026-01-21', 'بإنتظار رد', 'normal', 'الجهات التي تم التواصل معها'),

    ('المتحف الوطني', 'other', 'وسط طرابلس', null, null, null, 'want_to_contact', null, 'جهة مستهدفة من الأرشيف', 'normal', 'الجهات المستهدفة'),
    ('شركة المدار', 'office', 'الرياضية', null, null, null, 'want_to_contact', null, 'جهة مستهدفة من الأرشيف', 'high', 'الجهات المستهدفة'),
    ('شركة ليبيانا', 'office', null, null, null, null, 'want_to_contact', null, 'جهة مستهدفة من الأرشيف', 'high', 'الجهات المستهدفة'),
    ('معهد النفط', 'university', 'السياحية', null, null, null, 'want_to_contact', null, 'جهة مستهدفة من الأرشيف', 'high', 'الجهات المستهدفة'),

    ('مستشفى رويال الطبي', 'hospital', 'الزاوية', 'حسين الشاوش', null, '218954300044', 'interested', date '2025-07-12', null, 'normal', 'الجهات المهتمة'),
    ('مصلحة المرافق التعليمية', 'office', 'سيدي المصري مقابل التضامن', null, null, '927329334', 'interested', null, null, 'normal', 'الجهات المهتمة'),
    ('شركة التداول', 'office', 'في الطريق بين سيمافرو ميزران وسيمافرو المستشفى المرجعي', null, null, '925999091', 'interested', date '2025-11-05', 'مقابل مدرسة 23 علي بعرة يوليو', 'normal', 'الجهات المهتمة'),
    ('مركز وول ستريت انجلش', 'other', 'الجرابة', 'صلاح الشويهدي', 'المدير العام', '915248152', 'interested', date '2025-11-10', 'مركز كورسات', 'normal', 'الجهات المهتمة'),
    ('مصحة إيوان', 'hospital', 'تاجوراء / طريق الشط مقابل المرسى', null, null, '929000767', 'interested', date '2025-09-28', null, 'normal', 'الجهات المهتمة'),
    ('معهد المعرفة للعلوم الهندسية النفطية والعلوم الادارية', 'university', 'جنزور', 'ناجي جابر', null, '912117552', 'interested', date '2025-11-10', null, 'normal', 'الجهات المهتمة'),
    ('مدرسة فتاة الثورة', 'school', null, 'ناجي الدرناوي', null, '0922870172', 'interested', date '2025-10-07', 'تقريبا في 350 طالبة', 'normal', 'الجهات المهتمة'),
    ('مدرسة زهور الوفاء', 'school', 'المدينة الرياضية قرب نادي الأهلي', 'عبدالوهاب عمر المجاني', null, '915173934', 'follow_up_later', date '2025-10-06', '700 طالب / تواصلت معاه وقال العام الجديد', 'normal', 'الجهات المهتمة'),
    ('ثانوية أفريقيا', 'school', 'السراج', 'حواء ادم', null, '913379230', 'interested', date '2025-09-09', 'مدرسة بها 600 طالب و150 معلمة', 'high', 'الجهات المهتمة'),
    ('مدرسة شمس الوطن', 'school', 'عين زارة السدرة', 'بسمة رجب علي بالخير', null, '926770720', 'interested', date '2025-08-28', '800 طالب', 'high', 'الجهات المهتمة'),
    ('مدرسة ابن الهيثم', 'school', 'طرابلس أبونواس', 'محمد غريبة', null, '916160500', 'interested', date '2025-09-24', 'ابتدائي وإعدادي وثانوي', 'normal', 'الجهات المهتمة'),
    ('مدرسة المدارات الدولية', 'school', 'السياحية', null, null, '916957260', 'interested', date '2025-07-06', 'تم موافقتهم بنسبة 10% من المبيعات كإيجار', 'high', 'الجهات المهتمة'),
    ('ترانيم (زناته)', 'other', 'زناته', 'احمد', null, '926760616', 'interested', date '2025-07-07', 'مركز كورسات', 'normal', 'الجهات المهتمة'),
    ('منارات', 'other', 'حي الأندلس', 'احمد', null, null, 'interested', date '2025-07-07', 'مركز كورسات', 'normal', 'الجهات المهتمة'),
    ('المدرسة الكندية', 'school', 'السياحية', null, null, '923320534', 'interested', date '2025-07-23', null, 'normal', 'الجهات المهتمة'),
    ('شركة هواوي', 'office', 'النوفليين', 'علي المقطوف', null, '925928463', 'interested', date '2025-07-24', null, 'high', 'الجهات المهتمة'),
    ('مركز أعمال بوصلة', 'office', 'شارع الاستقلال (المقريف سابقا)', 'ضرار حجازي', null, '910099625', 'interested', date '2025-09-28', 'مساحة عمل', 'normal', 'الجهات المهتمة'),
    ('روضة أورانج', 'school', 'السياحية / سوق القبب حي الوحدة العربية', 'أسماء محمد عريبي', null, '918065207', 'interested', date '2025-07-06', 'روضة', 'normal', 'الجهات المهتمة'),
    ('مدرسة الائتلاف الأفضل للتعليم الفرنسي', 'school', 'خلف مخبز أبونواس', 'فرح بن عثمان', null, '0925174633', 'interested', date '2025-07-08', null, 'normal', 'الجهات المهتمة'),
    ('الكلية الدولية', 'university', 'زناته', 'نبيل', null, '911561483', 'interested', date '2025-07-12', 'مركز كورسات', 'normal', 'الجهات المهتمة'),
    ('مركز عافية لطب الأسنان', 'hospital', '11 يونيو', 'د. سارة الكوحة', null, '927157091', 'interested', date '2025-07-12', 'عيادة', 'normal', 'الجهات المهتمة'),
    ('جامعة طرابلس', 'university', 'طرابلس', null, null, null, 'interested', date '2025-07-23', 'وردت كذلك ضمن الجهات المستهدفة', 'high', 'الجهات المهتمة'),
    ('مختبر السراي', 'hospital', 'حي الأندلس', 'وليد', null, '926161208', 'interested', date '2025-08-16', 'مختبر', 'normal', 'الجهات المهتمة'),
    ('كلية ومعهد طرابلس العالي والمتوسط للعلوم الطبية والإدارية - فرع عين زارة', 'university', 'عين زارة', 'د. أفراح سليم', null, '0945154518 / 910187505', 'interested', date '2025-08-20', null, 'normal', 'الجهات المهتمة'),
    ('كلية ومعهد طرابلس العالي والمتوسط للعلوم الطبية والإدارية - فرع قصر بن غشير', 'university', 'قصر بن غشير', 'عبدالعزيز الدرهوي', null, '926861251', 'interested', date '2025-08-22', null, 'normal', 'الجهات المهتمة'),
    ('معهد ليبيا التميز العالي للعلوم الطبية', 'university', null, null, null, null, 'interested', null, 'معهد خصوصي متوسط وعالي', 'normal', 'الجهات المهتمة'),
    ('مدرسة لسان العرب', 'school', 'السبعة', 'أحمد رجب سليمان', null, '916436072', 'interested', date '2025-08-23', null, 'high', 'الجهات المهتمة'),
    ('XGYM', 'gym', 'طريق الشط - فتحت النادي البحري', 'ناجي بن نوبة', null, '919322228', 'interested', date '2025-08-29', 'صالة رياضة', 'normal', 'الجهات المهتمة'),
    ('أكاديمية باز لعلوم الطيران', 'university', 'السراج', 'ونيس فوزي الشلماني', null, '926737125', 'interested', date '2025-08-30', 'أكاديمية طيران دولية', 'normal', 'الجهات المهتمة'),
    ('أكاديمية سيناء', 'university', 'سوق الجمعة / جزيرة أولاد دياب معيتيقة', 'أمين القماطي', null, '925058379', 'interested', date '2025-08-30', null, 'normal', 'الجهات المهتمة'),
    ('مركز المستقبل للدورات المنهجية', 'other', null, 'إيناس', null, '911135555', 'interested', date '2025-08-31', 'مركز كورسات', 'normal', 'الجهات المهتمة'),
    ('أميرة العباني', 'other', 'تاجوراء الوسط بالقرب من مديرية أمن تاجوراء مقابل كودو تاجوراء', null, null, '942877484', 'interested', date '2025-09-28', 'جديدة، 45 طالب', 'low', 'الجهات المهتمة'),
    ('معهد الوحدة الإفريقية', 'university', null, null, null, null, 'interested', null, 'معهد خصوصي متوسط وعالي', 'normal', 'الجهات المهتمة'),
    ('مدرسة رواد المستقبل', 'school', 'صلاح الدين', 'ميرا شنشاح', null, '917515762', 'interested', date '2025-09-28', null, 'normal', 'الجهات المهتمة'),
    ('شركة بريد ليبيا', 'office', null, null, null, null, 'interested', date '2025-10-09', null, 'high', 'الجهات المهتمة'),
    ('Harvard Little', 'school', 'حي الأندلس', 'أريج زريق', null, '912107665', 'interested', date '2025-10-09', null, 'normal', 'الجهات المهتمة'),
    ('معهد الأروقة الفضية للمهن الشاملة', 'university', 'طريق الـ16 متفرع من 11 يونيو، الشارع مقابل مصرف النوران', 'مهندس عاطف أبو زناد', null, '925153176', 'interested', date '2025-10-09', null, 'normal', 'الجهات المهتمة'),
    ('كلية العلوم الشرعية', 'university', 'تاجوراء', 'د. أحمد', null, '913583297', 'interested', date '2025-10-02', null, 'normal', 'الجهات المهتمة')
)
insert into public.location_pipeline_leads (
  place_name,
  place_type,
  area,
  contact_person_name,
  contact_person_job_title,
  contact_phone,
  first_contact_date,
  last_contact_date,
  status,
  notes,
  priority,
  source,
  imported_source,
  imported_category,
  last_activity_at,
  created_at,
  updated_at
)
select
  seed.place_name,
  seed.place_type::public.location_type,
  seed.area,
  seed.contact_person_name,
  seed.contact_person_job_title,
  seed.contact_phone,
  seed.contact_date,
  seed.contact_date,
  seed.status,
  seed.notes,
  seed.priority,
  'archive_import',
  'أرشيف_الجهات_كامل',
  seed.imported_category,
  case when seed.contact_date is null then null else seed.contact_date::timestamptz end,
  coalesce(seed.contact_date::timestamptz, now()),
  coalesce(seed.contact_date::timestamptz, now())
from seed
where not exists (
  select 1
  from public.location_pipeline_leads existing
  where lower(trim(existing.place_name)) = lower(trim(seed.place_name))
)
and not exists (
  select 1
  from public.locations location
  where lower(trim(coalesce(location.site_name, ''))) = lower(trim(seed.place_name))
);
