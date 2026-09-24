// Shared coordinates are a short lease, not durable map state. Monotonic time
// also covers responses delayed in transit; an offline/suspended view fails closed.
export function createTeamPresence({onChange,now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout}){
 let result=null,timer;
 function stop(){if(timer!==undefined)cancel(timer);timer=undefined;}
 function publish(){
  stop();if(!result)return;const time=now();let next=Infinity;
  result={...result,members:(result.members||[]).map(member=>{
   const {locationUntil,onlineUntil,...rest}=member;
   const location=locationUntil>time?member.location:null,online=onlineUntil>time&&member.online;
   if(location)next=Math.min(next,locationUntil);if(online)next=Math.min(next,onlineUntil);
   return {...rest,location,online,locationUntil,onlineUntil};
  })};
  onChange(result);if(Number.isFinite(next))timer=schedule(publish,Math.max(1,next-time));
 }
 return {
  update(data,requestStarted){
   const time=now(),elapsed=Math.max(0,time-requestStarted);
   result={...data,members:(data.members||[]).map(member=>{
    const ttl=member.location?.expiresInMs,remaining=typeof ttl==='number'&&Number.isFinite(ttl)?Math.max(0,Math.min(60000,ttl)-elapsed):0;
    return {...member,location:remaining>0?member.location:null,locationUntil:time+remaining,onlineUntil:time+Math.max(0,60000-elapsed)};
   })};publish();
  },
  clear(){if(result){result={...result,members:result.members.map(member=>({...member,location:null,online:false,locationUntil:0,onlineUntil:0}))};publish();}},
  reset(){stop();result=null;}
 };
}
