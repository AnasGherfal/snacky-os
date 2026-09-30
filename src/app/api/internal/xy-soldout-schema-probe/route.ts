import { NextResponse } from "next/server";
import { buildXySign, getXyVmsConfig, normalizeXyApiResponse } from "@/lib/xy-vms-api";

type Params = Record<string, string | number | boolean>;
const TOKEN = "xy-soldout-probe-20260930";
const FAKE_MACHINE = "SNACKY_FAKE_CLEAR_SLOT";

function clean(params: Params) {
  return Object.fromEntries(Object.entries(params).filter(([,v]) => String(v ?? "").trim() !== "")) as Params;
}

async function call(path: string, params: Params) {
  const config=getXyVmsConfig();
  const timestamp=Date.now().toString().padStart(13,"0");
  const businessParams=clean(params);
  const body=config.includeAuthFields?{
    key:config.key,
    timestamp,
    sign:buildXySign(config.secret,timestamp,businessParams),
    ...businessParams,
  }:businessParams;
  const serviceRoot=config.baseUrl.replace(/\/api\/?$/,"");
  const response=await fetch(`${serviceRoot}${path}`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(body),
    cache:"no-store",
    signal:AbortSignal.timeout(15000),
  });
  const text=await response.text();
  let parsed:Record<string,unknown>={};
  try { parsed=text?normalizeXyApiResponse(JSON.parse(text)) as Record<string,unknown>:{}; }
  catch { parsed={raw:text.slice(0,400)}; }
  const nested=parsed.data&&typeof parsed.data==="object"&&!Array.isArray(parsed.data)?parsed.data as Record<string,unknown>:{};
  return {
    requestKeys:Object.keys(businessParams),
    httpStatus:response.status,
    code:parsed.code??parsed.status??parsed.statusCode??null,
    message:String(parsed.message??parsed.msg??nested.msg??"").trim()||null,
    keys:Object.keys(parsed).filter(k=>k!=="rawEnvelope").slice(0,20),
    data:parsed.data??null,
  };
}

export async function GET(request:Request){
  const url=new URL(request.url);
  if(url.searchParams.get("token")!==TOKEN){
    return NextResponse.json({error:"Not found"},{status:404});
  }
  const config=getXyVmsConfig();
  if(!config.ready){
    return NextResponse.json({error:"XY not ready",missing:config.missing},{status:503});
  }
  const base={shbh:config.merchantId,jqbh:FAKE_MACHINE};
  const probes=[
    {...base,hdbh:"000"},
    {...base,hdbh:"000",spbh:"0001"},
    {...base,spbh:"0001"},
    {...base,hdbh:"000",dsfspbh:"0001"},
    {...base,hdbh:"000",spbh:"0001",sl:0},
    {...base,hdbh:"000",spbh:"0001",num:0},
  ];
  const results=[];
  for(const params of probes){
    try{results.push(await call("/api/v2/soldOutMachineGoods",params));}
    catch(error){results.push({requestKeys:Object.keys(params),error:error instanceof Error?error.message:String(error)});}
  }
  return NextResponse.json({fakeMachine:FAKE_MACHINE,results});
}
