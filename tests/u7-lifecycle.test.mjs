import test from 'node:test';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {checkHandlerDrain} from './helpers/drain-suite.mjs';

test('SQLite shutdown drains accepted work even after forced socket closure',async t=>{
 const db=openDb(':memory:',{withSnapshot:false});
 try{await checkHandlerDrain(t,{create:passwordService=>createApp({db,passwordService,env:{NODE_ENV:'test'}}),read:()=>db.prepare("SELECT count(*) n FROM users WHERE email='drain@example.test'").get().n});}
 finally{db.close();}
});
