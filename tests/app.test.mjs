import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {hash,distance} from '../src/domain.mjs';
import {importOsm} from '../src/osm.mjs';
let db,server,base;
async function request(path,{cookie,method='GET',body,origin}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(origin?{origin}:{})},body:body!==undefined?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
const register=async(name,role='player')=>{const r=await request('/register',{method:'POST',body:{name,email:name.toLowerCase()+'@example.test',password:'A-long-test-password-42',role}});assert.equal(r.status,200,JSON.stringify(r.body));return {cookie:r.cookie,user:r.body.user};};
before(async()=>{db=openDb(':memory:',{withSnapshot:false});({server}=createApp({db,env:{NODE_ENV:'test'}}));server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;});
after(async()=>{await new Promise(r=>server.close(r));db.close();});
test('catalog seeded, password/session protected, admin registration rejected',async()=>{
 const q=await request('/quests');assert.equal(q.body.items.length,12);assert.equal(q.body.items.some(q=>'code_hash'in q),false);
 const bad=await request('/register',{method:'POST',body:{name:'Evil',email:'evil@example.test',password:'very-long-password',role:'admin'}});assert.equal(bad.status,400);
 const p=await register('Alice');assert.equal(p.user.role,'player');assert.equal('password'in p.user,false);assert.equal((await request('/manage',{cookie:p.cookie})).status,403);
 const stored=db.prepare('SELECT password FROM users WHERE id=?').get(p.user.id).password;assert.notEqual(stored,'A-long-test-password-42');
 assert.equal((await request('/login',{method:'POST',body:{email:p.user.email,password:'Wrong-password'}})).status,401);
 assert.equal((await request('/logout',{method:'POST',body:{},cookie:p.cookie,origin:'https://evil.example'})).status,403);
 assert.equal((await request('/logout',{method:'POST',body:{},cookie:p.cookie})).status,200);assert.equal((await request('/me',{cookie:p.cookie})).body.user,null);
});
test('moderation, ownership, completion idempotency and personal assignments',async()=>{
 const admin=await register('Admin'),biz=await register('Business','business'),other=await register('Otherbusiness','business'),p=await register('Player');db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.user.id);
 const org=(await request('/manage/organizations',{cookie:biz.cookie,method:'POST',body:{name:'Тестовая кофейня',category:'cafe',lng:76.945,lat:43.25,address:'Тестовый адрес',description:'test',status:'approved'}})).body.item;assert.equal(org.status,'pending');
 assert.equal((await request('/manage/organizations/'+org.id,{cookie:other.cookie,method:'PATCH',body:{name:'Hijacked'}})).status,403);
 await request('/manage/organizations/'+org.id,{cookie:admin.cookie,method:'PATCH',body:{status:'approved',version:org.version}});
 const payload={title:'Проверка квеста',description:'Тестовый квест для проверки API',organization_id:org.id,lng:76.945,lat:43.25,radius:100,xp:130,scope:'public',verification:'code',code:'HELLO-42',status:'pending'};
 const q=(await request('/manage/quests',{cookie:biz.cookie,method:'POST',body:payload})).body.item;assert.equal(q.status,'pending');assert.equal('code_hash'in q,false);
 assert.equal((await request('/manage/quests/'+q.id,{cookie:biz.cookie,method:'PATCH',body:{status:'published',version:q.version}})).status,400);
 assert.equal((await request('/manage/quests/'+q.id,{cookie:admin.cookie,method:'PATCH',body:{status:'published',version:q.version}})).status,200);
 assert.equal((await request(`/quests/${q.id}/complete`,{cookie:p.cookie,method:'POST',body:{code:'HELLO-42'}})).status,400);
 assert.equal((await request('/location',{cookie:p.cookie,method:'POST',body:{lng:76.945,lat:43.25,accuracy:800,timestamp:Date.now()}})).status,400);
 assert.equal((await request('/location',{cookie:p.cookie,method:'POST',body:{lng:76.945,lat:43.25,accuracy:10,timestamp:Date.now()}})).status,200);
 assert.equal((await request(`/quests/${q.id}/complete`,{cookie:p.cookie,method:'POST',body:{code:'wrong'}})).status,400);
 const completed=await Promise.all(Array.from({length:4},()=>request(`/quests/${q.id}/complete`,{cookie:p.cookie,method:'POST',body:{code:'HELLO-42'}})));assert.equal(completed.filter(r=>r.body.xp===130).length,1);assert.equal(db.prepare('SELECT xp FROM users WHERE id=?').get(p.user.id).xp,130);
 const privateQ=await request('/manage/quests',{cookie:admin.cookie,method:'POST',body:{...payload,scope:'personal',assigned_to:p.user.id,status:'published'}});assert.equal(privateQ.status,200);
 assert.equal((await request('/quests')).body.items.some(x=>x.id===privateQ.body.item.id),false);
 assert.equal((await request('/quests',{cookie:p.cookie})).body.items.some(x=>x.id===privateQ.body.item.id),true);
 assert.equal((await request(`/quests/${privateQ.body.item.id}/complete`,{cookie:other.cookie,method:'POST',body:{code:'HELLO-42'}})).status,404);
 // A business edit requires moderation again and unpublishes associated quests.
 await request('/manage/organizations/'+org.id,{cookie:biz.cookie,method:'PATCH',body:{name:'Новое название',version:db.prepare('SELECT version FROM organizations WHERE id=?').get(org.id).version}});
 assert.equal(db.prepare('SELECT status FROM quests WHERE id=?').get(q.id).status,'pending');
});
test('team membership and precise location require explicit sharing',async()=>{
 const a=await register('Teamowner'),b=await register('Teammate');const created=await request('/team',{cookie:a.cookie,method:'POST',body:{name:'Команда исследователей'}});assert.equal(created.status,200);
 assert.equal((await request('/team/join',{cookie:b.cookie,method:'POST',body:{code:created.body.team.invite}})).status,200);
 await request('/location',{cookie:a.cookie,method:'POST',body:{lng:76.95,lat:43.25,accuracy:10,timestamp:Date.now()}});
 let team=(await request('/team',{cookie:b.cookie})).body;assert.equal(team.members.length,2);assert.equal(team.members.find(m=>m.id===a.user.id).location,null);assert.equal(team.team.invite,undefined);
 await request('/team/sharing',{cookie:a.cookie,method:'PATCH',body:{enabled:true}});team=(await request('/team',{cookie:b.cookie})).body;assert.equal(team.members.find(m=>m.id===a.user.id).location.lng,76.95);
 await request('/location',{cookie:a.cookie,method:'DELETE'});assert.equal((await request('/team',{cookie:b.cookie})).body.members.find(m=>m.id===a.user.id).location,null);
 await request('/team',{cookie:a.cookie,method:'DELETE'});const transferred=(await request('/team',{cookie:b.cookie})).body.team;assert.equal(transferred.owner_id,b.user.id);assert.notEqual(transferred.invite,created.body.team.invite);
});
test('OSM deduplicates and protects claimed cards; numeric geography rejects invalid data',()=>{
 const data={elements:[{type:'node',id:90001,lat:43.25,lon:76.95,tags:{name:'OSM тест',amenity:'cafe'}},{type:'node',id:90002,lat:60,lon:20,tags:{name:'Outside'}}]};
 assert.deepEqual(importOsm(db,data),{inserted:1,updated:0,skipped:1});assert.deepEqual(importOsm(db,data),{inserted:0,updated:1,skipped:1});
 const owner=db.prepare("SELECT id FROM users WHERE email='business@example.test'").get();db.prepare('UPDATE organizations SET owner_id=? WHERE osm_id=?').run(owner.id,'node/90001');assert.equal(importOsm(db,data).skipped,2);
 assert.ok(distance({lng:76.95,lat:43.25},{lng:76.95,lat:43.251})>110);assert.equal(hash('hello'),hash('hello'));
});
test('data persists across database restart',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const folder=await mkdtemp(join(tmpdir(),'aq-test-'));const file=join(folder,'db.sqlite');
 try{let saved=openDb(file);saved.prepare("INSERT INTO meta(key,value) VALUES('persistence','works')").run();saved.close();saved=openDb(file);assert.equal(saved.prepare("SELECT value FROM meta WHERE key='persistence'").get().value,'works');assert.equal(saved.prepare('SELECT count(*) n FROM quests').get().n,24);saved.close();}finally{await rm(folder,{recursive:true,force:true});}
});
