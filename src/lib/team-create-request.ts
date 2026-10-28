export type TeamCreatePayload = {
  full_name: string;
  email: string | null;
  phone: string | null;
  role: string;
  roles: string[];
  crm_focus: string | null;
  can_add_products: boolean;
  active_status: string;
};
export function isTeamCreateRequestId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function sameTeamCreatePayload(existing: TeamCreatePayload, requested: TeamCreatePayload): boolean {
  const same=(a:string|null,b:string|null)=>String(a??"").trim()===String(b??"").trim();
  return same(existing.full_name,requested.full_name)
    && same(existing.email,requested.email)
    && same(existing.phone,requested.phone)
    && same(existing.role,requested.role)
    && JSON.stringify(existing.roles??[])===JSON.stringify(requested.roles??[])
    && same(existing.crm_focus,requested.crm_focus)
    && existing.can_add_products===requested.can_add_products
    && existing.active_status===requested.active_status;
}
