do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage schema is not available; skipping Snacky OS storage bucket setup.';
    return;
  end if;

  execute $sql$
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values
      ('product-images', 'product-images', true, 5242880, array['image/png', 'image/jpeg', 'image/webp']),
      ('receipt-images', 'receipt-images', false, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']),
      ('machine-photos', 'machine-photos', false, 10485760, array['image/png', 'image/jpeg', 'image/webp']),
      ('refill-photos', 'refill-photos', false, 10485760, array['image/png', 'image/jpeg', 'image/webp']),
      ('issue-photos', 'issue-photos', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update set
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      updated_at = now()
  $sql$;

  -- Supabase owns storage.objects and manages its RLS setting.
  -- Keep this migration to bucket upserts and policy definitions so it can run in hosted projects.
end $$;

create or replace function public.snacky_storage_has_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and p.role::text = any(allowed_roles)
  );
$$;

create or replace function public.snacky_storage_route_id(object_name text)
returns uuid
language sql
immutable
as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
    else null
  end;
$$;

create or replace function public.snacky_storage_can_access_route(route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.routes r on r.id = route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        p.role::text in ('owner', 'admin', 'supervisor')
        or (p.role::text = 'operator' and p.team_member_id is not null and r.operator_id = p.team_member_id)
      )
  );
$$;

grant execute on function public.snacky_storage_has_role(text[]) to authenticated;
grant execute on function public.snacky_storage_route_id(text) to authenticated;
grant execute on function public.snacky_storage_can_access_route(uuid) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage objects table is not available; skipping Snacky OS storage policies.';
    return;
  end if;

  execute 'drop policy if exists "snacky_product_images_public_read" on storage.objects';
  execute 'drop policy if exists "snacky_product_images_owner_admin_upload" on storage.objects';
  execute 'drop policy if exists "snacky_product_images_owner_admin_update" on storage.objects';
  execute 'drop policy if exists "snacky_product_images_owner_admin_delete" on storage.objects';

  execute 'drop policy if exists "snacky_receipt_images_role_read" on storage.objects';
  execute 'drop policy if exists "snacky_receipt_images_owner_admin_upload" on storage.objects';
  execute 'drop policy if exists "snacky_receipt_images_owner_admin_update" on storage.objects';
  execute 'drop policy if exists "snacky_receipt_images_owner_admin_delete" on storage.objects';

  execute 'drop policy if exists "snacky_machine_photos_authenticated_read" on storage.objects';
  execute 'drop policy if exists "snacky_machine_photos_owner_admin_upload" on storage.objects';
  execute 'drop policy if exists "snacky_machine_photos_owner_admin_update" on storage.objects';
  execute 'drop policy if exists "snacky_machine_photos_owner_admin_delete" on storage.objects';

  execute 'drop policy if exists "snacky_refill_photos_route_read" on storage.objects';
  execute 'drop policy if exists "snacky_refill_photos_assigned_route_upload" on storage.objects';
  execute 'drop policy if exists "snacky_refill_photos_assigned_route_update" on storage.objects';
  execute 'drop policy if exists "snacky_refill_photos_owner_admin_delete" on storage.objects';

  execute 'drop policy if exists "snacky_issue_photos_route_read" on storage.objects';
  execute 'drop policy if exists "snacky_issue_photos_assigned_route_upload" on storage.objects';
  execute 'drop policy if exists "snacky_issue_photos_assigned_route_update" on storage.objects';
  execute 'drop policy if exists "snacky_issue_photos_owner_admin_delete" on storage.objects';

  execute $sql$
    create policy "snacky_product_images_public_read"
    on storage.objects for select
    to public
    using (bucket_id = 'product-images')
  $sql$;

  execute $sql$
    create policy "snacky_product_images_owner_admin_upload"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'product-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_product_images_owner_admin_update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'product-images' and public.snacky_storage_has_role(array['owner', 'admin']))
    with check (bucket_id = 'product-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_product_images_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'product-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_receipt_images_role_read"
    on storage.objects for select
    to authenticated
    using (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin', 'supervisor', 'warehouse', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_receipt_images_owner_admin_upload"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_receipt_images_owner_admin_update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin']))
    with check (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_receipt_images_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'receipt-images' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_machine_photos_authenticated_read"
    on storage.objects for select
    to authenticated
    using (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin', 'supervisor', 'operator', 'warehouse', 'finance']))
  $sql$;

  execute $sql$
    create policy "snacky_machine_photos_owner_admin_upload"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_machine_photos_owner_admin_update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
    with check (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_machine_photos_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'machine-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_refill_photos_route_read"
    on storage.objects for select
    to authenticated
    using (
      bucket_id = 'refill-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_refill_photos_assigned_route_upload"
    on storage.objects for insert
    to authenticated
    with check (
      bucket_id = 'refill-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_refill_photos_assigned_route_update"
    on storage.objects for update
    to authenticated
    using (
      bucket_id = 'refill-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
    with check (
      bucket_id = 'refill-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_refill_photos_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'refill-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;

  execute $sql$
    create policy "snacky_issue_photos_route_read"
    on storage.objects for select
    to authenticated
    using (
      bucket_id = 'issue-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_issue_photos_assigned_route_upload"
    on storage.objects for insert
    to authenticated
    with check (
      bucket_id = 'issue-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_issue_photos_assigned_route_update"
    on storage.objects for update
    to authenticated
    using (
      bucket_id = 'issue-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
    with check (
      bucket_id = 'issue-photos'
      and public.snacky_storage_route_id(name) is not null
      and public.snacky_storage_can_access_route(public.snacky_storage_route_id(name))
    )
  $sql$;

  execute $sql$
    create policy "snacky_issue_photos_owner_admin_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'issue-photos' and public.snacky_storage_has_role(array['owner', 'admin']))
  $sql$;
end $$;
