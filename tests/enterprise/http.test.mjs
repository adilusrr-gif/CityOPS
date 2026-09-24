import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnterpriseApp} from '../../src/enterprise/server.mjs';
import {verifyAudit} from '../../src/enterprise/security-store.mjs';
import {createTestDatabase} from './db-fixture.mjs';

const keys={encryptionKey:Buffer.alloc(32,41),auditKey:Buffer.alloc(32,43)};
const credentials={email:'http-player@example.test',password:'Http-test-password-2026',name:'HTTP игрок'};

async function pair(t,{seed=false}={}){
  const fixture=await createTestDatabase({seed}),apps=[];
  t.after(async()=>{for(const app of apps)await app.close();await fixture.close();});
  for(const [index,db] of [fixture.db,fixture.db2].entries()){
    const app=await createEnterpriseApp({db,keys,env:{NODE_ENV:'test',INSTANCE_ID:`test-${index}`}});
    apps.push(app);
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
    app.base=`http://127.0.0.1:${app.server.address().port}`;
  }
  t.diagnostic(`Two HTTP server instances, shared ${fixture.engine}. Stopping one HTTP instance is not PostgreSQL cluster failover; PGlite serializes database transactions.`);
  const request=async(index,path,{method='GET',body,cookie,headers={}}={})=>{
    const app=apps[index],finalHeaders={...headers};
    if(cookie)finalHeaders.Cookie=cookie;
    if(body!==undefined)finalHeaders['Content-Type']='application/json';
    const response=await fetch(app.base+path,{method,headers:finalHeaders,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
    const text=await response.text();
    return {status:response.status,headers:response.headers,body:text?JSON.parse(text):null};
  };
  return {...fixture,apps,request};
}

test('http: shared sessions, rewards and teams survive stopping one application instance',async t=>{
  const h=await pair(t,{seed:true});
  for(const index of [0,1]){
    const ready=await h.request(index,'/api/ready');
    assert.equal(ready.status,200);assert.equal(ready.body.schema,6);
  }
  const registered=await h.request(0,'/api/register',{method:'POST',body:credentials,headers:{Origin:h.apps[0].base}});
  assert.equal(registered.status,200);assert.equal(Object.hasOwn(registered.body,'accessToken'),false);
  assert.match(registered.headers.get('set-cookie'),/HttpOnly/);
  const initialCookie=registered.headers.get('set-cookie').split(';')[0];
  const onSecond=await h.request(1,'/api/me',{cookie:initialCookie});
  assert.equal(onSecond.body.user.id,registered.body.user.id);
  const logged=await h.request(0,'/api/login',{method:'POST',body:{email:credentials.email,password:credentials.password},headers:{Origin:h.apps[0].base}});
  assert.equal(logged.status,200);assert.equal(Object.hasOwn(logged.body,'accessToken'),false);
  const cookie=logged.headers.get('set-cookie').split(';')[0];
  const quest=await h.db.get("SELECT * FROM quests WHERE city_id='almaty' AND status='published' AND verification='checkin' AND assigned_to IS NULL ORDER BY id LIMIT 1");
  assert.ok(quest);
  const position=await h.request(0,'/api/location',{method:'POST',cookie,body:{lng:quest.lng,lat:quest.lat,accuracy:5,timestamp:Date.now(),city_id:'almaty'}});
  assert.equal(position.status,200);
  const completed=await h.request(1,`/api/quests/${quest.id}/complete`,{method:'POST',cookie,body:{}});
  assert.equal(completed.status,200);assert.equal(completed.body.alreadyCompleted,false);assert.equal(completed.body.xp,quest.xp);
  const repeated=await Promise.all([0,1].map(index=>h.request(index,`/api/quests/${quest.id}/complete`,{method:'POST',cookie,body:{}})));
  assert.ok(repeated.every(result=>result.status===200&&result.body.alreadyCompleted&&result.body.xp===0));
  assert.equal(Number((await h.db.get('SELECT count(*) AS n FROM completions WHERE user_id=$1',[registered.body.user.id])).n),1);
  const created=await h.request(0,'/api/team',{method:'POST',cookie,body:{name:'Команда двух реплик',city_id:'almaty'}});
  assert.equal(created.status,200);
  const shared=await h.request(1,'/api/team',{cookie});
  assert.equal(shared.status,200);assert.equal(shared.body.team.id,created.body.team.id);assert.equal(shared.body.team.invite,created.body.team.invite);
  assert.match(shared.headers.get('x-request-id'),/^[a-f0-9]{24}$/);
  assert.equal(shared.headers.get('cache-control'),'no-store');

  h.apps[0].beginDrain();
  assert.equal((await h.request(0,'/api/ready')).status,503);
  assert.equal((await h.request(0,'/api/health')).status,200);
  assert.equal((await h.request(0,'/api/progress',{cookie})).status,200);
  assert.equal((await h.request(0,'/api/location',{method:'POST',cookie,body:{lng:quest.lng,lat:quest.lat,accuracy:5,timestamp:Date.now(),city_id:'almaty'}})).status,503);
  await h.apps[0].close();
  assert.equal(h.apps[0].server.listening,false);
  const progress=await h.request(1,'/api/progress',{cookie});
  assert.equal(progress.status,200);assert.equal(progress.body.user.xp,quest.xp);
  assert.equal(progress.body.completed[0].quest_id,quest.id);assert.equal(progress.body.cells.length,1);
  assert.equal((await h.request(1,'/api/team',{cookie})).body.team.id,created.body.team.id);
  assert.equal((await h.request(1,'/api/ready')).status,200);
  assert.equal((await verifyAudit(h.db2,keys.auditKey)).ok,true);
});

test('http: native CORS and bearer login are explicit while browser sessions remain cookies',async t=>{
  const h=await pair(t),nativeHeaders={Origin:'capacitor://localhost','X-CityQuest-Client':'native'};
  const preflight=await h.request(0,'/api/login',{method:'OPTIONS',headers:{Origin:nativeHeaders.Origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type,Authorization,X-CityQuest-Client'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),nativeHeaders.Origin);
  assert.match(preflight.headers.get('access-control-allow-headers'),/Authorization/);
  assert.equal(preflight.headers.get('access-control-allow-credentials'),null);
  const native=await h.request(0,'/api/register',{method:'POST',headers:nativeHeaders,body:credentials});
  assert.equal(native.status,200);assert.match(native.body.accessToken,/^[a-f0-9]{64}$/);
  assert.equal(native.headers.get('set-cookie'),null);
  assert.equal(native.headers.get('access-control-allow-origin'),nativeHeaders.Origin);
  const bearer={...nativeHeaders,Authorization:`Bearer ${native.body.accessToken}`};
  const otherInstance=await h.request(1,'/api/progress',{headers:bearer});
  assert.equal(otherInstance.status,200);assert.equal(otherInstance.body.user.id,native.body.user.id);
  const web=await h.request(1,'/api/login',{method:'POST',headers:{Origin:h.apps[1].base},body:{email:credentials.email,password:credentials.password}});
  assert.equal(web.status,200);assert.equal(Object.hasOwn(web.body,'accessToken'),false);
  assert.ok(web.headers.get('set-cookie'));assert.equal(web.headers.get('access-control-allow-origin'),null);
  const android=await h.request(1,'/api/login',{method:'POST',headers:{Origin:'https://localhost','X-CityQuest-Client':'native'},body:{email:credentials.email,password:credentials.password}});
  assert.equal(android.status,200);assert.match(android.body.accessToken,/^[a-f0-9]{64}$/);assert.equal(android.headers.get('set-cookie'),null);

  const rejectedOrigin=await h.request(0,'/api/login',{method:'POST',headers:{Origin:'https://attacker.invalid','X-CityQuest-Client':'native'},body:{email:credentials.email,password:credentials.password}});
  assert.equal(rejectedOrigin.status,403);assert.equal(rejectedOrigin.headers.get('access-control-allow-origin'),null);
  assert.equal(Object.hasOwn(rejectedOrigin.body,'accessToken'),false);
  assert.equal((await h.request(0,'/api/login',{method:'OPTIONS',headers:{Origin:'https://attacker.invalid','Access-Control-Request-Method':'POST'}})).status,403);
  assert.equal((await h.request(0,'/api/login',{method:'POST',headers:{Origin:'capacitor://localhost'},body:{email:credentials.email,password:credentials.password}})).status,403);
  assert.equal((await h.request(0,'/api/login',{method:'POST',headers:{Origin:h.apps[0].base,'Sec-Fetch-Site':'cross-site'},body:{email:credentials.email,password:credentials.password}})).status,403);
  assert.equal((await h.request(0,'/api/progress',{headers:{...nativeHeaders,Authorization:`Bearer ${'0'.repeat(64)}`}})).status,401);
  assert.equal((await h.request(0,'/api/logout',{method:'POST',headers:bearer,body:{}})).status,200);
  assert.equal((await h.request(1,'/api/progress',{headers:bearer})).status,401);
  const webCookie=web.headers.get('set-cookie').split(';')[0];
  assert.equal((await h.request(1,'/api/progress',{cookie:webCookie})).status,200);
});
