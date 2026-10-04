import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestDatabase} from './db-fixture.mjs';
import {inspectDatabaseSnapshot} from '../../scripts/production-check.mjs';

test('release database inspection accepts only genuine generated SSO identities among reserved accounts',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());const db=f.db;
 const env={DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex')};
 const inspect=()=>db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');return inspectDatabaseSnapshot(tx,'postgres',env);});
 await db.run("INSERT INTO users(id,email,name,password,role,created_at,password_login_enabled) VALUES('genuine','sso-genuine@identity.invalid','SSO player','disabled:random','player',1,0)");
 await db.run("INSERT INTO oidc_identities(issuer,subject,user_id,created_at) VALUES('https://idp.company.kz','verified-subject','genuine',1)");
 const clean=await inspect();
 assert.equal(clean.unicodeSearch,true,'release DB needs Cyrillic and Kazakh search folding');
 assert.equal(clean.exampleAccounts,0,'verified password-disabled synthetic identity is not a demo account');
 await db.run("INSERT INTO users(id,email,name,password,role,created_at,password_login_enabled) VALUES('orphan','sso-orphan@identity.invalid','Orphan','disabled:random','player',1,0),('password','sso-password@identity.invalid','Password enabled','hash','player',1,1),('wrong','wrong@identity.invalid','Wrong format','disabled:random','player',1,0),('sample','demo@example.com','Demo','disabled:random','player',1,0)");
 for(const id of ['password','wrong','sample'])await db.run('INSERT INTO oidc_identities(issuer,subject,user_id,created_at) VALUES($1,$2,$3,1)',['https://idp.company.kz',id,id]);
 const rejected=await inspect();
 assert.equal(rejected.exampleAccounts,4,'orphaned, password-enabled, wrongly formatted and other reserved accounts still fail');
 assert.ok(!JSON.stringify(rejected).includes('@identity.invalid'),'report does not expose account addresses');
 assert.equal((await db.get('SELECT COUNT(*) n FROM users')).n,5,'read-only checks preserve all rows');
});
