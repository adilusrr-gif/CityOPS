import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {postgresConnectionOptions} from '../../src/enterprise/db.mjs';

const connectionString='postgres://cq:example-password@database.example.test/cityquest';
function effective(options){return new pg.Client(postgresConnectionOptions({connectionString,env:{},...options})).connectionParameters.ssl;}

test('effective pg TLS keeps CA and strict verification after actual driver URL parsing',t=>{
 const directory=mkdtempSync(join(tmpdir(),'cq-tls-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const ca=join(directory,'ca.pem');writeFileSync(ca,'test CA bytes');
 const actual=effective({env:{NODE_ENV:'production',PGSSLMODE:'verify-full',PGSSLROOTCERT:ca}});
 assert.equal(actual.rejectUnauthorized,true);
 assert.equal(actual.ca,'test CA bytes');
 assert.equal(actual.checkServerIdentity,undefined);
 assert.equal(actual.servername,undefined);
 assert.equal(effective({ssl:true}).rejectUnauthorized,true);
 assert.equal(effective({ssl:{ca:'explicit CA'}}).ca,'explicit CA');
 assert.equal(effective({env:{PGSSLMODE:'disable'}}),false);
});

test('known pg compatibility downgrade and all URL TLS overrides are blocked before parsing',()=>{
 // Control establishes the upstream behavior this guard must prevent.
 const vulnerable=new pg.Client({connectionString:`${connectionString}?uselibpqcompat=true&sslmode=require`,ssl:{rejectUnauthorized:true}}).connectionParameters.ssl;
 assert.equal(vulnerable.rejectUnauthorized,false);
 for(const parameters of [
  'uselibpqcompat=true&sslmode=require','sslmode=verify-ca','sslmode=no-verify',
  'sslmode=verify-full&sslmode=require','sslmode=disable&sslmode=verify-full',
  'sslmode=verify-full','sslrootcert=/tmp/ca','sslcert=/tmp/cert','sslkey=/tmp/key',
  'ssl=0','ssl=no-verify','sslnegotiation=direct','uselibpqcompat=true',
  '%73slmode=require','SSLMODE=require','useLibpqCompat=true',
 ])assert.throws(()=>postgresConnectionOptions({connectionString:`${connectionString}?${parameters}`,env:{NODE_ENV:'production'}}),/must not contain TLS/);
});

test('TLS config rejects weak environment modes, custom identity callbacks and string bypasses',()=>{
 for(const mode of ['require','prefer','verify-ca','no-verify'])assert.throws(()=>effective({env:{PGSSLMODE:mode}}),/PGSSLMODE/);
 assert.throws(()=>effective({env:{NODE_ENV:'production'},ssl:false}),/verified TLS/);
 assert.throws(()=>effective({ssl:{rejectUnauthorized:false}}),/verification/);
 assert.throws(()=>effective({ssl:{checkServerIdentity:()=>undefined}}),/identity overrides/);
 assert.throws(()=>effective({ssl:{servername:'attacker.example'}}),/identity overrides/);
 assert.throws(()=>effective({ssl:'no-verify'}),/boolean or TLS object/);
 assert.throws(()=>effective({sslmode:'require'}),/TLS configuration/);
 assert.throws(()=>effective({useLibpqCompat:true}),/TLS configuration/);
});
