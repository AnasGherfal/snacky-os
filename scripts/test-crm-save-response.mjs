import assert from 'node:assert/strict';
import test from 'node:test';
import {saveTaskThroughUi} from './crm-recurring/save-response.mjs';

function response({path='/api/crm/command',method='POST',action='task.save',recordId='task-1',status=200,result={}}={}) {
  return { url:()=>`http://localhost:3000${path}`, ok:()=>status>=200&&status<300, status:()=>status,
    request:()=>({method:()=>method,postDataJSON:()=>({id:'command-1',action,recordId})}),
    json:async()=>({ok:true,id:'task-1',kind:'task',commandId:'command-1',...result}) };
}
function page(reply) {
  const events=[];let predicate,finish;
  return {events,matched:r=>predicate(r),
    waitForResponse(fn,options){predicate=fn;events.push('listen');assert.equal(options.timeout,30000);return new Promise(resolve=>{finish=resolve;});},
    getByRole(role,options){assert.equal(role,'button');assert.deepEqual(options,{name:'Save changes',exact:true});return {async click(){events.push('click');assert.ok(finish,'Listener must be installed before clicking');await new Promise(resolve=>setImmediate(resolve));events.push('response');finish(reply);}};},
  };
}
test('waits for the actual task save after clicking, not result text in the textarea',async()=>{
  const p=page(response());await saveTaskThroughUi(p,'task-1');
  assert.deepEqual(p.events,['listen','click','response']);
  assert.equal(p.matched(response()),true);
  for(const other of [{recordId:'other'},{action:'note.add'},{method:'GET'},{path:'/api/company/command'}])assert.equal(p.matched(response(other)),false);
});
test('failed or unrelated receipts cannot pass task-completion acceptance',async()=>{
  for(const variant of [{status:500},{result:{ok:false,message:'Save failed'}},{result:{id:'other'}},{result:{kind:'issue'}},{result:{commandId:'other'}}]) {
    await assert.rejects(saveTaskThroughUi(page(response(variant)),'task-1'));
  }
});
