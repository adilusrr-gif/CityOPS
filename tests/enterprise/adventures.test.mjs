import {createTestDatabase} from './db-fixture.mjs';
import {adventureSuite} from '../helpers/adventure-suite.mjs';
adventureSuite('PostgreSQL adventures',async t=>{const fixture=await createTestDatabase();t.after(()=>fixture.close());t.diagnostic(`SQL engine: ${fixture.engine}`);return{db:fixture.db,dialect:'postgres'};});
