import { NextResponse } from "next/server";
import { DispatchError, dispatchActor, dispatchBoard, dispatchContext, previewDispatch, saveLater } from "@/lib/operator-dispatch-server";

export const dynamic="force-dynamic";
export const maxDuration=60;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers={"Cache-Control":"private, no-store"};
function fail(error:unknown) {
  if (error instanceof DispatchError) return NextResponse.json({error:error.message},{status:error.status,headers});
  console.error("[operator-dispatch] request failed",error);
  return NextResponse.json({error:"Could not complete this request. No unconfirmed trip should be started; refresh to check its status."},{status:503,headers});
}
export async function GET() {
  try {const actor=await dispatchActor();return NextResponse.json(dispatchBoard(actor,await dispatchContext(actor)),{headers});}
  catch(error){return fail(error);}
}
export async function POST(request:Request) {
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new DispatchError("JSON request required.");
    const origin=request.headers.get("origin");
    if ((origin && origin!==new URL(request.url).origin) || request.headers.get("sec-fetch-site")==="cross-site") throw new DispatchError("Cross-site request blocked.",403);
    const actor=await dispatchActor();
    const text=await request.text();if(text.length>16_000) throw new DispatchError("Request is too large.");
    let body:Record<string,unknown>;
    try {body=JSON.parse(text);} catch{throw new DispatchError("Invalid request.");}
    if(!body || Array.isArray(body) || typeof body!=="object") throw new DispatchError("Invalid request.");
    const action=String(body.action ?? "");
    const fields:Record<string,string[]>={preview:["action","machineIds","bypassReason"],claim:["action","draftId","acceptPartial"],later:["action","machineId","time"],release:["action","routeId"]};
    if(!fields[action] || Object.keys(body).some(k=>!fields[action].includes(k))) throw new DispatchError("Unsupported request fields.");
    if(action==="preview") {
      if(!Array.isArray(body.machineIds) || body.machineIds.length>6 || body.machineIds.some(id=>typeof id!=="string" || !uuid.test(id))) throw new DispatchError("Invalid machine selection.");
      const bypassReason=typeof body.bypassReason==="string" ? body.bypassReason.trim().slice(0,500) : "";
      return NextResponse.json(await previewDispatch(actor,body.machineIds as string[],bypassReason),{headers});
    }
    if(action==="claim") {
      if(typeof body.draftId!=="string" || !uuid.test(body.draftId) || (body.acceptPartial!==undefined && typeof body.acceptPartial!=="boolean")) throw new DispatchError("Invalid trip draft.");
      const result=await actor.db.rpc("snacky_dispatch_claim_v1",{p_draft_id:body.draftId,p_actor_user_id:actor.profile.id,p_accept_partial:body.acceptPartial===true});
      if(result.error) throw new DispatchError(result.error.code==="PGRST202" ? "Dispatch setup is not complete." : result.error.message,409);
      if(!result.data?.routeId) throw new DispatchError("Trip confirmation could not be verified. Refresh before retrying.",503);
      return NextResponse.json(result.data,{headers});
    }
    if(action==="later") {
      if(typeof body.machineId!=="string" || !uuid.test(body.machineId) || (body.time!==null && typeof body.time!=="string")) throw new DispatchError("Invalid later plan.");
      await saveLater(actor,body.machineId,body.time as string|null);
      return NextResponse.json({saved:true,reserved:false},{headers});
    }
    if(typeof body.routeId!=="string" || !uuid.test(body.routeId)) throw new DispatchError("Invalid trip.");
    const result=await actor.db.rpc("snacky_dispatch_release_v1",{p_route_id:body.routeId,p_actor_user_id:actor.profile.id,p_expired_only:false});
    if(result.error) throw new DispatchError(result.error.message,409);
    return NextResponse.json({released:result.data===true},{headers});
  }catch(error){return fail(error);}
}
