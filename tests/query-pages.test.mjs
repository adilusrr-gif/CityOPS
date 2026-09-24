import test from 'node:test';
import {openDb} from '../src/db.mjs';
import {queryPageScenarios} from './helpers/query-pages.mjs';
test('SQLite bounded read models preserve reachability and authorization',async t=>{const db=openDb(':memory:',{withSnapshot:false});t.after(()=>db.close());await queryPageScenarios(t,{db,dialect:'sqlite'});});
