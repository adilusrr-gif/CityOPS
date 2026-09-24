// Each statement is an independent autocommit transaction. In particular, never
// hold an expired session lock while acquiring a challenge lock: authentication
// can hold those resources in the opposite order. SKIP LOCKED also lets replicas
// share this work without waiting for live requests or another cleanup worker.
export async function pruneEnterpriseData(db,{now=Date.now(),idleMs=1800000}={}) {
 if(db.isTransaction)throw new TypeError('Enterprise cleanup requires an autocommit database connection');
 if(!Number.isSafeInteger(now)||now<0)throw new TypeError('Cleanup time must be a non-negative safe integer');
 if(!Number.isSafeInteger(idleMs)||idleMs<=0)throw new TypeError('Session idle limit must be a positive safe integer');
 const tasks=[
  ['sessions','token','expires<=$1 OR last_seen<=$2',[now,now-idleMs]],
  ['positions','user_id','updated_at<$1',[now-3600000]],
  ['login_challenges','id_hash','expires<=$1',[now]],
  ['oidc_states','state_hash','expires<=$1',[now]],
  ['mobile_auth_codes','code_hash','expires<=$1',[now]],
  ['rate_limits','key','reset_at<=$1',[now]],
 ];
 const removed={};
 for(const [table,key,where,params] of tasks){
  const result=await db.run(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${where} ORDER BY ${key} LIMIT 1000 FOR UPDATE SKIP LOCKED)`,params);
  removed[table]=result.rowCount;
 }
 return removed;
}
