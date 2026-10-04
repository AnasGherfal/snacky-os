import { NextResponse } from 'next/server';
import { canManageOperations } from '@/lib/authz';
import { loadTodayWork, previewTodayTrip, requireTodayWorkActor, TodayWorkError } from '@/lib/today-work-server';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0' };

function failure(error: unknown) {
  if (error instanceof TodayWorkError) return NextResponse.json({error:error.message},{status:error.status,headers});
  console.error('[today-work] read failed', error instanceof Error ? error.name : 'unknown');
  return NextResponse.json({error:'The work board could not be verified. Use your existing assigned routes.'},{status:503,headers});
}

export async function GET() {
  try {
    const {profile,db}=await requireTodayWorkActor();
    const work=await loadTodayWork(profile,db);
    return NextResponse.json({board:work.board,myTrips:work.mine,generatedAt:work.generatedAt,
      recommendedMachineIds:work.recommendedMachineIds,canManage:canManageOperations(profile),
      dispatchEnabled:false,mode:'read_only_preview'},{headers});
  } catch(error) { return failure(error); }
}

export async function POST(request:Request) {
  try {
    const {profile,db}=await requireTodayWorkActor();
    const origin=request.headers.get('origin');
    if(origin && origin!==new URL(request.url).origin) throw new TodayWorkError('Cross-origin request rejected.',403);
    const text=await request.text();
    if(text.length>2048) throw new TodayWorkError('Preview request is too large.',400);
    let body:unknown;
    try { body=JSON.parse(text); } catch { throw new TodayWorkError('Invalid preview request.',400); }
    if(!body || typeof body!=='object' || Array.isArray(body)) throw new TodayWorkError('Invalid preview request.',400);
    const payload=body as Record<string,unknown>;
    // Deliberately no claim, reserve, approval, or arbitrary route-write action.
    if(Object.keys(payload).some(key=>key!=='machineIds')) throw new TodayWorkError('This endpoint only previews selected machines.',400);
    const ids=payload.machineIds;
    if(!Array.isArray(ids) || ids.length<1 || ids.length>6 || !ids.every(id=>typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      throw new TodayWorkError('Select one to six valid machines.',400);
    }
    const preview=await previewTodayTrip(profile,db,ids as string[]);
    return NextResponse.json(preview,{headers});
  } catch(error) { return failure(error); }
}
