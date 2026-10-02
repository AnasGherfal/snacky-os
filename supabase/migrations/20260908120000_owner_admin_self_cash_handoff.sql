-- Owners and admins may personally move a bag they collected into storage.
-- The stored event remains immutable and explicitly records the self-receipt.
-- Every non-owner/admin collector still requires an independent receiver, and
-- the later physical cash count still requires a separate named witness.
create or replace function snacky_private.receive_cash_into_storage_impl(
  p_collection_id uuid,
  p_received_at timestamptz,
  p_storage_location text,
  p_seal_condition text,
  p_evidence_path text,
  p_evidence_file_name text,
  p_notes text,
  p_client_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, snacky_private, pg_temp
as $$
declare
  v_cash public.cash_collections%rowtype;
  v_receiver_id uuid := public.snacky_current_team_member_id();
  v_received_at timestamptz := coalesce(p_received_at, now());
  v_is_owner_admin boolean := public.snacky_current_profile_has_any_role(array['owner', 'admin']);
  v_is_self_receipt boolean;
begin
  if auth.uid() is null or not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance', 'warehouse']) then
    raise exception 'Not authorized to receive cash into storage' using errcode = '42501';
  end if;
  if v_receiver_id is null then
    raise exception 'Your account must be linked to a team member before receiving cash' using errcode = '42501';
  end if;

  if p_client_submission_id is not null and exists (
    select 1 from public.cash_collection_events where client_submission_id = p_client_submission_id
  ) then
    if exists (
      select 1 from public.cash_collection_events
      where client_submission_id = p_client_submission_id
        and cash_collection_id = p_collection_id
        and event_type = 'stored'
    ) then
      return p_collection_id;
    end if;
    raise exception 'Submission ID was already used for a different custody event' using errcode = '23505';
  end if;

  select * into v_cash
  from public.cash_collections
  where id = p_collection_id
  for update;

  if not found then
    raise exception 'Cash collection not found' using errcode = 'P0002';
  end if;
  if v_cash.custody_status <> 'removed' then
    raise exception 'Only a removed bag can be received into storage' using errcode = '23514';
  end if;

  v_is_self_receipt := v_cash.operator_id = v_receiver_id;
  if v_is_self_receipt and not v_is_owner_admin then
    raise exception 'Only an owner or admin may receive a cash bag they personally collected; all other collectors require an independent receiver' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_storage_location, '')), '') is null then
    raise exception 'Storage or safe location is required' using errcode = '22023';
  end if;
  if p_seal_condition not in ('intact', 'broken', 'mismatch') then
    raise exception 'Record whether the bag seal is intact, broken, or mismatched' using errcode = '22023';
  end if;
  if p_seal_condition <> 'intact' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Explain every broken or mismatched seal' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_evidence_path, '')), '') is null then
    raise exception 'A storage receipt photo is required' using errcode = '22023';
  end if;
  if v_received_at < v_cash.collected_at or v_received_at > now() + interval '10 minutes' then
    raise exception 'Storage receipt time must be after removal and cannot be in the future' using errcode = '22023';
  end if;

  update public.cash_collections
  set custody_status = 'in_storage',
      storage_received_at = v_received_at,
      storage_received_by = v_receiver_id,
      storage_location = trim(p_storage_location),
      storage_seal_condition = p_seal_condition,
      storage_notes = nullif(trim(coalesce(p_notes, '')), ''),
      updated_at = now()
  where id = p_collection_id;

  update public.cash_removal_receipts
  set custody_status = 'in_storage',
      storage_received_at = v_received_at,
      storage_received_by = v_receiver_id,
      storage_location = trim(p_storage_location),
      updated_at = now()
  where cash_collection_id = p_collection_id;

  perform snacky_private.append_cash_collection_event(
    p_collection_id,
    'stored',
    v_received_at,
    null,
    p_seal_condition,
    p_evidence_path,
    p_evidence_file_name,
    p_notes,
    jsonb_build_object(
      'storage_location', trim(p_storage_location),
      'cash_bag_id', v_cash.cash_bag_id,
      'self_received_by_owner_admin', v_is_self_receipt and v_is_owner_admin
    ),
    p_client_submission_id
  );

  return p_collection_id;
end;
$$;

revoke all on function snacky_private.receive_cash_into_storage_impl(uuid, timestamptz, text, text, text, text, text, uuid)
  from public, anon;
grant execute on function snacky_private.receive_cash_into_storage_impl(uuid, timestamptz, text, text, text, text, text, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
