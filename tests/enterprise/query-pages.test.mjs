import test from 'node:test';
import {createTestDatabase} from './db-fixture.mjs';
import {queryPageScenarios} from '../helpers/query-pages.mjs';
test('PostgreSQL bounded read models preserve reachability and authorization',async t=>{const fixture=await createTestDatabase();t.after(()=>fixture.close());t.diagnostic(fixture.engine);await queryPageScenarios(t,{db:fixture.db,dialect:'postgres'});});
