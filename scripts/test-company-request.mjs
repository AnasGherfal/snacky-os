import assert from 'node:assert/strict';
import test from 'node:test';
import {readCompanyBody,companyDownloadName} from '../src/lib/company-request.ts';
function streaming(parts,headers={}){return new Request('https://snacky.example',{method:'POST',headers,duplex:'half',body:new ReadableStream({start(controller){for(const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close();}})});}
test('bounded request accepts Unicode within byte limit without corrupting it',async()=>{const value='مرحبا بسناكي';assert.equal(new TextDecoder().decode(await readCompanyBody(streaming([value]),100)),value);});
test('chunked or dishonest content length cannot bypass upload/body limit',async()=>{for(const headers of [{},{'content-length':'1'},{'content-length':'10000'}]){await assert.rejects(()=>readCompanyBody(streaming(['12345','67890'],headers),8),e=>e.code==='request_too_large');}});
test('filename used in download header excludes controls and directory separators',()=>{assert.equal(companyDownloadName('folder/ملف\r\n.pdf'),'folder_ملف__.pdf');assert.equal(companyDownloadName('x'.repeat(400)).length,200);});
