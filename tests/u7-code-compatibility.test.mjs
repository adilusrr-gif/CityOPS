import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCode,text,hash} from '../src/domain.mjs';

test('issued Unicode quest codes accept their expanded uppercase representation',()=>{
 const issued=normalizeCode(text('ﬃ'.repeat(64),'Код',64,4));
 assert.equal(issued.length,192);
 assert.equal(hash(normalizeCode(issued)),hash(issued));
 assert.equal(normalizeCode('  abc123  '),'ABC123');
 for(const value of [{toString:null},['ABC'],123])assert.throws(()=>normalizeCode(value),error=>error.status===400);
});
