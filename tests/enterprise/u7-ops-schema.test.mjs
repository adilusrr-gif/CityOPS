import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {postgresConnectionOptions} from '../../src/enterprise/db.mjs';

test('native fixture schema becomes a safe startup search path without permitting timeout overrides',()=>{
 const base={env:{PG_STATEMENT_TIMEOUT_MS:'1234',PG_LOCK_TIMEOUT_MS:'2345'},connectionString:'postgresql://test:password@localhost/test',schema:'cq_test_0123456789abcdef'};
 const client=new pg.Client(postgresConnectionOptions(base)),startup=client.getStartupConf();
 assert.equal(startup.options,'-c search_path=cq_test_0123456789abcdef');
 assert.equal(startup.statement_timeout,'1234');assert.equal(startup.lock_timeout,'2345');
 assert.equal(postgresConnectionOptions({...base,schema:undefined}).options,undefined);
 for(const schema of ['',null,7,'a'.repeat(64),'name,public','name -c statement_timeout=0','name;RESET ALL','"name"','Name','pg_temp\n-c lock_timeout=0'])assert.throws(()=>postgresConnectionOptions({...base,schema}),/schema/);
 assert.throws(()=>postgresConnectionOptions({...base,options:'-c statement_timeout=0'}),/startup options/);
 assert.throws(()=>postgresConnectionOptions({...base,env:{PGOPTIONS:'-c statement_timeout=0'}}),/PGOPTIONS/);
 assert.throws(()=>postgresConnectionOptions({...base,connectionString:base.connectionString+'?options=-c%20statement_timeout=0'}),/query parameters/);
});
