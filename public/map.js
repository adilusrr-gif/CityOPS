import {isNative} from './platform.js';
const CDN='https://cdn.jsdelivr.net/npm/';
let map,lib,ready=false,quests=[],organizations=[],cells=[],team=[],self=null,fog=true,threeVisible=true,markersLayer,orgTimer;
let selectQuest=()=>{},selectOrganization=()=>{},viewport=()=>{},selectAdventure=()=>{},selectTerritory=()=>{};
let adventures=[],territories=[];
let picking=null,localAssets=false,enginePromise,loadTimer,lifecycle=0;
let city,cellSize={lngCellSize:.002,latCellSize:.0015};
const dataKeys=['quests','organizations','cells','team','self','adventures','territories'];
const dirty=new Set(dataKeys);
let updateFrame;
const $=id=>document.getElementById(id);
const feature=(coords,properties)=>({type:'Feature',geometry:{type:'Point',coordinates:coords},properties});
const collection=features=>({type:'FeatureCollection',features});
async function asset(local,remote){return localAssets?local:remote;}
function notice(text){$('map-notice').textContent=text;$('map-notice').hidden=!text;}
export function destroyMap(){
 lifecycle++;ready=false;clearTimeout(orgTimer);clearTimeout(loadTimer);if(updateFrame)cancelAnimationFrame(updateFrame);updateFrame=null;for(const key of dataKeys)dirty.add(key);picking=null;markersLayer=null;
 if(map){map.remove();map=null;}
 organizations=[];team=[];self=null;adventures=[];territories=[];
}
async function loadEngine(local){
 if(window.maplibregl?.Map)return window.maplibregl;
 if(!enginePromise){
  const script=local?'/vendor/maplibre-gl.js':CDN+'maplibre-gl@5.6.1/dist/maplibre-gl.js';
  enginePromise=new Promise((resolve,reject)=>{
   if(!document.querySelector('[data-maplibre-css]')){const css=document.createElement('link');css.rel='stylesheet';css.href=script.replace(/\.js$/,'.css');css.dataset.maplibreCss='true';document.head.append(css);}
   const s=document.createElement('script');s.src=script;s.onload=()=>resolve(window.maplibregl);s.onerror=()=>{s.remove();enginePromise=null;reject(new Error('Не удалось загрузить картографический движок'));};document.head.append(s);
  });
 }
 return enginePromise;
}
export async function initMap(config,callbacks){
 destroyMap();const version=lifecycle;
 selectQuest=callbacks.selectQuest;selectOrganization=callbacks.selectOrganization;viewport=callbacks.viewport;selectAdventure=callbacks.selectAdventure||(()=>{});selectTerritory=callbacks.selectTerritory||(()=>{});localAssets=isNative()||!!config.localMapAssets;city=config.city;cellSize=config.productPolicy?.exploration||{lngCellSize:.002,latCellSize:.0015};
 notice('Загрузка карты · '+city.name+'…');$('map-caption-text').textContent='Загрузка 3D-мира · '+city.name;
 try{
 lib=await loadEngine(localAssets);if(version!==lifecycle)return;
 if(!lib?.Map)throw new Error('Картографический движок недоступен');
 map=new lib.Map({container:'map',style:config.mapStyle,center:city.center,zoom:city.zoom||13.8,pitch:threeVisible?52:0,bearing:threeVisible?-20:0,maxBounds:city.bounds,maxZoom:19,minZoom:10,canvasContextAttributes:{antialias:true},attributionControl:true});
 const currentMap=map;
 map.addControl(new lib.NavigationControl({visualizePitch:true}),'top-right');
 map.on('error',()=>{if(version===lifecycle&&!ready)notice('Карта не загрузилась. Проверьте соединение. Квесты и кабинеты доступны через меню.');});
 map.on('load',async()=>{
 if(version!==lifecycle)return;ready=true;clearTimeout(loadTimer);notice('');
 const style=map.getStyle(),source=Object.keys(style.sources).find(k=>style.sources[k].type==='vector'),before=style.layers.find(l=>l.type==='symbol')?.id;
 if(source&&!style.layers.some(l=>l.type==='fill-extrusion'))map.addLayer({id:'aq-buildings',type:'fill-extrusion',source,'source-layer':'building',minzoom:14,paint:{'fill-extrusion-color':'#29384a','fill-extrusion-height':['coalesce',['get','render_height'],['get','height'],8],'fill-extrusion-base':['coalesce',['get','render_min_height'],['get','min_height'],0],'fill-extrusion-opacity':.85}},before);
 map.addSource('aq-fog',{type:'geojson',data:collection([])});map.addLayer({id:'aq-fog',type:'fill',source:'aq-fog',paint:{'fill-color':'#030a15','fill-opacity':.32}},before);
 map.addSource('aq-quests',{type:'geojson',data:collection([])});
 map.addLayer({id:'aq-quest-glow',type:'circle',source:'aq-quests',paint:{'circle-radius':22,'circle-color':['case',['get','done'],'#698566','#bcf27a'],'circle-opacity':.12}});
 map.addLayer({id:'aq-quest-points',type:'circle',source:'aq-quests',paint:{'circle-radius':8,'circle-color':['case',['get','done'],'#6e9366',['get','locked'],'#77758a','#bcf27a'],'circle-stroke-width':2,'circle-stroke-color':'#172429'}});
 map.addSource('aq-orgs',{type:'geojson',data:collection([]),cluster:true,clusterMaxZoom:16,clusterRadius:75});
 map.addLayer({id:'aq-org-clusters',type:'circle',source:'aq-orgs',filter:['has','point_count'],paint:{'circle-radius':['step',['get','point_count'],11,10,14,50,17],'circle-color':'#776342','circle-opacity':.75}});
 map.addLayer({id:'aq-org-count',type:'symbol',source:'aq-orgs',filter:['has','point_count'],layout:{'text-field':['get','point_count_abbreviated'],'text-font':['Noto Sans Regular'],'text-size':11},paint:{'text-color':'#fff0d0'}});
 map.addLayer({id:'aq-org-points',type:'circle',source:'aq-orgs',filter:['!',['has','point_count']],paint:{'circle-radius':3.5,'circle-color':'#efc275','circle-stroke-width':1,'circle-stroke-color':'#352a17'}});
 map.moveLayer('aq-quest-glow');map.moveLayer('aq-quest-points');
 map.addSource('aq-team',{type:'geojson',data:collection([])});map.addLayer({id:'aq-team',type:'circle',source:'aq-team',paint:{'circle-radius':8,'circle-color':'#89b6ff','circle-stroke-width':3,'circle-stroke-color':'#172946'}});
 map.addSource('aq-territories',{type:'geojson',data:collection([])});
 map.addLayer({id:'aq-territory-fill',type:'fill',source:'aq-territories',paint:{'fill-color':['case',['get','contested'],'#efc275',['get','owned'],'#ad8cfa','#78b7dd'],'fill-opacity':.16}});
 map.addLayer({id:'aq-territory-line',type:'line',source:'aq-territories',paint:{'line-color':['case',['get','contested'],'#efc275',['get','owned'],'#ad8cfa','#78b7dd'],'line-width':2,'line-opacity':.75}});
 map.addSource('aq-adventures',{type:'geojson',data:collection([])});
 map.addLayer({id:'aq-adventure-points',type:'circle',source:'aq-adventures',paint:{'circle-radius':7,'circle-color':['case',['get','open'],'#c9a2ff','#78859b'],'circle-stroke-width':2,'circle-stroke-color':'#27203d'}});
 map.on('click','aq-adventure-points',e=>{if(!picking)selectAdventure(e.features[0].properties.id);});
 map.on('click','aq-territory-fill',e=>{if(!picking)selectTerritory(e.features[0].properties.id);});
 map.addSource('aq-self',{type:'geojson',data:collection([])});map.addLayer({id:'aq-self',type:'circle',source:'aq-self',paint:{'circle-radius':9,'circle-color':'#f4fbff','circle-stroke-width':4,'circle-stroke-color':'#4b8bf3'}});
 map.on('click','aq-quest-points',e=>{if(!picking)selectQuest(e.features[0].properties.id);});map.on('click','aq-org-points',e=>{if(!picking)selectOrganization(e.features[0].properties.id);});
 map.on('click',e=>{if(picking){const callback=picking;picking=null;map.getCanvas().style.cursor='';callback({lng:e.lngLat.lng,lat:e.lngLat.lat});}});
 map.on('click','aq-org-clusters',async e=>{try{const f=e.features[0],z=await currentMap.getSource('aq-orgs').getClusterExpansionZoom(f.properties.cluster_id);if(version!==lifecycle)return;currentMap.easeTo({center:f.geometry.coordinates,zoom:z});}catch{/* A cluster can disappear while the viewport changes. */}});
 for(const layer of ['aq-quest-points','aq-org-points','aq-org-clusters','aq-adventure-points','aq-territory-fill']){map.on('mouseenter',layer,()=>map.getCanvas().style.cursor='pointer');map.on('mouseleave',layer,()=>map.getCanvas().style.cursor='');}
 map.on('moveend',()=>{dirty.add('cells');scheduleUpdate();clearTimeout(orgTimer);orgTimer=setTimeout(()=>{if(version===lifecycle)viewport(currentMap.getBounds().toArray().flat());},180);});
 update();viewport(map.getBounds().toArray().flat());
 try{const url=await asset('/vendor/three.module.js',CDN+'three@0.179.1/build/three.module.js');const THREE=await import(url);if(version!==lifecycle)return;addThree(THREE);$('map-caption-text').textContent='3D-мир · Three.js + реальная карта';}catch(e){if(version!==lifecycle)return;console.warn('Three.js layer unavailable',e);$('map-caption-text').textContent='Карта доступна · 3D-объекты не загрузились';}
 });
 loadTimer=setTimeout(()=>{if(version===lifecycle&&!ready)notice('Карта загружается дольше обычного. Нужен интернет для картографических данных. Остальные разделы уже доступны.');},18000);
 }catch(e){if(version!==lifecycle)return;notice(e.message+'. Разделы квестов и кабинеты доступны через меню.');}
}
function addThree(THREE){
 const origin=lib.MercatorCoordinate.fromLngLat(city.center),scale=origin.meterInMercatorCoordinateUnits();
 const scene=new THREE.Scene(),camera=new THREE.Camera();scene.add(new THREE.AmbientLight(0xffffff,2));
 const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(30,-50,150);scene.add(sun);
 const group=new THREE.Group();scene.add(group);const geometry=new THREE.OctahedronGeometry(9,0),material=new THREE.MeshStandardMaterial({color:0xbcf27a,emissive:0x344e1d,roughness:.4,metalness:.25});
 const layer={id:'aq-three',type:'custom',renderingMode:'3d',onAdd(m,gl){this.renderer=new THREE.WebGLRenderer({canvas:m.getCanvas(),context:gl,antialias:true});this.renderer.autoClear=false;},render(gl,args){if(!threeVisible)return;const raw=args.defaultProjectionData?.mainMatrix||args;if(!raw||raw.length!==16)return;const projection=new THREE.Matrix4().fromArray(raw),transform=new THREE.Matrix4().makeTranslation(origin.x,origin.y,origin.z).scale(new THREE.Vector3(scale,-scale,scale));camera.projectionMatrix.copy(projection.multiply(transform));this.renderer.resetState();this.renderer.render(scene,camera);},onRemove(){geometry.dispose();material.dispose();this.renderer?.dispose();}};
 markersLayer={update(){group.clear();for(const q of quests.filter(q=>!q.completed&&!q.locked)){const c=lib.MercatorCoordinate.fromLngLat([q.lng,q.lat]);const mesh=new THREE.Mesh(geometry,material);mesh.position.set((c.x-origin.x)/scale,-(c.y-origin.y)/scale,25);group.add(mesh);}map.triggerRepaint();}};
 map.addLayer(layer);markersLayer.update();
}
function scheduleUpdate(){if(!updateFrame)updateFrame=requestAnimationFrame(()=>{updateFrame=null;update();});}
function update(){if(!ready||!map?.getSource('aq-quests'))return;
 if(dirty.has('quests'))map.getSource('aq-quests').setData(collection(quests.map(q=>feature([q.lng,q.lat],{id:q.id,done:!!q.completed,locked:!!q.locked}))));
 if(dirty.has('organizations'))map.getSource('aq-orgs').setData(collection(organizations.map(o=>feature([o.lng,o.lat],{id:o.id}))));
 if(dirty.has('cells')){const [[west,south],[east,north]]=city.bounds;
 const bounds=map.getBounds(),vx0=bounds.getWest(),vy0=bounds.getSouth(),vx1=bounds.getEast(),vy1=bounds.getNorth();
 const holes=cells.map(c=>{const [x,y]=c.split(':').map(Number),w=x*cellSize.lngCellSize,s=y*cellSize.latCellSize,e=w+cellSize.lngCellSize,n=s+cellSize.latCellSize;return w>=west&&e<=east&&s>=south&&n<=north&&e>=vx0&&w<=vx1&&n>=vy0&&s<=vy1?[[w,s],[w,n],[e,n],[e,s],[w,s]]:null;}).filter(Boolean);
 map.getSource('aq-fog').setData(collection([{type:'Feature',geometry:{type:'Polygon',coordinates:[[[west,south],[east,south],[east,north],[west,north],[west,south]],...holes]},properties:{}}]));
 map.setLayoutProperty('aq-fog','visibility',fog?'visible':'none');}
 if(dirty.has('team'))map.getSource('aq-team').setData(collection(team.filter(m=>m.location).map(m=>feature([m.location.lng,m.location.lat],{name:m.name}))));
 if(dirty.has('self'))map.getSource('aq-self').setData(collection(self?[feature([self.lng,self.lat],{})]:[]));
 if(dirty.has('adventures'))map.getSource('aq-adventures').setData(collection(adventures.flatMap(route=>(route.checkpoints||[]).map(point=>feature([point.lng,point.lat],{id:route.id,open:route.status==='open'})))));
 if(dirty.has('territories'))map.getSource('aq-territories').setData(collection(territories.filter(z=>z.status==='active').map(zone=>{const ring=[];for(let i=0;i<=48;i++){const angle=i/48*Math.PI*2;ring.push([zone.lng+Math.cos(angle)*zone.radius/(111320*Math.cos(zone.lat*Math.PI/180)),zone.lat+Math.sin(angle)*zone.radius/111320]);}return {type:'Feature',geometry:{type:'Polygon',coordinates:[ring]},properties:{id:zone.id,owned:!!zone.owner,contested:!!zone.contested}};})));
 if(dirty.has('quests'))markersLayer?.update();dirty.clear();
}
export function setMapData(data){for(const key of dataKeys)if(key in data)dirty.add(key);if(data.adventures)adventures=data.adventures;if(data.territories)territories=data.territories;if(data.quests)quests=data.quests;if(data.organizations)organizations=data.organizations;if(data.cells)cells=data.cells;if(data.team)team=data.team;if('self' in data)self=data.self;scheduleUpdate();}
export function flyTo(lng,lat){map?.flyTo({center:[lng,lat],zoom:16,pitch:threeVisible?52:0,essential:false});}
export function setFog(value){fog=value;dirty.add('cells');scheduleUpdate();}
export function toggle3D(value){threeVisible=value;map?.easeTo({pitch:value?52:0,bearing:value?-20:0});if(map?.getLayer('aq-buildings'))map.setLayoutProperty('aq-buildings','visibility',value?'visible':'none');map?.triggerRepaint();}
export function resizeMap(){setTimeout(()=>map?.resize(),30);}
export function pickPoint(callback){if(!ready)return false;picking=callback;map.getCanvas().style.cursor='crosshair';return true;}
