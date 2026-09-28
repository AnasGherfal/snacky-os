import { companySession, companyJson } from '@/lib/company-server';
import { proposalKit, kitMarker, kitUuid } from '@/lib/company-proposal-import';
import type { CompanyWorkspaceData } from '@/lib/company-hub';
export const dynamic = 'force-dynamic';
/** Read-only import status. All writes go through the existing private Company endpoints. */
export async function GET() {
  const session = await companySession();
  if (!session?.manager) return companyJson({ ok: false, message: 'Management permission required.' }, 403);
  try {
    const result = await session.db.rpc('snacky_company_workspace_v1', { p_id: null, p_filters: { section: 'documents', q: kitMarker } });
    if (result.error || !result.data || result.data.manager !== true || !Array.isArray(result.data.rows) || !Array.isArray(result.data.directory) || !Number.isSafeInteger(result.data.total) || result.data.total > 20) throw Error('Library status unavailable.');
    const workspace = result.data as CompanyWorkspaceData;
    const allowed = new Set(proposalKit.map(x => kitUuid(x.digest, 'item')));
    const files = [];
    // Small indexed reads, sequential to avoid multiplying load on the production connection pool.
    for (const entry of proposalKit) {
      const file = await session.db.rpc('snacky_company_file_v1', { p_id: kitUuid(entry.digest, 'file') });
      if (file.error) {
        if (file.error.code === '42501') continue; // Native file RPC returns 42501 for a missing file.
        throw Error('Could not verify registered files.');
      }
      if (!file.data || file.data.id !== kitUuid(entry.digest, 'file') || typeof file.data.digest !== 'string') throw Error('Invalid file metadata.');
      files.push({ id: file.data.id as string, digest: file.data.digest as string });
    }
    return companyJson({ ok: true, data: { user_id: session.profile.id, directory: workspace.directory, records: workspace.rows.filter(x => allowed.has(x.id)), files } });
  } catch {
    return companyJson({ ok: false, message: 'Could not verify the existing kit. No import status has been guessed.' }, 503);
  }
}
