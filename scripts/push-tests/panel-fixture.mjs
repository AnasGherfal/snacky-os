// Real React notification components; only Next/UI icons and browser/API boundaries
// are replaced. No production account, subscription or network request is used.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const root=path.resolve(import.meta.dirname,'../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const transpile=p=>ts.transpileModule(read(p),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const modules={};
for(const [id,pkg,file] of [
 ['react','react','cjs/react.development.js'],
 ['react/jsx-runtime','react','cjs/react-jsx-runtime.development.js'],
 ['react-dom','react-dom','cjs/react-dom.development.js'],
 ['react-dom/client','react-dom','cjs/react-dom-client.development.js'],
 ['scheduler','scheduler','cjs/scheduler.development.js'],
]) modules[id]=fs.readFileSync(path.join(path.dirname(require.resolve(pkg+'/package.json')),file),'utf8');
for(const name of ['NotificationCenter','NotificationActivationCard','CompanyNotices']) modules['@/components/'+name]=transpile('src/components/'+name+'.tsx');
modules['@/lib/push-browser']=transpile('src/lib/push-browser.ts');
modules['./NotificationCenter.module.css']='module.exports={panel:"panel",header:"panel-header",body:"panel-body"};';
modules['next/link']='module.exports=function Link(props){return require("react").createElement("a",props,props.children);};';
modules['lucide-react']='for(const name of ["Bell","CheckCheck","X","BellRing","Loader2"])exports[name]=function Icon(props){return require("react").createElement("span",{...props,"aria-hidden":true},name==="X"?"×":"●");};';
modules['@/components/I18nProvider']='exports.useLanguage=()=>({locale:new URLSearchParams(window.fixtureParams || location.search).get("locale")||"en"});';
function cssFiles(dir){return fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(f=>f.isDirectory()?cssFiles(path.join(dir,f.name)):f.name.endsWith('.css')?[path.join(dir,f.name)]:[]):[];}
const styles=cssFiles(path.join(root,'.next/static')).map(p=>fs.readFileSync(p,'utf8')).join('\n');
if(!styles)throw Error('Build Snacky OS first; this fixture uses actual compiled app CSS.');
const panelCss=read('src/components/NotificationCenter.module.css').replaceAll('.header','.panel-header').replaceAll('.body','.panel-body');
const boot=`
const params=new URLSearchParams(window.fixtureParams || location.search);const ar=params.get('locale')==='ar';
document.documentElement.dir=ar?'rtl':'ltr';document.documentElement.lang=ar?'ar':'en';
if(params.get('large'))document.documentElement.style.fontSize='20px';
let enabled=params.get('mode')!=='fresh';const key=new Uint8Array(65).fill(5);key[0]=4;
const pub=btoa(String.fromCharCode(...key)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',options:{applicationServerKey:key.buffer},toJSON:()=>({endpoint:subscription.endpoint,keys:{p256dh:pub,auth:'AAAAAAAAAAAAAAAAAAAAAA'}}),unsubscribe:async()=>true};
const registration={active:true,pushManager:{getSubscription:async()=>subscription,subscribe:async()=>subscription}};
Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:async()=>registration,register:async()=>registration,ready:Promise.resolve(registration)}});
Object.defineProperty(window,'Notification',{configurable:true,value:{permission:'granted',requestPermission:async()=>'granted'}});
Object.defineProperty(window,'PushManager',{configurable:true,value:function(){}});
const match=window.matchMedia.bind(window);window.matchMedia=q=>q.includes('display-mode')?{matches:true}:match(q);
window.testCalls=[];
window.fetch=async(url,options={})=>{
 const mode=params.get('mode');const body=options.body?JSON.parse(options.body):{};
 const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
 if(url==='/api/company/notices')return json({attention_count:4,required_count:2});
 if(url==='/api/notifications?limit=6')return json({unreadCount:6,notifications:Array.from({length:6},(_,i)=>({id:String(i),title:ar?'تحديث طويل من سناكي':'Snacky route update '+i,message:(ar?'تفاصيل الإشعار للمراجعة ':'Notification details for review ').repeat(12),action_url:'/account',read_at:null,created_at:'2026-09-19T12:00:00Z'}))});
 if(url==='/api/notifications/push-status')return json({configured:true,schemaReady:mode!=='schema',publicKey:pub,deviceRegistered:enabled,activeSubscriptions:mode==='schema'?null:enabled?1:0});
 if(url==='/api/push-subscriptions'){enabled=options.method!=='DELETE';return json(options.method==='DELETE'?{disabled:true}:{saved:true});}
 if(url==='/api/notifications/test'){
   window.testCalls.push(body);
   if(mode==='failure')return json({sent:false,error:ar?'تعذر توثيق الخادم لدى خدمة الإشعارات. يجب على الإدارة التحقق من إعداد خدمة الإشعارات في الخادم.':'The server could not authenticate with the push service. Ask the administrator to check the server push configuration.',code:'push_server_configuration'},503);
   return json(body.delaySeconds===15?{scheduled:true,sent:false}:{sent:true,acceptedCount:1});
 }
 throw Error('Unexpected fixture request '+url);
};
const factories=${JSON.stringify(modules).replaceAll("<", "\\u003c")};const cache={};
const process={env:{NODE_ENV:'development'}};
function require(id){if(cache[id])return cache[id].exports;if(!factories[id])throw Error('Missing '+id);const module={exports:{}};cache[id]=module;new Function('module','exports','require','process',factories[id])(module,module.exports,require,process);return module.exports;}
const React=require('react');const root=require('react-dom/client').createRoot(document.getElementById('app'));
root.render(React.createElement('div',{className:'app-shell',style:{height:'100dvh',overflow:'hidden',transform:'translateZ(0)'}},React.createElement('header',{style:{display:'flex',justifyContent:'center',gap:8,height:76,backdropFilter:'blur(8px)',borderBottom:'1px solid #ddd'}},React.createElement('span',null,'Snacky OS'),React.createElement(require('@/components/NotificationCenter').NotificationCenter,{compact:true,routeAlerts:true,companyUpdates:true})),React.createElement('main',null,React.createElement('button',{id:'outside-control'},'Outside panel'))));
`;
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+styles+'\n'+panelCss+'\nbody{margin:0;font-family:Arial,sans-serif;}</style></head><body><div id="app"></div><script>'+boot.replaceAll('</script','<\\/script')+'</script></body></html>';
const output=path.join(root,'.qa/push-panel/index.html');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,html);console.log(output);
