import {mkdir,writeFile} from 'node:fs/promises';
const files=[
 ['maplibre-gl.js','maplibre-gl@5.6.1/dist/maplibre-gl.js'],
 ['maplibre-gl.css','maplibre-gl@5.6.1/dist/maplibre-gl.css'],
 ['maplibre-LICENSE.txt','maplibre-gl@5.6.1/LICENSE.txt'],
 ['three.module.js','three@0.179.1/build/three.module.js'],
 ['three.core.js','three@0.179.1/build/three.core.js'],
 ['three-LICENSE.txt','three@0.179.1/LICENSE']
];
await mkdir('public/vendor',{recursive:true});
for(const [file,path] of files){try{const r=await fetch('https://cdn.jsdelivr.net/npm/'+path,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);await writeFile('public/vendor/'+file,Buffer.from(await r.arrayBuffer()));console.log('Saved '+file);}catch(e){console.error(file+': '+e.message);process.exitCode=1;break;}}
if(!process.exitCode)console.log('Библиотеки сохранены локально. Для карты всё ещё нужен доступ к серверу тайлов.');
