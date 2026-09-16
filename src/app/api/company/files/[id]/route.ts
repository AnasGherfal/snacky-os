import { companyDownloadName } from '@/lib/company-request';
import { NextResponse } from 'next/server';
import { companyUuid } from '@/lib/company-hub';
import {
  companySession,
  companyJson,
  companyHeaders,
} from '@/lib/company-server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params,
    session = await companySession();
  if (!session || !companyUuid.test(id))
    return companyJson({ error: 'Not available.' }, 404);
  const result = await session.db.rpc('snacky_company_file_v1', { p_id: id });
  if (result.error || !result.data)
    return companyJson(
      { error: 'This file is unavailable or access has changed.' },
      404,
    );
  const file = result.data as {
    object_path: string;
    original_name: string;
    mime_type: string;
  };
  const downloaded = await session.db.storage
    .from('company-documents')
    .download(file.object_path);
  if (downloaded.error || !downloaded.data)
    return companyJson(
      {
        error:
          'Could not retrieve the file. No access link has been made public.',
      },
      503,
    );
  const preview =
    new URL(request.url).searchParams.get('preview') === '1' &&
    ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(
      file.mime_type,
    );
  return new NextResponse(new Uint8Array(await downloaded.data.arrayBuffer()), {
    headers: {
      ...companyHeaders,
      'Content-Type': file.mime_type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="snacky-file"; filename*=UTF-8''${encodeURIComponent(companyDownloadName(file.original_name)).replace(/'/g, '%27')}`,
    },
  });
}
