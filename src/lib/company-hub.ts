/** Shared validation and navigation only. Never place employee/company documents in this file. */
export const companyHubEnabled =
  process.env.NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED === 'true';
export const companyRoles = [
  'owner',
  'admin',
  'supervisor',
  'crm',
  'operator',
  'warehouse',
  'purchasing',
  'finance',
] as const;
export type CompanyRole = (typeof companyRoles)[number];
export const companySections = [
  'start',
  'guides',
  'documents',
  'people',
  'updates',
  'manage',
] as const;
export type CompanySection = (typeof companySections)[number];
export const companyLabels: Record<CompanySection, [string, string]> = {
  start: ['Start Here', 'ابدأ هنا'],
  guides: ['How We Work', 'كيف نعمل'],
  documents: ['Documents & Brand', 'الوثائق والهوية'],
  people: ['People & Responsibilities', 'الأدوار والمسؤوليات'],
  updates: ['Updates & Required Reading', 'التحديثات والقراءة المطلوبة'],
  manage: ['Manage Content', 'إدارة المحتوى'],
};
export const companyRoleLabels: Record<CompanyRole, [string, string]> = {
  owner: ['Owner', 'المالك'],
  admin: ['Administrator', 'الإدارة'],
  supervisor: ['Supervisor', 'المشرف'],
  crm: [
    'Customer Relations & Business Development',
    'علاقات العملاء وتطوير الأعمال',
  ],
  operator: ['Operator', 'المشغّل'],
  warehouse: ['Warehouse', 'المخزن'],
  purchasing: ['Purchasing', 'المشتريات'],
  finance: ['Finance', 'المالية'],
};
export const companyWorkPaths = [
  '/my-work',
  '/my-work/team',
  '/locations-pipeline',
  '/locations-pipeline/new',
  '/issues',
  '/issues/new',
  '/relationships',
  '/relationships/obligations',
  '/follow-ups',
  '/follow-ups/new',
  '/operator/routes',
  '/operator/issues/actions',
  '/inventory',
  '/purchases',
  '/finance',
  '/team',
] as const;
export const companyUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const companyFileLimit = 4_000_000;
export type CompanyContent = {
  title_en: string;
  title_ar: string;
  summary_en: string;
  summary_ar: string;
  body_en: string;
  body_ar: string;
  section: 'start' | 'guides' | 'documents' | 'people';
  audience: CompanyRole[];
  owner_id: string;
  review_date: string;
  source_url: string;
  file_id: string;
  work_path: string;
  external_shareable: boolean;
  requires_ack: boolean;
  notify: boolean;
};
export type CompanyItem = {
  has_unpublished_changes?: boolean;
  id: string;
  revision: number;
  current_version: number;
  archived: boolean;
  owner_name: string | null;
  data: CompanyContent;
  published_at: string | null;
  read_at: string | null;
  ack_at: string | null;
};
export type CompanyWorkspaceData = {
  manager: boolean;
  rows: CompanyItem[];
  total: number;
  offset: number;
  record: CompanyItem | null;
  draft: CompanyContent | null;
  history: {
    version: number;
    published_at: string;
    title_en: string;
    title_ar: string;
  }[];
  acknowledgements: {
    name: string;
    active: boolean;
    read_at: string | null;
    ack_at: string | null;
  }[];
  directory: { id: string; name: string }[];
  attention_count: number;
  required_count: number;
};
export type CompanyCommand = {
  request_id: string;
  action: 'save' | 'publish' | 'archive' | 'restore' | 'read' | 'ack';
  item_id: string;
  revision: number;
  version?: number;
  payload?: CompanyContent;
};
export function companyText(
  data: CompanyContent,
  field: 'title' | 'summary' | 'body',
  ar: boolean,
): string {
  return (
    (ar ? data[`${field}_ar`] : data[`${field}_en`]) ||
    (ar ? data[`${field}_en`] : data[`${field}_ar`])
  );
}
export function emptyCompanyContent(
  section: CompanyContent['section'] = 'guides',
): CompanyContent {
  return {
    title_en: '',
    title_ar: '',
    summary_en: '',
    summary_ar: '',
    body_en: '',
    body_ar: '',
    section,
    audience: ['crm'],
    owner_id: '',
    review_date: '',
    source_url: '',
    file_id: '',
    work_path: '',
    external_shareable: false,
    requires_ack: false,
    notify: false,
  };
}
export function companyMasterUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const u = new URL(text);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    !['drive.google.com', 'docs.google.com'].includes(u.hostname)
  )
    throw new Error('Use a Google Drive or Google Docs HTTPS link.');
  return u.toString();
}
export function validateCompanyContent(input: unknown): CompanyContent {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid content.');
  const raw = input as Record<string, unknown>,
    out = emptyCompanyContent();
  for (const key of [
    'title_en',
    'title_ar',
    'summary_en',
    'summary_ar',
    'body_en',
    'body_ar',
    'owner_id',
    'review_date',
    'source_url',
    'file_id',
    'work_path',
  ] as const) {
    if (typeof raw[key] !== 'string') throw new Error('Invalid text field.');
    const max = key.startsWith('body')
      ? 20000
      : key.startsWith('summary')
        ? 600
        : key.startsWith('title')
          ? 160
          : 2048;
    if (raw[key].length > max) throw new Error('A field is too long.');
    out[key] = raw[key].trim();
  }
  if (!out.title_en && !out.title_ar)
    throw new Error('Add a title in Arabic or English.');
  if (!['start', 'guides', 'documents', 'people'].includes(String(raw.section)))
    throw new Error('Choose a section.');
  out.section = raw.section as CompanyContent['section'];
  if (
    !Array.isArray(raw.audience) ||
    !raw.audience.length ||
    raw.audience.length > companyRoles.length ||
    raw.audience.some((r) => !companyRoles.includes(r as CompanyRole))
  )
    throw new Error('Choose valid staff roles.');
  out.audience = [...new Set(raw.audience)] as CompanyRole[];
  for (const key of ['external_shareable', 'requires_ack', 'notify'] as const) {
    if (typeof raw[key] !== 'boolean')
      throw new Error('Invalid publication setting.');
    out[key] = raw[key];
  }
  for (const key of ['owner_id', 'file_id'] as const)
    if (out[key] && !companyUuid.test(out[key]))
      throw new Error('Invalid reference.');
  if (
    out.review_date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(out.review_date) ||
      Number.isNaN(Date.parse(out.review_date)) ||
      new Date(out.review_date).toISOString().slice(0, 10) !== out.review_date)
  )
    throw new Error('Choose a valid review date.');
  out.source_url = companyMasterUrl(out.source_url);
  if (
    out.work_path &&
    !companyWorkPaths.includes(
      out.work_path as (typeof companyWorkPaths)[number],
    )
  )
    throw new Error('Choose an existing Snacky workspace.');
  return out;
}
export function validCompanyCommand(input: unknown): CompanyCommand {
  if (!input || typeof input !== 'object') throw new Error('Invalid request.');
  const r = input as CompanyCommand;
  if (
    !companyUuid.test(r.request_id) ||
    !companyUuid.test(r.item_id) ||
    !['save', 'publish', 'archive', 'restore', 'read', 'ack'].includes(
      r.action,
    ) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0
  )
    throw new Error('Invalid request identity.');
  if (
    ['read', 'ack'].includes(r.action) &&
    (!Number.isSafeInteger(r.version) || Number(r.version) < 1)
  )
    throw new Error('Invalid document version.');
  return {
    ...r,
    payload:
      r.action === 'save' ? validateCompanyContent(r.payload) : undefined,
  };
}
export function companySameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return Boolean(
    origin &&
      origin === new URL(request.url).origin &&
      request.headers.get('sec-fetch-site') !== 'cross-site',
  );
}

/** Human-readable choices; stored values remain the canonical existing routes. */
const companyWorkLabels: Record<string, [string, string]> = {
  '/my-work': ['My Work', 'عملي اليوم'],
  '/my-work/team': ['Team Work', 'عمل الفريق'],
  '/locations-pipeline': ['Leads & Visits', 'الجهات والزيارات'],
  '/locations-pipeline/new': ['Add a lead', 'إضافة جهة'],
  '/issues': ['Customer Issues', 'مشاكل العملاء'],
  '/issues/new': ['Add a customer issue', 'إضافة مشكلة عميل'],
  '/relationships': ['Existing Locations', 'المواقع الحالية'],
  '/relationships/obligations': ['Location Payments', 'دفعات المواقع'],
  '/follow-ups': ['Follow-ups', 'المتابعات'],
  '/follow-ups/new': ['Add a follow-up', 'إضافة متابعة'],
  '/operator/routes': ['My Routes', 'مساراتي'],
  '/operator/issues/actions': ['Assigned customer actions', 'إجراءات العملاء المسندة إليّ'],
  '/inventory': ['Storage Inventory', 'مخزون المخزن'],
  '/purchases': ['Purchases', 'المشتريات'],
  '/finance': ['Finance', 'المالية'],
  '/team': ['Team', 'الفريق'],
};
export function companyWorkLabel(path: string, ar: boolean): string {
  return companyWorkLabels[path]?.[ar ? 1 : 0] ?? path;
}
