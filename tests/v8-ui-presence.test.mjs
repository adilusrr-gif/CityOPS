import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTeamPresence} from '../public/team-presence.js';
function clock(){let time=1000,id=0,latest;const timers=new Map();const presence=createTeamPresence({now:()=>time,onChange:value=>latest=value,schedule:(fn,delay)=>{timers.set(++id,{fn,at:time+delay});return id;},cancel:key=>timers.delete(key)});return {presence,get latest(){return latest;},advance(ms){time+=ms;for(const [key,timer] of [...timers])if(timer.at<=time){timers.delete(key);timer.fn();}},get now(){return time;},get timers(){return timers.size;}};}
const response=ttl=>({team:{id:'team'},members:[{id:'member',online:true,location:{lng:76.9,lat:43.2,expiresInMs:ttl}}]});

test('team presence subtracts full request duration and expires without further polling',()=>{
 const c=clock(),started=c.now;c.advance(700);c.presence.update(response(1000),started);assert(c.latest.members[0].location);
 c.advance(299);assert(c.latest.members[0].location);c.advance(1);assert.equal(c.latest.members[0].location,null);
});
test('expired, missing and malformed location leases are never rendered',()=>{
 for(const ttl of [20,undefined,NaN,Infinity,-1,'60000']){const c=clock(),started=c.now;c.advance(100);c.presence.update(response(ttl),started);assert.equal(c.latest.members[0].location,null);}
});
test('background/offline clearing removes coordinates and GPS status immediately',()=>{
 const c=clock();c.presence.update(response(60000),c.now);assert(c.latest.members[0].location);c.presence.clear();assert.equal(c.latest.members[0].location,null);assert.equal(c.latest.members[0].online,false);assert.equal(c.timers,0);
});
test('new data replaces old expiry and account reset cancels scheduled publications',()=>{
 const c=clock();c.presence.update(response(100),c.now);c.advance(50);c.presence.update(response(1000),c.now);c.advance(50);assert(c.latest.members[0].location);
 c.presence.reset();assert.equal(c.timers,0);const old=c.latest;c.advance(70000);assert.equal(c.latest,old);
});
