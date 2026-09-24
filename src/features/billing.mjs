import {all} from './store.mjs';

export const BILLING_PERIOD_DAYS=30;
export const BILLING_PERIOD_MS=BILLING_PERIOD_DAYS*86400000;
export const ORDER_TTL_MS=7*86400000;
export const PLAN_IDS=['plus','business_start','business_pro'];
export const BUSINESS_CAMPAIGN_SLOTS=Object.freeze({business_start:1,business_pro:5});
export const MANUAL_NOTICE='Пилот: заявка на ручную оплату. Это не кассовый чек и не платёжная форма. Оплата и возврат выполняются вне приложения; автопродления нет.';
export const NATIVE_NOTICE='Покупки в мобильном приложении пока недоступны. Уже активированные возможности синхронизируются с аккаунтом.';

function price(env,key,fallback){
 const value=env[key];if(value===undefined||value==='')return fallback;
 if(!/^[1-9]\d{0,9}$/.test(String(value))||Number(value)>1000000000)throw new Error(`${key}: ожидается целое число от 1 до 1000000000`);
 return Number(value);
}
export function billingConfig(env=process.env){
 if(env.BILLING_MANUAL_ENABLED!==undefined&&!['true','false',''].includes(env.BILLING_MANUAL_ENABLED))throw new Error('BILLING_MANUAL_ENABLED: ожидается true или false');
 return {manualEnabled:env.BILLING_MANUAL_ENABLED==='true',prices:{plus:price(env,'BILLING_PLUS_KZT',1490),business_start:price(env,'BILLING_BUSINESS_START_KZT',14990),business_pro:price(env,'BILLING_BUSINESS_PRO_KZT',49990)}};
}
export function isNativeBillingClient(req={},cfg={}){
 const origin=req.headers?.origin;
 return req.headers?.['x-cityquest-client']==='native'||(typeof origin==='string'&&((cfg.nativeOrigins||[]).includes(origin)||origin==='capacitor://localhost'||origin==='https://localhost'));
}
export function planFamily(plan){return plan==='plus'?'player':'business';}
export function billingCatalog(config,{native=false}={}){
 return {currency:'KZT',periodDays:BILLING_PERIOD_DAYS,pilot:true,manualEnabled:config.manualEnabled,checkoutAvailable:config.manualEnabled&&!native,nativePurchasesAvailable:false,notice:native?NATIVE_NOTICE:MANUAL_NOTICE,
  plans:[
   {id:'free',name:'Бесплатно',audience:'player',amount:0,aiMessagesPerDay:5,premiumColors:false,campaignSlots:0,features:['Карта, квесты и команда','Рост питомца и ежедневная забота','До 5 ИИ-сообщений в день при подключённом ИИ']},
   {id:'plus',name:'Игрок Plus',audience:'player',amount:config.prices.plus,aiMessagesPerDay:40,premiumColors:true,campaignSlots:0,features:['До 40 ИИ-сообщений в день при подключённом ИИ','Дополнительные цвета питомца','Без ускорения наград и роста за деньги']},
   {id:'business_start',name:'Бизнес Старт',audience:'business',amount:config.prices.business_start,aiMessagesPerDay:5,premiumColors:false,campaignSlots:BUSINESS_CAMPAIGN_SLOTS.business_start,features:['1 рекламная кампания','Модерация и явная маркировка рекламы','Агрегированные выполнения связанного квеста']},
   {id:'business_pro',name:'Бизнес Про',audience:'business',amount:config.prices.business_pro,aiMessagesPerDay:5,premiumColors:false,campaignSlots:BUSINESS_CAMPAIGN_SLOTS.business_pro,features:['До 5 рекламных кампаний','Модерация и явная маркировка рекламы','Агрегированные выполнения связанных квестов']}
  ]};
}
export function* getEntitlements(userId,now=Date.now()){
 const rows=yield all('SELECT plan,ends_at FROM billing_entitlements WHERE user_id=$1 AND starts_at<=$2 AND ends_at>$2 AND revoked_at IS NULL ORDER BY ends_at DESC,id',[userId,now]);
 const player=rows.find(row=>row.plan==='plus'),business=rows.find(row=>row.plan==='business_pro')||rows.find(row=>row.plan==='business_start');
 return {playerPlan:player?'plus':'free',aiMessagesPerDay:player?40:5,premiumColors:!!player,businessPlan:business?.plan||'free',campaignSlots:BUSINESS_CAMPAIGN_SLOTS[business?.plan]||0,playerExpiresAt:player?.ends_at??null,businessExpiresAt:business?.ends_at??null};
}
