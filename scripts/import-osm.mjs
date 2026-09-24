import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {openDb} from '../src/db.mjs';
import {importOsm,osmQuery} from '../src/osm.mjs';
import {CITIES,DEFAULT_CITY} from '../src/cities.mjs';
import {runtimeConfig} from '../src/runtime.mjs';
import {appendAudit,sealLegacyAudit} from '../src/security.mjs';

try{
 const args=process.argv.slice(2);let cityId=DEFAULT_CITY,file=null,printQuery=false;
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--query'){printQuery=true;continue;}
  if(arg==='--city'||arg==='--file'){
   const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`Укажите значение ${arg}`);
   if(arg==='--city')cityId=value;else file=value;
   continue;
  }
  throw new Error(`Неизвестный аргумент: ${arg}`);
 }
 if(!Object.hasOwn(CITIES,cityId))throw new Error('Город должен быть almaty или astana');
 const query=osmQuery(cityId);
 if(printQuery){console.log(query);process.exit(0);}
 if(process.env.DATABASE_URL)throw new Error('PostgreSQL mode: import the city JSON through the administrator cabinet; this CLI updates SQLite only.');
 let data;
 if(file){data=JSON.parse(await readFile(file,'utf8'));}
 else {
  console.log(`Загрузка организаций: ${CITIES[cityId].name}. Может занять до 2 минут…`);
  const res=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'CityQuest/0.2 (OSM organization import)'},body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(120000)});
  if(!res.ok)throw new Error(`Overpass HTTP ${res.status}`);
  data=await res.json();
  if(data.remark)throw new Error('Overpass вернул неполный ответ: '+String(data.remark).slice(0,200));
  await mkdir('data',{recursive:true});await writeFile(`data/osm-last-import-${cityId}.json`,JSON.stringify(data));
 }
 const db=openDb();
 try{
  const cfg=runtimeConfig(db);
  const result=importOsm(db,data,cityId,{onImported:report=>{
   sealLegacyAudit(db,cfg.keys.auditKey);
   appendAudit(db,{actor:null,action:'osm.import',target:cityId,at:report.at,metadata:{...report,source:'local_cli'}},cfg.keys.auditKey);
  }});
  console.log(JSON.stringify({cityId,...result},null,2));
 }finally{db.close();}
}catch(e){
 console.error('Импорт не выполнен: '+e.message);
 console.error('Пример: npm run import:osm -- --city astana --file /path/organizations.json');
 process.exitCode=1;
}
