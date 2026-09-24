import {id} from './domain.mjs';
import {transaction} from './db.mjs';
import {CITIES, DEFAULT_CITY} from './cities.mjs';

export function osmQuery(cityId=DEFAULT_CITY) {
 const city=Object.hasOwn(CITIES,cityId)?CITIES[cityId]:null;
 if(!city)throw new Error('Неизвестный город');
 const {south,west,north,east}=city.bounds;
 return `[out:json][timeout:90];nwr["name"][~"^(amenity|shop|tourism|office|craft|leisure)$"~"."](${south},${west},${north},${east});out center tags;`;
}
export const OSM_QUERY=osmQuery(DEFAULT_CITY);

export function importOsm(db,data,cityId=DEFAULT_CITY,{onImported}={}) {
 const city=Object.hasOwn(CITIES,cityId)?CITIES[cityId]:null;
 if(!city)throw new Error('Неизвестный город');
 const bounds=city.bounds;
 if(!Array.isArray(data?.elements)||data.elements.length>50000)throw new Error('Ожидается Overpass JSON, максимум 50000 объектов');
 if(data.remark)throw new Error('Overpass вернул неполный ответ: '+String(data.remark).slice(0,200));
 if(onImported!==undefined&&typeof onImported!=='function')throw new TypeError('onImported должен быть синхронной функцией');
 const importedAt=Date.now();
 let inserted=0,updated=0,skipped=0;
 return transaction(db,()=>{
 const find=db.prepare('SELECT id,owner_id,city_id FROM organizations WHERE osm_id=?');
 const update=db.prepare('UPDATE organizations SET name=?,category=?,lng=?,lat=?,address=?,source=?,city_id=?,version=version+1,updated_at=? WHERE id=?');
 const insert=db.prepare('INSERT INTO organizations(id,name,category,lng,lat,address,description,status,source,osm_id,created_at,city_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
 for(const item of data.elements){
 const tags=item?.tags||{},lng=item?.lon??item?.center?.lon,lat=item?.lat??item?.center?.lat;
 if(!['node','way','relation'].includes(item?.type)||!Number.isSafeInteger(item.id)||item.id<=0||typeof tags.name!=='string'||!tags.name.trim()||!Number.isFinite(lng)||!Number.isFinite(lat)||lng<bounds.west||lng>bounds.east||lat<bounds.south||lat>bounds.north){skipped++;continue;}
 const osmId=`${item.type}/${item.id}`,existing=find.get(osmId);
 // A global OSM ID has one card. Never overwrite a card claimed by a business.
 if(existing?.owner_id){skipped++;continue;}
 const name=String(tags['name:ru']||tags.name).slice(0,160),category=String(tags.shop?'shop':tags.amenity||tags.tourism||tags.leisure||tags.office||tags.craft||'other').slice(0,60);
 const address=[tags['addr:street'],tags['addr:housenumber']].filter(Boolean).join(' ').slice(0,250);
 const description='Импорт OpenStreetMap. Актуальность и часы работы уточняйте у организации.';
 if(existing){update.run(name,category,lng,lat,address,`https://www.openstreetmap.org/${osmId}`,cityId,importedAt,existing.id);updated++;}
 else{insert.run(id(),name,category,lng,lat,address,description,'approved',`https://www.openstreetmap.org/${osmId}`,osmId,importedAt,cityId,importedAt);inserted++;}
 }
 const report={cityId,at:importedAt,sourceTimestamp:data.osm3s?.timestamp_osm_base||null,inserted,updated,skipped};
 db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`osm_import_${cityId}`,JSON.stringify(report));
 // Preserve the v1 diagnostics key for existing integrations.
 db.prepare("INSERT INTO meta(key,value) VALUES('osm_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(report));
 // Auditing belongs to the import transaction: if it fails, no catalog changes commit.
 const callbackResult=onImported?.(report);
 if(callbackResult&&typeof callbackResult.then==='function')throw new TypeError('onImported должен быть синхронной функцией');
 return {inserted,updated,skipped};
 });
}
