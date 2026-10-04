import { NextResponse } from 'next/server';
import { CoverageInputError } from '@/lib/smart-work-coverage';
import { coverageActor, CoverageAccessError, loadCoverageSettings, saveCoverageSettings } from '@/lib/smart-work-coverage-server';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store, max-age=0'};
function errorResponse(error:unknown) {
  const status=error instanceof CoverageInputError?400:error instanceof CoverageAccessError?error.status:503;
  return NextResponse.json({error:error instanceof CoverageInputError || error instanceof CoverageAccessError?error.message:'Coverage settings are unavailable.'},{status,headers});
}
export async function GET() { try {return NextResponse.json(await loadCoverageSettings(),{headers});} catch(e){return errorResponse(e);} }
export async function PUT(request:Request) {
  try {
    await coverageActor();
    const origin=request.headers.get('origin');
    if (!origin || origin!==new URL(request.url).origin || request.headers.get('sec-fetch-site')==='cross-site') {
      throw new CoverageAccessError('A same-site request is required.',403);
    }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new CoverageInputError('Send JSON settings.');
    const body=await request.text();
    if (body.length>20000) throw new CoverageInputError('Coverage request is too large.');
    let input:unknown;
    try {input=JSON.parse(body);} catch {throw new CoverageInputError('Invalid JSON settings.');}
    return NextResponse.json({saved:await saveCoverageSettings(input)},{headers});
  } catch(e){return errorResponse(e);}
}
