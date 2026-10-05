import { StartTripError, startRequiredTrip, startTripAvailability } from '@/lib/smart-work-start-trip-server';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
const headers = { 'Cache-Control': 'no-store, private', 'Vary': 'Cookie' };
function errorResponse(error: unknown) {
  if (error instanceof StartTripError) return Response.json({ error: error.message, retryable: error.retryable }, { status: error.status, headers });
  return Response.json({ error: 'Could not confirm the trip. Retry with the same request ID.', retryable: true }, { status: 503, headers });
}
export async function GET() {
  try { return Response.json(await startTripAvailability(), { headers }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: 'Same-origin request required.' }, { status: 403, headers });
  }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return Response.json({ error: 'JSON request required.' }, { status: 415, headers });
  }
  const advertisedSize = request.headers.get('content-length');
  if (advertisedSize && (!/^\d+$/.test(advertisedSize) || Number(advertisedSize) > 4096)) {
    return Response.json({ error: 'Trip request is too large.' }, { status: 413, headers });
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: 'Request body required.' }, { status: 400, headers });
    const parts: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 4096) { await reader.cancel(); return Response.json({ error: 'Trip request is too large.' }, { status: 413, headers }); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const p of parts) { bytes.set(p, offset); offset += p.length; }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return Response.json({ error: 'Invalid JSON request.' }, { status: 400, headers }); }
    const result = await startRequiredTrip(raw);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers });
  } catch (error) { return errorResponse(error); }
}
