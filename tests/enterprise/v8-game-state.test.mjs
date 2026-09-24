import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createGameRoutes} from '../../src/enterprise/game-routes.mjs';
import {createEnterpriseAuth} from '../../src/enterprise/auth.mjs';
import {appendAudit,verifyAudit} from '../../src/enterprise/security-store.mjs';
import {hash} from '../../src/domain.mjs';
import {createTestDatabase} from './db-fixture.mjs';

const locations={almaty:{lng:76.947,lat:43.249},astana:{lng:71.4304,lat:51.1282}};
const keys={encryptionKey:Buffer.alloc(32,27),auditKey:Buffer.alloc(32,31)};
let sequence=0;

async function harness(t){
  const fixture=await createTestDatabase();
  t.after(()=>fixture.close());
  const db=fixture.db,db2=fixture.db2||db;
  t.diagnostic(`Database engine: ${fixture.engine||'PostgreSQL'}; database handles: ${db2!==db?2:1}. PGlite serializes transactions; native PG_TEST_URL exercises concurrent connections.`);
  const audit=(tx,actor,action,target,metadata={})=>appendAudit(tx,{actor,action,target,metadata,requestId:'game-test'},keys.auditKey);
  const cfg={keys,idleMs:1800000,requireAdminMfa:false,secure:false,origin:'http://localhost',nativeOrigins:[]};
  const auth=[db,db2].map(database=>createEnterpriseAuth({db:database,cfg,audit,throttle:async()=>{},env:{}}));
  const route=createGameRoutes();
  async function player(role='player'){
    const suffix=++sequence,uid=`game-user-${suffix}`,now=Date.now(),sessionId=`game-session-${suffix}`;
    await db.run('INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',[uid,`${uid}@example.test`,`Игрок ${suffix}`,'test-no-password-login',role,now]);
    await db.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$3,$4,$5,$5,0)',[hash(sessionId),sessionId,uid,now+3600000,now]);
    return db.get('SELECT u.*,s.id AS session_id,s.expires,s.last_seen,s.mfa_verified AS session_mfa_verified FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1',[uid]);
  }
  async function call(path,user,{method='GET',body={},city='almaty',replica=0,auditOverride}={}){
    const url=new URL(path,'http://localhost');url.searchParams.set('city',city);
    return route({db:replica?db2:db,cfg,url,path:url.pathname,method,cityId:city,user,required:auth[replica].required,auth:auth[replica],readBody:async()=>body,audit:auditOverride||audit,throttle:async()=>{}});
  }
  async function quest(options={}){
    const selected=options.city_id||'almaty',q={id:`game-quest-${++sequence}`,city_id:selected,title:'Проверяемый квест',description:'Описание игрового маршрута',...locations[selected],radius:150,xp:100,scope:'public',assigned_to:null,verification:'checkin',code_hash:null,status:'published',goal:20,created_at:Date.now(),starts_at:null,ends_at:null,max_completions:null,...options};
    const columns=Object.keys(q);
    await db.run(`INSERT INTO quests(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,columns.map(column=>q[column]));
    return q;
  }
  async function locate(user,selected='almaty'){
    return call('/api/location',user,{method:'POST',body:{...locations[selected],city_id:selected,accuracy:5,timestamp:Date.now()}});
  }
  async function token(quest,issuer,code=randomBytes(12).toString('hex').toUpperCase(),expires=Date.now()+600000){
    const tid=`game-token-${++sequence}`;
    await db.run('INSERT INTO reward_tokens(id,quest_id,issuer_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[tid,quest.id,issuer.id,hash(code),Date.now(),expires]);
    return {id:tid,code};
  }
  return {db,db2,call,player,quest,locate,token};
}

test('v8 PostgreSQL: epoch-zero end is unavailable and cannot earn a quest reward',async t=>{
 const h=await harness(t),user=await h.player(),quest=await h.quest({ends_at:0});await h.locate(user);
 const listed=await h.call('/api/quests',user);
 assert.equal(listed.items.find(row=>row.id===quest.id).available,false);
 await assert.rejects(h.call(`/api/quests/${quest.id}/complete`,user,{method:'POST'}),{status:409});
 assert.equal(Number((await h.db.get('SELECT count(*) n FROM completions WHERE quest_id=$1',[quest.id])).n),0);
});

test('v8 PostgreSQL: team coordinates carry a remaining lifetime only while consent and freshness hold',async t=>{
 const h=await harness(t),owner=await h.player(),member=await h.player(),time=Date.now();
 t.mock.timers.enable({apis:['Date'],now:time});
 const {team}=await h.call('/api/team',owner,{method:'POST',body:{name:'Ограниченное время координат'}});
 await h.call('/api/team/join',member,{method:'POST',body:{code:team.invite}});
 await h.locate(member);
 const view=async()=>(await h.call('/api/team',owner)).members.find(row=>row.id===member.id);
 assert.equal((await view()).location,null);
 await h.call('/api/team/sharing',member,{method:'PATCH',body:{enabled:true}});
 t.mock.timers.setTime(time+5000);
 assert.deepEqual((await view()).location,{...locations.almaty,expiresInMs:55000});
 t.mock.timers.setTime(time+60000);assert.equal((await view()).location,null);
 await h.locate(member);
 await h.call('/api/team/sharing',member,{method:'PATCH',body:{enabled:false}});
 assert.equal((await view()).location,null);
});
