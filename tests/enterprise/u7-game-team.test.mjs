import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './db-fixture.mjs';
import {createGameRoutes} from '../../src/enterprise/game-routes.mjs';
import {createEnterpriseAuth} from '../../src/enterprise/auth.mjs';
import {hash} from '../../src/domain.mjs';

test('u7: a queued team creation cannot claim quest completions committed before membership',async t=>{
 const fixture=await createTestDatabase(),{db}=fixture;t.after(()=>fixture.close());
 const start=Date.now(),cfg={idleMs:1800000,requireAdminMfa:false},userId='u7-team-owner',sessionId='u7-team-session';
 await db.run('INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',[userId,userId+'@example.test','Team owner','unused','player',start]);
 await db.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$3,$4,$5,$5,0)',[hash(sessionId),sessionId,userId,start+300000,start]);
 for(const qid of ['u7-before-team','u7-after-team'])await db.run("INSERT INTO quests(id,title,description,lng,lat,radius,xp,scope,verification,status,goal,created_at,city_id) VALUES($1,$1,'Team timing test',76.95,43.25,100,100,'public','checkin','published',20,$2,'almaty')",[qid,start]);
 const audit=async()=>{},auth=createEnterpriseAuth({db,cfg,audit,throttle:async()=>{},env:{}}),user={...await db.get('SELECT * FROM users WHERE id=$1',[userId]),session_id:sessionId,session_mfa_verified:0},route=createGameRoutes();
 let queued,release;const entered=new Promise(resolve=>{queued=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const delayedDb={...db,transaction:async callback=>{queued();await gate;return db.transaction(callback);}};
 const call=(database,method,body={})=>route({db:database,cfg,path:'/api/team',url:new URL('http://localhost/api/team?city=almaty'),method,cityId:'almaty',user,required:auth.required,auth,readBody:async()=>body,audit,throttle:async()=>{}});
 t.mock.timers.enable({apis:['Date'],now:start});
 const creating=call(delayedDb,'POST',{name:'Delayed team',city_id:'almaty'});
 await entered;
 // The request is waiting for a transaction slot. Another committed request
 // completes a quest before this team/membership exists.
 t.mock.timers.setTime(start+1000);
 await db.run('INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES($1,$2,100,$3)',[userId,'u7-before-team',Date.now()]);
 t.mock.timers.setTime(start+2000);release();
 const {team}=await creating;
 assert.equal(team.created_at,start+2000);
 assert.equal((await db.get('SELECT joined_at FROM members WHERE user_id=$1',[userId])).joined_at,start+2000);
 assert.deepEqual((await call(db,'GET')).progress,[]);
 t.mock.timers.setTime(start+3000);
 await db.run('INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES($1,$2,100,$3)',[userId,'u7-after-team',Date.now()]);
 const progress=(await call(db,'GET')).progress;
 assert.equal(progress.length,1);assert.equal(progress[0].id,'u7-after-team');assert.equal(progress[0].completions,1);
 t.diagnostic(`Database: ${fixture.engine}. The barrier exercises the request/transaction queue boundary; it does not simulate cluster failover.`);
});
