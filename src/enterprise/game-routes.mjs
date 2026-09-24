import {randomBytes} from 'node:crypto';
import {id,hash,fail,text,number,point,distance,cell,normalizeCode,city} from '../domain.mjs';
import {DEFAULT_CITY} from '../cities.mjs';
import {enterpriseListRoutes} from '../features/list-routes.mjs';

// Actor locks come before resource locks in every mutation. The auth helper uses
// FOR NO KEY UPDATE: changing XP/permissions is serialized while FK key-share
// locks (for example a team's new owner) cannot create cross-user deadlocks.
async function actor(ctx,tx){
  const fresh=await ctx.auth.freshActor(tx,ctx.user);
  ctx.required(fresh);
  return fresh;
}

export function createGameRoutes(){
  return async function route(ctx){
    const {db,url,path,method,cityId,user,required,readBody,audit,throttle,auth}=ctx;

    const listResult=await enterpriseListRoutes(ctx);
    if(listResult!==undefined)return listResult;

    if(path==='/api/location'&&method==='POST'){
      required(user);await throttle(`geo:${user.id}`,30);
      const body=await readBody(),selected=city(body.city_id||DEFAULT_CITY);
      point(body.lng,body.lat,selected.id);number(body.accuracy,'Точность GPS',0,150);
      number(body.timestamp,'Время GPS',Date.now()-120000,Date.now()+15000);
      const exploredCell=cell(body.lng,body.lat);
      const cellsTotal=await db.transaction(async tx=>{
        await actor(ctx,tx);
        const old=await tx.get('SELECT * FROM positions WHERE user_id=$1 FOR UPDATE',[user.id]),now=Date.now();
        if(old&&now-old.updated_at<120000&&distance(old,body)>Math.max(300,(now-old.updated_at)/1000*25))fail('Слишком резкое перемещение. Дождитесь точного GPS.');
        await tx.run('INSERT INTO positions(user_id,lng,lat,accuracy,updated_at,city_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET lng=EXCLUDED.lng,lat=EXCLUDED.lat,accuracy=EXCLUDED.accuracy,updated_at=EXCLUDED.updated_at,city_id=EXCLUDED.city_id',[user.id,body.lng,body.lat,body.accuracy,now,selected.id]);
        await tx.run('INSERT INTO explored(user_id,cell,created_at,city_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[user.id,exploredCell,now,selected.id]);
        return Number((await tx.get('SELECT count(*) n FROM explored WHERE user_id=$1 AND city_id=$2',[user.id,selected.id])).n);
      });
      return {ok:true,cell:exploredCell,city_id:selected.id,cells_total:cellsTotal};
    }

    if(path==='/api/location'&&method==='DELETE'){
      required(user);
      await db.transaction(async tx=>{
        await actor(ctx,tx);
        await tx.run('DELETE FROM positions WHERE user_id=$1',[user.id]);
        await tx.run('UPDATE members SET share_location=0 WHERE user_id=$1',[user.id]);
        await audit(tx,user.id,'privacy.position_deleted',user.id);
      });
      return {ok:true};
    }

    if(path==='/api/explored'&&method==='DELETE'){
      required(user);
      await db.transaction(async tx=>{
        await actor(ctx,tx);
        await tx.run('DELETE FROM explored WHERE user_id=$1 AND city_id=$2',[user.id,cityId]);
        await tx.run('DELETE FROM positions WHERE user_id=$1 AND city_id=$2',[user.id,cityId]);
        await audit(tx,user.id,'privacy.explored_deleted',user.id,{city_id:cityId});
      });
      return {ok:true};
    }

    const complete=path.match(/^\/api\/quests\/([a-zA-Z0-9-]+)\/complete$/);
    if(complete&&method==='POST'){
      required(user);await throttle(`complete:${user.id}`,20);
      const body=await readBody();
      return db.transaction(async tx=>{
        const current=await actor(ctx,tx);
        // This lock serializes cap checks, token redemption and management edits
        // on every app replica; the completion PK is a second idempotency guard.
        const quest=await tx.get('SELECT * FROM quests WHERE id=$1 FOR UPDATE',[complete[1]]);
        if(!quest||quest.status!=='published'||quest.assigned_to&&quest.assigned_to!==user.id)fail('Квест недоступен',404);
        if(await tx.get('SELECT quest_id FROM completions WHERE user_id=$1 AND quest_id=$2',[user.id,quest.id]))return {alreadyCompleted:true,xp:0,user:auth.publicUser(current)};
        const now=Date.now();
        if(quest.starts_at!==null&&quest.starts_at>now||quest.ends_at!==null&&quest.ends_at<=now)fail('Квест сейчас недоступен по расписанию',409);
        if(quest.max_completions!==null){
          const total=await tx.get('SELECT count(*) AS n FROM completions WHERE quest_id=$1',[quest.id]);
          if(Number(total.n)>=quest.max_completions)fail('Лимит наград исчерпан',409);
        }
        const position=await tx.get('SELECT * FROM positions WHERE user_id=$1',[user.id]);
        if(!position||position.city_id!==quest.city_id||now-position.updated_at>90000)fail('Обновите GPS в городе квеста перед подтверждением');
        const meters=distance(position,quest);
        if(meters>quest.radius+Math.min(position.accuracy,30))fail(`До места около ${Math.round(meters)} м. Подойдите ближе.`);
        if(quest.verification==='code'&&hash(normalizeCode(body.code))!==quest.code_hash)fail('Неверный код подтверждения');
        if(quest.verification==='token'){
          const code=normalizeCode(body.code);
          if(!/^[A-F0-9]{24}$/.test(code))fail('Неверный одноразовый код');
          const token=await tx.get('SELECT * FROM reward_tokens WHERE quest_id=$1 AND token_hash=$2 FOR UPDATE',[quest.id,hash(code)]);
          if(!token||token.redeemed_at!==null||token.revoked_at!==null||token.expires_at<=now)fail('Код недействителен, использован или истёк');
          const consumed=await tx.run('UPDATE reward_tokens SET redeemed_at=$1,redeemed_by=$2 WHERE id=$3 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>$1',[now,user.id,token.id]);
          if(!consumed.rowCount)fail('Код уже использован',409);
        }
        await tx.run('INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES($1,$2,$3,$4)',[user.id,quest.id,quest.xp,now]);
        await tx.run('UPDATE users SET xp=xp+$1 WHERE id=$2',[quest.xp,user.id]);
        await audit(tx,user.id,'quest.complete',quest.id,{city_id:quest.city_id,xp:quest.xp,verification:quest.verification});
        return {alreadyCompleted:false,xp:quest.xp,user:auth.publicUser({...current,xp:current.xp+quest.xp})};
      });
    }

    if(path==='/api/team'&&method==='GET'){
      required(user);
      return db.transaction(async tx=>{
        await actor(ctx,tx);
        // Hold the team membership stable until this response is assembled.
        const team=await tx.get('SELECT t.*,m.share_location FROM teams t JOIN members m ON m.team_id=t.id WHERE m.user_id=$1 FOR SHARE OF t',[user.id]);
        if(!team)return {team:null};
        if(team.city_id!==cityId)return {team:null,otherCity:team.city_id};
        const now=Date.now();
        const rows=await tx.all('SELECT u.id,u.name,u.xp,m.share_location,p.lng,p.lat,p.updated_at FROM members m JOIN users u ON u.id=m.user_id LEFT JOIN positions p ON p.user_id=u.id AND p.city_id=$1 WHERE m.team_id=$2 ORDER BY u.id',[team.city_id,team.id]);
        const members=rows.map(member=>({id:member.id,name:member.name,xp:member.xp,online:!!member.updated_at&&now-member.updated_at<60000,location:member.share_location&&member.updated_at&&now-member.updated_at<60000?{lng:member.lng,lat:member.lat,expiresInMs:Math.max(0,member.updated_at+60000-now)}:null}));
        const progress=await tx.all("SELECT q.id,q.title,q.goal,count(*) AS completions FROM completions c JOIN quests q ON q.id=c.quest_id JOIN members m ON m.user_id=c.user_id WHERE m.team_id=$1 AND q.city_id=$2 AND q.scope='public' AND q.status='published' AND c.created_at>=$3 AND c.created_at>=m.joined_at GROUP BY q.id",[team.id,team.city_id,team.created_at]);
        return {team:{...team,invite:team.owner_id===user.id?team.invite:undefined},members,progress:progress.map(item=>({...item,completions:Number(item.completions)}))};
      });
    }

    if(path==='/api/team'&&method==='POST'){
      required(user);await throttle(`team:${user.id}`,10);
      const body=await readBody(),selected=city(body.city_id||DEFAULT_CITY);
      const team={id:id(),name:text(body.name,'Название команды',60,2),owner_id:user.id,city_id:selected.id,invite:randomBytes(6).toString('hex').toUpperCase()};
      await db.transaction(async tx=>{
        await actor(ctx,tx);
        if(await tx.get('SELECT user_id FROM members WHERE user_id=$1',[user.id]))fail('Сначала выйдите из текущей команды');
        // Queue/actor-lock waits may outlive an earlier quest completion. Team
        // progress starts when membership is actually established, not when the
        // request first arrived before those waits.
        team.created_at=Date.now();
        await tx.run('INSERT INTO teams(id,name,owner_id,city_id,invite,created_at) VALUES($1,$2,$3,$4,$5,$6)',[team.id,team.name,team.owner_id,team.city_id,team.invite,team.created_at]);
        await tx.run('INSERT INTO members(user_id,team_id,joined_at) VALUES($1,$2,$3)',[user.id,team.id,team.created_at]);
        await audit(tx,user.id,'team.create',team.id,{city_id:selected.id});
      });
      return {team};
    }

    if(path==='/api/team/join'&&method==='POST'){
      required(user);await throttle(`join:${user.id}`,10,600000);
      const body=await readBody(),selected=city(body.city_id||DEFAULT_CITY);
      await db.transaction(async tx=>{
        await actor(ctx,tx);
        const team=await tx.get('SELECT * FROM teams WHERE invite=$1 FOR UPDATE',[normalizeCode(body.code)]);
        if(!team||team.city_id!==selected.id)fail('Команда не найдена в выбранном городе',404);
        if(await tx.get('SELECT user_id FROM members WHERE user_id=$1',[user.id]))fail('Сначала выйдите из текущей команды');
        const total=await tx.get('SELECT count(*) AS n FROM members WHERE team_id=$1',[team.id]);
        if(Number(total.n)>=20)fail('В команде уже 20 участников');
        await tx.run('INSERT INTO members(user_id,team_id,joined_at) VALUES($1,$2,$3)',[user.id,team.id,Date.now()]);
        await audit(tx,user.id,'team.join',team.id,{city_id:selected.id});
      });
      return {ok:true};
    }

    if(path==='/api/team/sharing'&&method==='PATCH'){
      required(user);const body=await readBody();
      if(typeof body.enabled!=='boolean')fail('Нужно логическое значение');
      await db.transaction(async tx=>{
        await actor(ctx,tx);
        await tx.run('UPDATE members SET share_location=$1 WHERE user_id=$2',[body.enabled?1:0,user.id]);
        await audit(tx,user.id,'privacy.team_sharing',user.id,{enabled:body.enabled});
      });
      return {ok:true};
    }

    if(path==='/api/team'&&method==='DELETE'){
      required(user);
      await db.transaction(async tx=>{
        await actor(ctx,tx);
        const team=await tx.get('SELECT t.* FROM teams t JOIN members m ON m.team_id=t.id WHERE m.user_id=$1 FOR UPDATE OF t',[user.id]);
        if(!team)return;
        await tx.run('DELETE FROM members WHERE user_id=$1',[user.id]);
        if(team.owner_id===user.id){
          const next=await tx.get('SELECT user_id FROM members WHERE team_id=$1 ORDER BY user_id LIMIT 1',[team.id]);
          if(next)await tx.run('UPDATE teams SET owner_id=$1,invite=$2 WHERE id=$3',[next.user_id,randomBytes(6).toString('hex').toUpperCase(),team.id]);
          else await tx.run('DELETE FROM teams WHERE id=$1',[team.id]);
        }
        await audit(tx,user.id,'team.leave',team.id,{city_id:team.city_id});
      });
      return {ok:true};
    }
    return undefined;
  };
}
