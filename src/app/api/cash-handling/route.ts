import { NextResponse } from 'next/server';
import { getCurrentProfile, getAuthenticatedSupabaseServerClient } from '@/lib/auth';
import { hasAnyRole } from '@/lib/authz';
import { getSupabaseAdminClient } from '@/lib/supabase-server';
import { uploadCashEvidence } from '@/lib/cash-evidence';
import { CASH_PHOTO_UPLOAD_LIMIT } from '@/lib/cash-photo';
import { CASH_EVIDENCE_BUCKET } from '@/lib/storage-buckets';
import { readCompanyBody } from '@/lib/company-request';
import { cashHandlingRoles, cashUuid, cashSameOrigin, validateCashCommand, cashReceiptMatches, isUnnumberedCashReference, type CashCommand, type CashWorkspace } from '@/lib/cash-handover';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const denied = () => json({ ok: false, code: 'denied' }, 403);
async function context() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== 'active' || !profile.team_member_id || !hasAnyRole(profile, cashHandlingRoles)) return null;
  const db = await getAuthenticatedSupabaseServerClient();
  return db ? { profile, db } : null;
}
function rpcFailure(error: { code?: string }, read = false) {
  const code = error.code === '42501' ? 'denied' : ['40001', '23505'].includes(error.code ?? '') ? 'conflict'
    : ['22023', '22P02', '23514', '23502', '23503'].includes(error.code ?? '') ? 'invalid' : read ? 'unavailable' : 'uncertain';
  return json({ ok: false, code, retryable: code === 'uncertain' }, code === 'denied' ? 403 : code === 'conflict' ? 409 : code === 'invalid' ? 400 : 503);
}
export async function GET(request: Request) {
  try {
    const ctx = await context(); if (!ctx) return denied();
    const url = new URL(request.url), id = url.searchParams.get('id'), status = url.searchParams.get('status') ?? 'open', offset = url.searchParams.get('offset') ?? '0';
    if ((id && !cashUuid.test(id)) || !['open', 'counted', 'all'].includes(status) || !/^(0|[1-9][0-9]{0,5})$/.test(offset) || Number(offset) > 100000) return json({ ok: false, code: 'invalid' }, 400);
    const { data, error } = await ctx.db.rpc('snacky_cash_handover_workspace_v1', { p_id: id, p_status: status, p_offset: id ? 0 : Number(offset) });
    if (error || !data) return rpcFailure(error ?? {}, true);
    const view = data as CashWorkspace;
    if (id && view.rows[0]) {
      const machineLines = await ctx.db.rpc('snacky_cash_collection_machine_lines_v1', { p_collection_id: id });
      if (machineLines.error) return rpcFailure(machineLines.error, true);
      if (Array.isArray(machineLines.data)) {
        view.rows[0].machines = machineLines.data as CashWorkspace['rows'][number]['machines'];
      }
    }
    // The database has already scoped each record. Sign only paths returned by
    // that projection, never a client-supplied path or a broader table query.
    for (const row of view.rows) {
      const path = row.evidence_path; delete row.evidence_path;
      row.evidence_url = null;
      if (id && path) {
        const storage = getSupabaseAdminClient();
        const signed = await storage?.storage.from(CASH_EVIDENCE_BUCKET).createSignedUrl(path, 300);
        if (signed?.data) row.evidence_url = signed.data.signedUrl;
      }
    }
    return json({ ok: true, data: view });
  } catch { return json({ ok: false, code: 'unavailable' }, 503); }
}
export async function POST(request: Request) {
  if (!cashSameOrigin(request)) return denied();
  let command: CashCommand;
  let photo: FormDataEntryValue | null = null;
  const ctx = await context(); if (!ctx) return denied();
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      const bytes = await readCompanyBody(request, CASH_PHOTO_UPLOAD_LIMIT + 16000);
      const form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': contentType }, body: new Uint8Array(bytes).buffer }).formData();
      command = validateCashCommand(JSON.parse(String(form.get('command')))); photo = form.get('photo');
      if (Array.from(form.keys()).some(k => !['command', 'photo'].includes(k)) || form.getAll('command').length !== 1 || form.getAll('photo').length > 1) throw Error('invalid');
    } else if (contentType.startsWith('application/json')) {
      command = validateCashCommand(JSON.parse(new TextDecoder().decode(await readCompanyBody(request, 16000))));
    } else throw Error('invalid');
  } catch { return json({ ok: false, code: 'invalid', retryable: false }, 400); }
  try {
    // Resolve committed retries before uploading or checking the current stage.
    const saved = await ctx.db.rpc('snacky_cash_handover_receipt_v1', { p_command: command });
    if (saved.error) return rpcFailure(saved.error);
    if (saved.data) return cashReceiptMatches(command, saved.data) ? json(saved.data) : json({ ok: false, code: 'uncertain', retryable: true }, 503);
    // A generated tracking reference cannot prove the physical bag is sealed.
    // The dedicated unnumbered flows always flag the exception and require
    // photo matching; reject any generic action pretending the seal is intact.
    if (command.collection_id && ['dropoff','pickup','direct_pickup','takeover'].includes(command.action)) {
      const current = await ctx.db.rpc('snacky_cash_handover_workspace_v1', {
        p_id: command.collection_id, p_status: 'open', p_offset: 0,
      });
      if (current.error || !current.data) return rpcFailure(current.error ?? {}, true);
      const recorded = (current.data as CashWorkspace).rows.find(row => row.id === command.collection_id);
      if (!recorded) return denied();
      if (isUnnumberedCashReference(recorded.bag) &&
          (command.payload.seal_condition !== 'mismatch' ||
           !String(command.payload.notes ?? '').includes('UNNUMBERED CASH BAG'))) {
        return json({ ok: false, code: 'invalid', retryable: false,
          message: 'A digital tracking reference is not a verified physical bag seal. Use the unnumbered bag receive/deposit workflow.' }, 400);
      }
    }
    let path: string | null = null;
    if (command.action === 'dropoff') {
      const scope = await ctx.db.rpc('snacky_cash_handover_workspace_v1', { p_id: command.collection_id });
      if (scope.error) return rpcFailure(scope.error, true);
      const box = (scope.data as CashWorkspace)?.rows[0];
      if (!box?.actions.includes('dropoff')) return denied();
      if (box.revision !== command.revision) return rpcFailure({ code: '40001' });
      if (!(photo instanceof File) || !['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) || !photo.size || photo.size > CASH_PHOTO_UPLOAD_LIMIT) return json({ ok: false, code: 'photo', retryable: true }, 400);
      try {
        const evidence = await uploadCashEvidence(photo, { scopeId: `cash-handover-${ctx.profile.id}-${command.request_id}`, stage: 'stored', required: true });
        path = evidence?.path ?? null;
      } catch { return json({ ok: false, code: 'photo', retryable: true }, 400); }
    }
    const { data, error } = await ctx.db.rpc('snacky_cash_handover_command_v1', { p_command: command, p_evidence_path: path });
    // Do not delete evidence after an ambiguous transport failure: the database
    // may have committed and a retry must recover the same recorded handover.
    if (error) return rpcFailure(error);
    if (!cashReceiptMatches(command, data)) return json({ ok: false, code: 'uncertain', retryable: true }, 503);
    // Once an independent physical count is committed, calculate the exact
    // cash-only XY interval when the actor is allowed to review financials.
    // This is best-effort: missing VMS rows remain unverified, never zero.
    // Do not automatically approve, reconcile or deduct a variance.
    if (command.action === 'count' && command.collection_id && hasAnyRole(ctx.profile, ['owner','admin','finance'])) {
      try {
        const xy = await ctx.db.rpc('calculate_cash_collection_expectation', {
          p_collection_id: command.collection_id,
          p_client_submission_id: crypto.randomUUID(),
        });
        if (xy.error) console.warn('[cash] XY expectation pending after count', { code: xy.error.code });
      } catch {
        console.warn('[cash] XY expectation could not be checked automatically');
      }
    }
    return json(data);
  } catch { return json({ ok: false, code: 'uncertain', retryable: true }, 503); }
}
