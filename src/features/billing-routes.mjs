import {id,fail,text,choice,city} from '../domain.mjs';
import {get,all,run,audit} from './store.mjs';
import {billingConfig,billingCatalog,isNativeBillingClient,getEntitlements,planFamily,PLAN_IDS,BUSINESS_CAMPAIGN_SLOTS,ORDER_TTL_MS,BILLING_PERIOD_MS,MANUAL_NOTICE,NATIVE_NOTICE} from './billing.mjs';

const MANAGERS=['business','admin'];
const RESOURCE=/^[a-zA-Z0-9-]{1,100}$/;
const KEY=/^[a-zA-Z0-9_-]{8,100}$/;
const nowOrder=(row,now=Date.now())=>row&&({...row,status:row.status==='pending'&&row.expires_at<=now?'expired':row.status});
function ownOrder(row,now){const {payment_reference,admin_note,...visible}=nowOrder(row,now);return visible;}
function adminMfa(actor){if(actor.role!=='admin')fail('Недостаточно прав',403);if(!actor.mfa_enabled||!actor.session_mfa_verified)fail('Для финансовых операций и модерации рекламы нужен подтверждённый MFA администратора',403);}
function checkout(config,req,cfg){if(isNativeBillingClient(req,cfg))fail(NATIVE_NOTICE,403);if(!config.manualEnabled)fail('Ручная оплата пилота отключена',503);}
function identifier(value,label){if(typeof value!=='string'||!RESOURCE.test(value))fail(`${label}: неверный идентификатор`);return value;}
function reference(value){const result=text(value,'Внешний номер платежа',120,4);if(/[\x00-\x1f\x7f]/.test(result))fail('Некорректный номер платежа');return result;}
function expectedVersion(body,item){if(!Number.isSafeInteger(body.version)||body.version!==item.version)fail('Кампания изменилась. Обновите данные.',409);}
function orderPageLimit(value){
 if(value===null||value==='')return 50;
 if(!/^[0-9]+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>200)fail('Размер страницы должен быть от 1 до 200');
 return Number(value);
}
function orderCursor(value,actorId){
 if(!value)return null;
 try {
  if(value.length>1024||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
  const decoded=Buffer.from(value,'base64url');if(decoded.toString('base64url')!==value)throw Error();
  const item=JSON.parse(decoded.toString('utf8'));
  if(!Array.isArray(item)||item.length!==4||item[0]!=='admin-billing:v1'||item[1]!==actorId||!Number.isSafeInteger(item[2])||item[2]<0||typeof item[3]!=='string'||!RESOURCE.test(item[3]))throw Error();
  return {createdAt:item[2],id:item[3]};
 } catch {fail('Некорректный курсор страницы');}
}
function promotionCursor(value,actorId,view,cityId){
 if(!value)return null;
 try {
  if(value.length>1024||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
  const decoded=Buffer.from(value,'base64url');if(decoded.toString('base64url')!==value)throw Error();
  const item=JSON.parse(decoded.toString('utf8'));
  if(!Array.isArray(item)||item.length!==6||item[0]!=='promotions:v1'||item[1]!==actorId||item[2]!==view||item[3]!==cityId||!Number.isSafeInteger(item[4])||item[4]<0||typeof item[5]!=='string'||!RESOURCE.test(item[5]))throw Error();
  return {createdAt:item[4],id:item[5]};
 } catch {fail('Некорректный курсор страницы');}
}
function* organizationAndQuest(ownerId,organizationId,questId,cityId,now){
 const org=yield get('SELECT * FROM organizations WHERE id=$1 FOR UPDATE',[identifier(organizationId,'Организация')]);
 if(!org||org.owner_id!==ownerId)fail('Можно продвигать только свою организацию',403);
 if(org.city_id!==cityId||org.status!=='approved')fail('Нужна одобренная организация в выбранном городе',409);
 let quest=null;
 if(questId){
  quest=yield get('SELECT * FROM quests WHERE id=$1 FOR UPDATE',[identifier(questId,'Квест')]);
  if(!quest||quest.owner_id!==ownerId||quest.organization_id!==org.id||quest.city_id!==cityId||quest.scope!=='public'||quest.status!=='published'||quest.assigned_to)fail('Нужен свой опубликованный общий квест этой организации',409);
  if((quest.starts_at&&quest.starts_at>now)||(quest.ends_at&&quest.ends_at<=now))fail('Квест сейчас недоступен по расписанию',409);
  if(quest.max_completions!==null&&quest.max_completions!==undefined){const n=yield get('SELECT count(*) AS n FROM completions WHERE quest_id=$1',[quest.id]);if(Number(n.n)>=quest.max_completions)fail('Квест достиг лимита выполнений',409);}
 }
 return {org,quest};
}
function* campaignQuota(ownerId,excluding,now){
 const entitlements=yield* getEntitlements(ownerId,now);
 if(!entitlements.campaignSlots)fail('Для рекламы нужен активный бизнес-тариф',403);
 const count=yield get("SELECT count(*) AS n FROM promotions WHERE owner_id=$1 AND status IN ('pending','approved') AND id<>$2",[ownerId,excluding||'']);
 if(Number(count.n)>=entitlements.campaignSlots)fail('Лимит кампаний тарифа исчерпан. Архивируйте одну из кампаний.',409);
 return entitlements;
}
const PROMO_ELIGIBILITY=`p.status='approved' AND u.disabled=0 AND u.role IN ('business','admin') AND o.status='approved' AND o.owner_id=p.owner_id AND o.city_id=p.city_id
 AND (p.quest_id IS NULL OR (q.id IS NOT NULL AND q.owner_id=p.owner_id AND q.organization_id=p.organization_id AND q.city_id=p.city_id AND q.scope='public' AND q.assigned_to IS NULL AND q.status='published' AND (q.starts_at IS NULL OR q.starts_at<=$2) AND (q.ends_at IS NULL OR q.ends_at>$2) AND (q.max_completions IS NULL OR (SELECT count(*) FROM completions c WHERE c.quest_id=q.id)<q.max_completions)))`;

export function createBillingRoutes({store,cfg={},env=cfg.env||process.env}){
 const config=billingConfig(env);
 return async function route(ctx){
  const req=ctx.req||{headers:{}},url=ctx.url,path=ctx.path??url.pathname,method=ctx.method??req.method,user=ctx.user;
  if(!path.startsWith('/api/billing')&&!path.startsWith('/api/admin/billing')&&!path.startsWith('/api/manage/promotions')&&!path.startsWith('/api/admin/promotions')&&path!=='/api/promotions')return undefined;
  const cityId=city(ctx.cityId||url.searchParams.get('city')||'almaty').id;
  const readBody=ctx.readBody||(()=>ctx.readAuthorizedJson(req,user));
  if(path==='/api/billing/catalog'&&method==='GET')return billingCatalog(config,{native:isNativeBillingClient(req,cfg)});
  if(path!=='/api/promotions'&&!user?.id)fail('Войдите в аккаунт',401);
  if(path==='/api/billing/me'&&method==='GET')return store.transaction(function*(){const actor=yield* store.requireActor(user);const now=Date.now();return {entitlements:yield* getEntitlements(actor.id,now),orders:(yield all('SELECT * FROM billing_orders WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 50',[actor.id])).map(row=>ownOrder(row,now))};});
  if(path==='/api/billing/orders'&&method==='GET')return store.transaction(function*(){const actor=yield* store.requireActor(user);return {orders:(yield all('SELECT * FROM billing_orders WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 50',[actor.id])).map(row=>ownOrder(row,Date.now()))};});
  if(path==='/api/billing/orders'&&method==='POST'){
   checkout(config,req,cfg);const body=await readBody();const plan=choice(body.plan,PLAN_IDS,'тариф');if(typeof body.idempotencyKey!=='string'||!KEY.test(body.idempotencyKey))fail('Ключ идемпотентности: от 8 до 100 букв, цифр, _ или -');
   return store.transaction(function*(){
    const actor=yield* store.requireActor(user);if(planFamily(plan)==='business'&&!MANAGERS.includes(actor.role))fail('Бизнес-тариф доступен кабинету бизнеса',403);
    const now=Date.now(),existing=yield get('SELECT * FROM billing_orders WHERE user_id=$1 AND idempotency_key=$2',[actor.id,body.idempotencyKey]);
    if(existing){if(existing.plan!==plan)fail('Этот ключ уже использован для другого тарифа',409);return {order:ownOrder(existing,now),idempotent:true,notice:MANUAL_NOTICE};}
    yield run("UPDATE billing_orders SET status='expired' WHERE user_id=$1 AND status='pending' AND expires_at<=$2",[actor.id,now]);
    const ent=yield* getEntitlements(actor.id,now),family=planFamily(plan);
    if(family==='player'?ent.playerPlan!=='free':ent.businessPlan!=='free')fail('Дождитесь окончания действующего тарифа этой категории',409);
    const pending=yield all("SELECT plan FROM billing_orders WHERE user_id=$1 AND status='pending'",[actor.id]);
    if(pending.length>=3||pending.some(row=>planFamily(row.plan)===family))fail('У вас уже есть ожидающая оплаты заявка этой категории',409);
    const oid=id();yield run('INSERT INTO billing_orders(id,user_id,plan,amount,currency,status,idempotency_key,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[oid,actor.id,plan,config.prices[plan],'KZT','pending',body.idempotencyKey,now,now+ORDER_TTL_MS]);
    yield audit(actor.id,'billing.order_created',oid,{plan,amount:config.prices[plan],currency:'KZT'});
    return {order:ownOrder(yield get('SELECT * FROM billing_orders WHERE id=$1',[oid]),now),idempotent:false,notice:MANUAL_NOTICE};
   });
  }
  if(path==='/api/admin/billing'&&method==='GET')return store.transaction(function*(){
   const actor=yield* store.requireActor(user,['admin']);adminMfa(actor);
   const limit=orderPageLimit(url.searchParams.get('limit')),cursor=orderCursor(url.searchParams.get('cursor'),actor.id);
   if(url.searchParams.has('offset'))fail('Для страниц заявок используйте курсор');
   const total=Number((yield get('SELECT count(*) AS n FROM billing_orders')).n);
   const rows=yield all(`SELECT b.*,u.name AS user_name,u.email AS user_email FROM billing_orders b JOIN users u ON u.id=b.user_id ${cursor?'WHERE (b.created_at,b.id)<($2,$3)':''} ORDER BY b.created_at DESC,b.id DESC LIMIT $1`,cursor?[limit+1,cursor.createdAt,cursor.id]:[limit+1]);
   const orders=rows.slice(0,limit),last=orders.at(-1),next=rows.length>limit?Buffer.from(JSON.stringify(['admin-billing:v1',actor.id,Number(last.created_at),last.id])).toString('base64url'):null;
   const now=Date.now();return {orders:orders.map(row=>nowOrder(row,now)),total,limit,next_cursor:next,notice:MANUAL_NOTICE};
  });
  const orderLookup=path.match(/^\/api\/admin\/billing\/([a-zA-Z0-9-]{1,100})$/);
  if(orderLookup&&method==='GET')return store.transaction(function*(){
   const actor=yield* store.requireActor(user,['admin']);adminMfa(actor);
   const order=yield get('SELECT b.*,u.name AS user_name,u.email AS user_email FROM billing_orders b JOIN users u ON u.id=b.user_id WHERE b.id=$1',[orderLookup[1]]);
   if(!order)fail('Заявка не найдена',404);
   return {order:nowOrder(order),notice:MANUAL_NOTICE};
  });
  const financial=path.match(/^\/api\/admin\/billing\/([a-zA-Z0-9-]+)\/(confirm|refund)$/);
  if(financial&&method==='POST'){
   if(financial[2]==='confirm')checkout(config,req,cfg);
   const body=await readBody(),paymentReference=financial[2]==='confirm'?reference(body.paymentReference):null,note=text(body.note||'',financial[2]==='refund'?'Причина возврата':'Примечание',500,financial[2]==='refund'?5:0);
   return store.transaction(function*(){
    const snapshot=yield get('SELECT user_id FROM billing_orders WHERE id=$1',[financial[1]]);if(!snapshot)fail('Заявка не найдена',404);
    const actor=yield* store.requireActor(user,['admin'],[snapshot.user_id]);adminMfa(actor);
    const order=yield get('SELECT * FROM billing_orders WHERE id=$1 FOR UPDATE',[financial[1]]),now=Date.now();
    if(financial[2]==='refund'){
     if(order.status==='refunded')return {order:nowOrder(order,now),idempotent:true,moneyTransferred:false,notice:'Возврат уже отмечен. Приложение не переводит деньги.'};
     if(order.status!=='paid')fail('Возврат можно отметить только для оплаченной заявки',409);
     yield run("UPDATE billing_orders SET status='refunded',refunded_at=$1,admin_note=$2 WHERE id=$3",[now,note,order.id]);
     yield run('UPDATE billing_entitlements SET revoked_at=$1 WHERE order_id=$2 AND revoked_at IS NULL',[now,order.id]);
     yield audit(actor.id,'billing.refund_recorded',order.id,{plan:order.plan,amount:order.amount,currency:order.currency});
     return {order:nowOrder(yield get('SELECT * FROM billing_orders WHERE id=$1',[order.id]),now),idempotent:false,moneyTransferred:false,notice:'Отметка внешнего возврата сохранена, доступ отозван. Приложение не переводит деньги.'};
    }
    if(order.status==='paid'){if(order.payment_reference!==paymentReference)fail('Оплата уже подтверждена с другим номером платежа',409);return {order:nowOrder(order,now),idempotent:true,moneyTransferred:false,notice:MANUAL_NOTICE};}
    if(order.status!=='pending'||order.expires_at<=now)fail('Заявка закрыта или срок оплаты истёк',409);
    const buyer=yield get('SELECT role,disabled FROM users WHERE id=$1',[order.user_id]);if(!buyer||buyer.disabled)fail('Аккаунт получателя недоступен',409);
    if(planFamily(order.plan)==='business'&&!MANAGERS.includes(buyer.role))fail('Получатель больше не имеет роли бизнеса',409);
    const ent=yield* getEntitlements(order.user_id,now);if(planFamily(order.plan)==='player'?ent.playerPlan!=='free':ent.businessPlan!=='free')fail('У получателя уже действует тариф этой категории',409);
    const duplicate=yield get('SELECT id FROM billing_orders WHERE payment_reference=$1',[paymentReference]);if(duplicate)fail('Этот платёж уже связан с другой заявкой',409);
    const ends=now+BILLING_PERIOD_MS;
    yield run("UPDATE billing_orders SET status='paid',paid_at=$1,payment_reference=$2,admin_note=$3,service_starts_at=$1,service_ends_at=$4 WHERE id=$5",[now,paymentReference,note,ends,order.id]);
    yield run('INSERT INTO billing_entitlements(id,order_id,user_id,plan,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6)',[id(),order.id,order.user_id,order.plan,now,ends]);
    yield audit(actor.id,'billing.payment_recorded',order.id,{plan:order.plan,amount:order.amount,currency:order.currency,ends_at:ends});
    return {order:nowOrder(yield get('SELECT * FROM billing_orders WHERE id=$1',[order.id]),now),idempotent:false,moneyTransferred:false,notice:MANUAL_NOTICE};
   });
  }
  if(path==='/api/promotions'&&method==='GET')return store.read(function*(){
   // Rank each owner's eligible campaigns globally before choosing a city.
   // A downgrade must not multiply one paid slot across multiple city pages.
   // The single snapshot also avoids one entitlement roundtrip per advertiser.
   const now=Date.now(),candidates=yield all(`WITH eligible AS (
    SELECT p.*,o.name AS organization_name,o.lng,o.lat,
    CASE WHEN EXISTS(SELECT 1 FROM billing_entitlements pe WHERE pe.user_id=p.owner_id AND pe.plan='business_pro' AND pe.starts_at<=$2 AND pe.ends_at>$2 AND pe.revoked_at IS NULL) THEN ${BUSINESS_CAMPAIGN_SLOTS.business_pro} ELSE ${BUSINESS_CAMPAIGN_SLOTS.business_start} END AS campaign_slots,
    ROW_NUMBER() OVER(PARTITION BY p.owner_id ORDER BY p.created_at,p.id) AS campaign_rank
    FROM promotions p JOIN organizations o ON o.id=p.organization_id JOIN users u ON u.id=p.owner_id LEFT JOIN quests q ON q.id=p.quest_id
    WHERE p.owner_id IN (SELECT owner_id FROM promotions WHERE city_id=$1 AND status='approved') AND ${PROMO_ELIGIBILITY}
    AND EXISTS(SELECT 1 FROM billing_entitlements e WHERE e.user_id=p.owner_id AND e.plan IN ('business_start','business_pro') AND e.starts_at<=$2 AND e.ends_at>$2 AND e.revoked_at IS NULL)
   ) SELECT * FROM eligible WHERE city_id=$1 AND campaign_rank<=campaign_slots ORDER BY created_at,id LIMIT 50`,[cityId,now]);
   const items=candidates.map(row=>({id:row.id,cityId:row.city_id,title:row.title,description:row.description,organizationId:row.organization_id,organizationName:row.organization_name,questId:row.quest_id,lng:row.lng,lat:row.lat,label:'Реклама'}));
   return {items,cityId};
  });
  if((path==='/api/manage/promotions'||path==='/api/admin/promotions')&&method==='GET')return store.transaction(function*(){
   const admin=path==='/api/admin/promotions',actor=yield* store.requireActor(user,admin?['admin']:MANAGERS);if(admin)adminMfa(actor);
   const view=admin?'admin':'manage',limit=orderPageLimit(url.searchParams.get('limit')),cursor=promotionCursor(url.searchParams.get('cursor'),actor.id,view,cityId);
   if(url.searchParams.has('offset'))fail('Для страниц рекламных карточек используйте курсор');
   const params=admin?[cityId]:[cityId,actor.id],scope=`p.city_id=$1${admin?'':' AND p.owner_id=$2'}`;
   const total=Number((yield get(`SELECT count(*) AS n FROM promotions p WHERE ${scope}`,params)).n);
   let pageScope=scope;
   if(cursor){params.push(cursor.createdAt,cursor.id);pageScope+=` AND (p.created_at,p.id)<($${params.length-1},$${params.length})`;}
   params.push(limit+1);
   const rows=yield all(`SELECT p.*,o.name AS organization_name,(SELECT count(*) FROM completions c JOIN quests cq ON cq.id=c.quest_id WHERE c.quest_id=p.quest_id AND cq.owner_id=p.owner_id AND cq.organization_id=p.organization_id AND o.owner_id=p.owner_id) AS quest_completions FROM promotions p JOIN organizations o ON o.id=p.organization_id WHERE ${pageScope} ORDER BY p.created_at DESC,p.id DESC LIMIT $${params.length}`,params);
   const items=rows.slice(0,limit),last=items.at(-1),next=rows.length>limit?Buffer.from(JSON.stringify(['promotions:v1',actor.id,view,cityId,Number(last.created_at),last.id])).toString('base64url'):null;
   return {items,total,limit,next_cursor:next,entitlements:yield* getEntitlements(actor.id),metricsNotice:'Выполнения — общий счётчик связанного квеста, не атрибуция рекламе. Содержимое разговоров с питомцем не используется.'};
  });
  if(path==='/api/manage/promotions'&&method==='POST'){
   const body=await readBody(),title=text(body.title,'Название кампании',120,3),description=text(body.description||'','Описание кампании',500,0);
   return store.transaction(function*(){const actor=yield* store.requireActor(user,MANAGERS),now=Date.now();yield* campaignQuota(actor.id,null,now);const {org,quest}=yield* organizationAndQuest(actor.id,body.organizationId,body.questId||null,cityId,now),pid=id();
    yield run("INSERT INTO promotions(id,owner_id,organization_id,quest_id,city_id,title,description,status,created_at,updated_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$8,1)",[pid,actor.id,org.id,quest?.id||null,cityId,title,description,now]);yield audit(actor.id,'promotion.created',pid,{city_id:cityId});return {item:yield get('SELECT * FROM promotions WHERE id=$1',[pid])};});
  }
  const edit=path.match(/^\/api\/manage\/promotions\/([a-zA-Z0-9-]+)$/);
  if(edit&&method==='PATCH'){
   const body=await readBody();
   return store.transaction(function*(){
    const actor=yield* store.requireActor(user,MANAGERS),item=yield get('SELECT * FROM promotions WHERE id=$1',[edit[1]]);if(!item)fail('Кампания не найдена',404);if(item.owner_id!==actor.id)fail('Это чужая кампания',403);expectedVersion(body,item);
    const now=Date.now(),status=choice(body.status||'pending',['pending','archived'],'статус');
    if(status==='archived'){yield run("UPDATE promotions SET status='archived',version=version+1,updated_at=$1 WHERE id=$2",[now,item.id]);}
    else {yield* campaignQuota(actor.id,item.id,now);const {org,quest}=yield* organizationAndQuest(actor.id,body.organizationId??item.organization_id,body.questId===undefined?item.quest_id:body.questId||null,item.city_id,now);yield run("UPDATE promotions SET organization_id=$1,quest_id=$2,title=$3,description=$4,status='pending',version=version+1,updated_at=$5,reviewed_at=NULL,reviewed_by=NULL WHERE id=$6",[org.id,quest?.id||null,text(body.title??item.title,'Название кампании',120,3),text(body.description??item.description,'Описание кампании',500,0),now,item.id]);}
    yield audit(actor.id,'promotion.updated',item.id,{city_id:item.city_id,status});return {item:yield get('SELECT * FROM promotions WHERE id=$1',[item.id])};
   });
  }
  const review=path.match(/^\/api\/admin\/promotions\/([a-zA-Z0-9-]+)\/review$/);
  if(review&&method==='POST'){
   const body=await readBody(),status=choice(body.status,['approved','rejected'],'решение');
   return store.transaction(function*(){
    const snapshot=yield get('SELECT owner_id FROM promotions WHERE id=$1',[review[1]]);if(!snapshot)fail('Кампания не найдена',404);const actor=yield* store.requireActor(user,['admin'],[snapshot.owner_id]);adminMfa(actor);
    const item=yield get('SELECT * FROM promotions WHERE id=$1 FOR UPDATE',[review[1]]);expectedVersion(body,item);if(item.status==='archived')fail('Кампания архивирована',409);const now=Date.now();
    if(status==='approved'){const owner=yield get('SELECT role,disabled FROM users WHERE id=$1',[item.owner_id]);if(!owner||owner.disabled||!MANAGERS.includes(owner.role))fail('Кабинет бизнеса недоступен',409);yield* campaignQuota(item.owner_id,item.id,now);yield* organizationAndQuest(item.owner_id,item.organization_id,item.quest_id,item.city_id,now);}
    yield run('UPDATE promotions SET status=$1,reviewed_at=$2,reviewed_by=$3,updated_at=$2,version=version+1 WHERE id=$4',[status,now,actor.id,item.id]);yield audit(actor.id,'promotion.reviewed',item.id,{city_id:item.city_id,status});return {item:yield get('SELECT * FROM promotions WHERE id=$1',[item.id])};
   });
  }
  return undefined;
 };
}
