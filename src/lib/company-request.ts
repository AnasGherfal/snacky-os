/** Read untrusted request bodies with a byte limit, including chunked uploads. */
export class CompanyRequestTooLarge extends Error {
  readonly code = 'request_too_large';
  constructor() { super('The request exceeds the supported size.'); }
}
export async function readCompanyBody(request: Request, limit: number): Promise<Uint8Array> {
  const announced = request.headers.get('content-length');
  if (announced && Number(announced) > limit) throw new CompanyRequestTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new CompanyRequestTooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}
export function companyDownloadName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200) || 'snacky-document';
}
