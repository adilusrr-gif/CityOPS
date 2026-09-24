import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionExpired} from '../src/security.mjs';

test('session clock tolerance is bounded and does not extend absolute or idle expiry',()=>{
 const now=100000,valid={expires:200000,last_seen:now+250};
 assert.equal(sessionExpired(valid,{now,idleMs:1000}),false);
 assert.equal(sessionExpired({...valid,last_seen:now+5000},{now,idleMs:1000}),false);
 assert.equal(sessionExpired({...valid,last_seen:now+5001},{now,idleMs:1000}),true);
 assert.equal(sessionExpired(valid,{now,idleMs:1000,clockSkewMs:0}),true);
 assert.equal(sessionExpired({...valid,expires:now},{now,idleMs:1000}),true);
 assert.equal(sessionExpired({...valid,last_seen:now-1000},{now,idleMs:1000}),true);
 for(const clockSkewMs of [-1,0.5,30001,NaN,'5000'])assert.throws(()=>sessionExpired(valid,{now,idleMs:1000,clockSkewMs}),TypeError);
});
