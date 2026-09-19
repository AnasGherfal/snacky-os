import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");
const delivery = read("src/lib/notification-delivery.ts");
const center = read("src/components/NotificationCenter.tsx");
const card = read("src/components/NotificationActivationCard.tsx");
const browser = read("src/lib/push-browser.ts");
const topbar = read("src/components/Topbar.tsx");
const worker = read("public/sw.js");
const pushConfig = read("src/app/api/push-config/route.ts");
const statusApi = read("src/app/api/notifications/push-status/route.ts");
test("one shared activation UI is used by Account and the notification bell", () => {
  assert.match(center, /<NotificationActivationCard compact/);
  assert.match(read("src/app/account/page.tsx"), /<NotificationActivationCard/);
  assert.match(card, /deviceRegistered/);
  assert.match(card, /schemaReady/);
  assert.match(card, /fetch\("\/api\/notifications\/push-status"/);
  assert.doesNotMatch(card, /process\.env\.NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
});
test("stable VAPID configuration and route assignment wiring are preserved", () => {
  assert.match(delivery, /createHmac\("sha256", serverSecret\)/);
  assert.match(delivery, /createECDH\("prime256v1"\)/);
  assert.match(delivery, /webpush\.setVapidDetails/);
  const routeApi = read("src/app/api/routes/route.ts");
  assert.match(routeApi, /notifyRouteAssigned/);
  assert.match(routeApi, /operatorTeamMemberId:\s*operatorId/);
  assert.match(delivery, /type:\s*"route_assigned"/);
});
test("browser subscription recovery and server-saved activation are wired", () => {
  assert.match(browser, /subscriptionMatchesPublicKey/);
  assert.match(card, /await withPushTimeout\(existing\.unsubscribe\(\)\)/);
  assert.match(card, /pushManager\.subscribe/);
  assert.match(card, /fetch\("\/api\/push-subscriptions"/);
  assert.match(card, /fetch\("\/api\/notifications\/test"/);
  assert.match(card, /getPushRegistration/);
  assert.match(read("src/app/api/notifications/test/route.ts"), /sendTestPushNotification/);
  assert.match(read("src/app/api/push-subscriptions/route.ts"), /savePushSubscription/);
});
test("private material never enters browser code or configuration responses", () => {
  for (const file of [center,card,browser,worker,pushConfig,statusApi]) assert.doesNotMatch(file, /VAPID_PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY|privateKey|private_key/);
  assert.match(pushConfig, /publicKey: result\.publicKey/);
  assert.match(statusApi, /publicKey:/);
});
// Retain the executable Topbar/authorization regression coverage from before this change.
function loadModule(source, imports = {}, globals = {}) {
  const exports = {};
  const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(output, {...globals,exports,require(name){assert.ok(name in imports,`Unexpected import: ${name}`);return imports[name];}});
  return exports;
}
function renderTopbar(role, enabled = true, locale = "en", roles = [role]) {
  const authz = loadModule(read("src/lib/authz.ts"));
  const domain = loadModule(read("src/lib/company-hub.ts"), {}, {process:{env:{NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED:enabled?"true":"false"}}});
  const navigation = loadModule(read("src/components/app-navigation.ts"));
  const jsx = (type,props)=>({type,props});
  const NotificationCenter = ()=>null;
  const dictionary = {nav:{},app:{name:"Snacky",subtitle:"Operations"},language:{arabic:"العربية",english:"English"},shell:{}};
  const imports = {
    "react/jsx-runtime":{jsx,jsxs:jsx},"react":{useState:initial=>[initial,()=>{}]},
    "next/image":{default:"img"},"next/link":{default:"a"},
    "next/navigation":{usePathname:()=>"/company",useRouter:()=>({})},
    "lucide-react":{Menu:"menu-icon",UserCircle:"user-icon"},
    "@/components/I18nProvider":{useLanguage:()=>({locale,dictionary,setLocale(){}})},
    "@/components/NotificationCenter":{NotificationCenter},"@/components/app-navigation":navigation,
    "@/lib/company-hub":domain,"@/lib/authz":authz,
  };
  const {Topbar}=loadModule(topbar,imports);
  const tree=Topbar({profile:{id:"fixture",full_name:"Fixture",role,roles}});
  const bells=[];
  function walk(node,ancestors=[]){
    if(Array.isArray(node))return node.forEach(child=>walk(child,ancestors));
    if(!node||typeof node!=="object")return;
    if(node.type===NotificationCenter)bells.push({node,ancestors});
    walk(node.props?.children,[...ancestors,node]);
  }
  walk(tree);return bells;
}
test("actual bell remains visible on desktop and mobile in either language",()=>{
  for(const locale of ["ar","en"]){
    const bells=renderTopbar("operator",true,locale);assert.equal(bells.length,1);assert.equal(bells[0].node.props.compact,true);
    for(const ancestor of bells[0].ancestors)assert.doesNotMatch(ancestor.props?.className??"",/(?:^|\s)(?:[a-z]+:)?hidden(?:\s|$)/);
  }
});
test("relations and other staff receive Company updates without route privileges",()=>{
  for(const role of ["crm","finance","warehouse","purchasing"]){
    const bells=renderTopbar(role);assert.equal(bells.length,1);assert.equal(bells[0].node.props.companyUpdates,true);assert.equal(bells[0].node.props.routeAlerts,false);assert.equal(renderTopbar(role,false).length,0);
  }
});
test("route alerts survive Company being disabled and multi-role staff retain access",()=>{
  for(const role of ["owner","admin","supervisor","operator"])for(const enabled of [false,true]){
    const bells=renderTopbar(role,enabled);assert.equal(bells.length,1);assert.equal(bells[0].node.props.routeAlerts,true);assert.equal(bells[0].node.props.companyUpdates,enabled);
  }
  for(const role of ["investor","viewer"])assert.equal(renderTopbar(role).length,0);
  const mixed=renderTopbar("investor",true,"en",["investor","crm"]);assert.equal(mixed[0].node.props.companyUpdates,true);assert.equal(mixed[0].node.props.routeAlerts,false);
});
test("Company defaults on while the emergency false switch remains effective",()=>{
  for(const [value,expected]of [[undefined,true],["true",true],["false",false]]){
    const domain=loadModule(read("src/lib/company-hub.ts"),{},{process:{env:{NEXT_PUBLIC_SNACKY_COMPANY_HUB_ENABLED:value}}});assert.equal(domain.companyHubEnabled,expected);
  }
});
