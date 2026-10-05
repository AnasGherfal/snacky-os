import { NextResponse } from 'next/server';
import { productPlanChoices, previewRequiredProducts, ProductPlanError } from '@/lib/smart-work-products-server';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store, max-age=0'};
function errorResponse(error:unknown){return NextResponse.json({error:error instanceof ProductPlanError?error.message:'Product planning is unavailable. No stock was reserved.'},{status:error instanceof ProductPlanError?error.status:503,headers});}
export async function GET(){try{return NextResponse.json(await productPlanChoices(),{headers});}catch(e){return errorResponse(e);}}
export async function POST(request:Request){
  const origin=request.headers.get('origin');
  if(!origin || origin!==new URL(request.url).origin || request.headers.get('sec-fetch-site')==='cross-site')return NextResponse.json({error:'Cross-origin requests are not allowed.'},{status:403,headers});
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return NextResponse.json({error:'JSON request required.'},{status:415,headers});
  try{
    const reader=request.body?.getReader();if(!reader)throw new ProductPlanError('Empty request.',400);
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>4096){await reader.cancel();throw new ProductPlanError('Request is too large.',413);}chunks.push(r.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    let raw:unknown;try{raw=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ProductPlanError('Invalid JSON.',400);}
    return NextResponse.json(await previewRequiredProducts(raw),{headers});
  }catch(e){return errorResponse(e);}
}
