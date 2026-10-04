import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {parseQuestMetadata,publicQuest} from '../src/quest-metadata.mjs';
import {questMetadataSuite,METADATA} from './helpers/quest-metadata-suite.mjs';

test('quest metadata normalizes write/read values without inventing legacy facts',()=>{
 const row=parseQuestMetadata({...METADATA,hint:'  Подсказка  '});assert.equal(row.hint,'Подсказка');assert.deepEqual(publicQuest(row).objective_steps,METADATA.objective_steps);assert.equal(publicQuest({}).difficulty,null);assert.equal(publicQuest({}).estimated_minutes,null);assert.deepEqual(publicQuest({}).objective_steps,[]);
});
test('SQLite quest metadata HTTP contract and game invariants',async t=>{
 const db=openDb(':memory:',{withSnapshot:false}),app=createApp({db,env:{NODE_ENV:'test',REQUIRE_ADMIN_MFA:'false'}});
 t.after(async()=>{await app.close();db.close();});
 await questMetadataSuite(t,{db,dialect:'sqlite',server:app.server});
});
