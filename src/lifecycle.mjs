// Socket closure does not mean an asynchronous handler has stopped using its
// database. Drain work separately, including maintenance, before releasing it.
export function createWorkTracker() {
 let active=0;
 const waiters=new Set();
 return {
  enter() {
   active++;
   let finished=false;
   return () => {
    if(finished)return;
    finished=true;
    if(--active===0){for(const resolve of waiters)resolve();waiters.clear();}
   };
  },
  idle() {return active===0?Promise.resolve():new Promise(resolve=>waiters.add(resolve));},
 };
}
