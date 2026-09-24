import test from 'node:test';
import {createEnterpriseApp} from '../../src/enterprise/server.mjs';
import {createTestDatabase} from './db-fixture.mjs';
import {checkHandlerDrain} from '../helpers/drain-suite.mjs';

test('PostgreSQL shutdown drains accepted work after the transport has closed',async t=>{
 const f=await createTestDatabase();
 try{await checkHandlerDrain(t,{create:passwordService=>createEnterpriseApp({db:f.db,passwordService,keys:{encryptionKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,73)},env:{NODE_ENV:'test'}}),read:async()=>Number((await f.db.get("SELECT count(*) n FROM users WHERE email='drain@example.test'")).n)});}
 finally{await f.close();}
});
