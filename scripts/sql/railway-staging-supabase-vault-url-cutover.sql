-- One-time PUBLIC ENDPOINT cutover for the VERIFIED Snacky Railway staging service.
-- Run using an authorized Supabase SQL administrator after checking the Railway
-- service is receiving the same Snacky operating database. This contains NO
-- vendor credentials or tokens and does not rotate them.
-- Notification worker SQL is in 20261122091500_railway_notification_dispatch_vault_url.sql.
do $railway_cutover$
declare
  v_xy_url_secret uuid;
  v_worker_url_secret uuid;
  v_old_xy_url text;
  v_xy_target constant text := 'https://snacky-os-staging-staging.up.railway.app/api/cron/xy-vms';
  v_notify_target constant text := 'https://snacky-os-staging-staging.up.railway.app/api/notifications/dispatch';
begin
  select id into v_xy_url_secret from vault.secrets where name='xy_vms_scheduler_url';
  if v_xy_url_secret is null then
    raise exception 'XY scheduler URL secret was not found; no cutover was applied';
  end if;
  select decrypted_secret into v_old_xy_url from vault.decrypted_secrets where name='xy_vms_scheduler_url';
  if v_old_xy_url is distinct from v_xy_target
     and v_old_xy_url !~ '^https://snacky-os[.]vercel[.]app/api/cron/xy-vms/?$' then
    raise exception 'XY scheduler URL is not the expected old Vercel URL; review before cutover';
  end if;
  perform vault.update_secret(v_xy_url_secret, v_xy_target);
  select id into v_worker_url_secret from vault.secrets where name='snacky_assignment_dispatch_url';
  if v_worker_url_secret is null then
    perform vault.create_secret(v_notify_target,'snacky_assignment_dispatch_url',
      'Snacky Railway HTTPS notification dispatcher origin');
  else
    perform vault.update_secret(v_worker_url_secret,v_notify_target);
  end if;
end
$railway_cutover$;
