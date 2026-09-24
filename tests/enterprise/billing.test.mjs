import {billingSuite} from '../helpers/billing-suite.mjs';
import {createTestDatabase} from './db-fixture.mjs';
import {appendAudit} from '../../src/enterprise/security-store.mjs';
billingSuite('PostgreSQL billing',async()=>{
 const fixture=await createTestDatabase();
 return {...fixture,audit:(tx,actor,action,target,metadata)=>appendAudit(tx,{actor,action,target,metadata,requestId:'billing-test'},Buffer.alloc(32,25))};
});
