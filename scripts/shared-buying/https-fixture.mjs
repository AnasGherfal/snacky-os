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
  const upstream=request({hostname:host,port:3000,path:incoming.url,method:incoming.method,headers:{...incoming.headers,host:`${host}:${port}`,'x-forwarded-host':`${host}:${port}`,'x-forwarded-proto':'https','x-forwarded-port':String(port)}},response=>{
   outgoing.writeHead(response.statusCode??502,response.headers);response.pipe(outgoing);
  });
  upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end('Isolated upstream unavailable');});
  incoming.on('aborted',()=>upstream.destroy());incoming.pipe(upstream);
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});}
 catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
 return {origin,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}};
}
