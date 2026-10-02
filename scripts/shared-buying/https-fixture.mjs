// Isolated browser-test transport only. Production cookie/security settings are unchanged.
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {request} from 'node:http';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function startBuyingTestTLS(){
 const host='127.0.0.1',port=3443,origin=`https://${host}:${port}`;
 const directory=mkdtempSync(join(tmpdir(),'snacky-buying-tls-'));
 const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
 const created=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{encoding:'utf8'});
 assert.equal(created.status,0,'Could not prepare the isolated TLS fixture');
 const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(incoming,outgoing)=>{
  // Fixed loopback upstream, never a destination taken from browser input.
  // Present one internally consistent HTTPS origin to Next so Server Actions,
  // CSRF checks and secure cookies behave like production while the browser
  // still connects only to the isolated loopback TLS endpoint.
  const upstreamOrigin='https://localhost:3000';
  const headers={...incoming.headers,host:'localhost:3000','x-forwarded-host':'localhost:3000','x-forwarded-proto':'https','x-forwarded-port':'3000'};
  if(headers.origin===origin)headers.origin=upstreamOrigin;
  if(typeof headers.referer==='string'&&headers.referer.startsWith(origin))headers.referer=upstreamOrigin+headers.referer.slice(origin.length);
  const upstream=request({hostname:host,port:3000,path:incoming.url,method:incoming.method,headers},response=>{
   const responseHeaders={...response.headers};
   for(const name of ['location','x-action-redirect']){
    const value=responseHeaders[name];
    if(typeof value==='string'&&value.startsWith(upstreamOrigin))responseHeaders[name]=origin+value.slice(upstreamOrigin.length);
   }
   outgoing.writeHead(response.statusCode??502,responseHeaders);response.pipe(outgoing);
  });
  upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end('Isolated upstream unavailable');});
  incoming.on('aborted',()=>upstream.destroy());incoming.pipe(upstream);
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});}
 catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
 return {origin,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}};
}
