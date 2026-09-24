import test from 'node:test';
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {createPasswordService,passwordText} from '../src/passwords.mjs';
import {passwordHash,passwordOK} from '../src/domain.mjs';

test('async password KDF preserves legacy hashes and Unicode passwords without blocking the event loop',async()=>{
 const service=createPasswordService({concurrency:2}),password='界'.repeat(128),legacy=passwordHash(password);
 assert.equal(passwordText(` ${password} `),password);
 // A busy scheduler may deliver the libuv completion before setImmediate.
 // Observe the actual asynchronous crypto callback instead of racing durations:
 // JS must regain control and cross a microtask barrier before it runs.
 const requests=new Set(),callbacks=[];let returned=false,microtaskRan=false;
 const hook=createHook({
  init(asyncId,type){if(type==='SCRYPTREQUEST')requests.add(asyncId);},
  before(asyncId){if(requests.has(asyncId))callbacks.push({returned,microtaskRan});},
 }).enable();
 let verified;
 try{
  queueMicrotask(()=>{microtaskRan=true;});
  const checking=service.verify(password,legacy);returned=true;
  verified=await checking;
 }finally{hook.disable();}
 assert.equal(verified,true);
 // scryptSync also initializes a crypto resource, but has no asynchronous
 // callback. A synchronous replacement therefore cannot satisfy this proof.
 assert.deepEqual(callbacks,[{returned:true,microtaskRan:true}]);
 const record=await service.hash('compatible-long-password');assert.equal(passwordOK('compatible-long-password',record),true);
 assert.equal(await service.verify('wrong-password',record),false);
 for(const stored of [undefined,'broken','disabled:random',`${'a'.repeat(32)}:bad`])assert.equal(await service.verify('compatible-long-password',stored),false);
});

test('KDF admission has no unbounded queue and releases capacity after completion',async()=>{
 const service=createPasswordService({concurrency:2});
 const first=service.hash('first-long-password'),second=service.hash('second-long-password');
 await assert.rejects(service.verify('third-long-password',undefined),e=>e.status===503&&e.retryAfter===1);
 await Promise.all([first,second]);
 assert.match(await service.hash('capacity-is-available'),/^[a-f0-9]{32}:[a-f0-9]{128}$/);
 await assert.rejects(service.hash('界'.repeat(171)),e=>e.status===400);
 assert.throws(()=>passwordText('x'.repeat(129)),e=>e.status===400);
 for(const concurrency of [0,9,1.5,NaN])assert.throws(()=>createPasswordService({concurrency}),/concurrency/);
});
