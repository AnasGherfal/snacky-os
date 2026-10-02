// Native regression assertions use English text. Pin only that locale; do not mock responses.
const original=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.hostname==='localhost'&&url.port==='3001'){
  const headers=new Headers(options.headers??(input instanceof Request?input.headers:undefined));
  const cookie=headers.get('cookie')??'';
  if(!cookie.includes('snacky_os_language='))headers.set('cookie',cookie+(cookie?'; ':'')+'snacky_os_language=en');
  options={...options,headers};
 }
 return original(input,options);
};
