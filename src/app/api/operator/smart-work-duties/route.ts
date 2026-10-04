import { NextResponse } from 'next/server';
import { DutyAccessError, loadDutyBoard, refreshDutyBoard } from '@/lib/smart-work-duties-server';
import { parseDutyRefresh } from '@/lib/smart-work-duties';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store, max-age=0'};
function failure(error:unknown) {
  return NextResponse.json({error:error instanceof DutyAccessError?error.message:'Daily duties are unavailable.'},{status:error instanceof DutyAccessError?error.status:503,headers});
}
export async function GET(){try{return NextResponse.json(await loadDutyBoard(),{headers});}catch(error){return failure(error);}}
export async function POST(request:Request){
  const origin=request.headers.get('origin');
  if(!origin || origin!==new URL(request.url).origin) return NextResponse.json({error:'Same-origin request required.'},{status:403,headers});
  if(!(request.headers.get('content-type')||'').startsWith('application/json')) return NextResponse.json({error:'JSON required.'},{status:400,headers});
  try {
    const text=await request.text();if(text.length>256) throw new Error('Too large');parseDutyRefresh(JSON.parse(text));
  }catch{return NextResponse.json({error:'Use the Refresh duties button. Custom assignments are not accepted.'},{status:400,headers});}
  try{return NextResponse.json(await refreshDutyBoard(),{headers});}catch(error){return failure(error);}
}
