import assert from 'node:assert/strict';
import {request} from 'node:http';
import {once} from 'node:events';
import {setImmediate as immediate} from 'node:timers/promises';
import {passwordHash} from '../../src/domain.mjs';

export async function checkHandlerDrain(t,{create,read}) {
 let entered,release;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const stored=passwordHash('Drain-test-password-2026');
 const app=await create({async hash(){entered();await gate;return stored;}});
 t.after(async()=>{release();app.server.closeAllConnections();await app.close();});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const req=request({host:'127.0.0.1',port:app.server.address().port,path:'/api/register',method:'POST',headers:{'content-type':'application/json'}});
 req.on('error',()=>{});
 req.end(JSON.stringify({name:'Проверка завершения',email:'drain@example.test',password:'Drain-test-password-2026'}));
 await started;
 const transportClosed=once(app.server,'close');
 let drained=false;
 const closing=app.close().then(()=>{drained=true;});
 req.destroy();app.server.closeAllConnections();
 await transportClosed;await immediate();
 assert.equal(drained,false,'closing the socket must not release the database while an accepted handler is awaiting its KDF');
 release();await closing;
 assert.equal(await read(),1,'accepted registration completes before database ownership is returned');
 await app.close();
}
