import {performance} from 'node:perf_hooks';
import {readFileSync} from 'node:fs';
import {openDb} from '../src/db.mjs';

// Repeatable local microbenchmark against bundled real city catalogs. All data
// and index changes are confined to this process's in-memory SQLite database.
// This is not an HTTP throughput, native PostgreSQL, replica or HA benchmark.
const db=openDb(':memory:');
try{
 const ddl=readFileSync(new URL('../src/enterprise/sql/006-query-indexes.sql',import.meta.url),'utf8');
 const indexes=[...ddl.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map(match=>match[1]);
 const now=Date.now();db.prepare("INSERT INTO users(id,email,name,password,role,created_at) VALUES('benchmark','benchmark@example.test','Benchmark','no-login','player',?)").run(now);
 const insert=db.prepare("INSERT INTO explored(user_id,city_id,cell,created_at) VALUES('benchmark','almaty',?,?)");db.exec('BEGIN');for(let n=0;n<20000;n++)insert.run(`${38000+n%250}:${28700+Math.floor(n/250)}`,now);db.exec('COMMIT');
 const cursor=db.prepare("SELECT name,id FROM organizations WHERE city_id='almaty' AND status='approved' ORDER BY name,id LIMIT 1 OFFSET 8000").get();
 const cases=[
  {name:'catalog_first_500',sql:"SELECT id,name,address,lng,lat FROM organizations WHERE city_id=? AND status=? ORDER BY name,id LIMIT 500",params:['almaty','approved']},
  {name:'catalog_after_8000',sql:"SELECT id,name,address,lng,lat FROM organizations WHERE city_id=? AND status=? AND (name,id)>(?,?) ORDER BY name,id LIMIT 100",params:['almaty','approved',cursor.name,cursor.id]},
  {name:'admin_first_50',sql:'SELECT id,name,status FROM organizations WHERE city_id=? ORDER BY created_at DESC,id DESC LIMIT 50',params:['almaty']},
  {name:'exploration_after_15000',sql:'SELECT cell FROM explored WHERE user_id=? AND city_id=? AND cell>? ORDER BY cell LIMIT 500',params:['benchmark','almaty','38187:28740']},
 ];
 const measure=()=>Object.fromEntries(cases.map(item=>{const stmt=db.prepare(item.sql);for(let n=0;n<5;n++)stmt.all(...item.params);const samples=[];for(let n=0;n<50;n++){const start=performance.now();stmt.all(...item.params);samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);return[item.name,{median_ms:Number(samples[25].toFixed(4)),p95_ms:Number(samples[47].toFixed(4)),plan:db.prepare('EXPLAIN QUERY PLAN '+item.sql).all(...item.params).map(row=>row.detail)}];}));
 for(const index of indexes)db.exec('DROP INDEX '+index);
 const before=measure();db.exec(ddl);const after=measure();
 const oldCells=db.prepare("SELECT cell FROM explored WHERE user_id='benchmark' AND city_id='almaty'").all().map(row=>row.cell),newCells=oldCells.slice(0,500);
 console.log(JSON.stringify({generated_at:new Date().toISOString(),node:process.version,engine:'node:sqlite in-memory',limitations:'Local warm-cache query microbenchmark only; excludes HTTP/auth/network, disk, native PostgreSQL, concurrency and HA. Times vary with the host.',organizations:db.prepare('SELECT city_id,count(*) AS count FROM organizations GROUP BY city_id ORDER BY city_id').all(),explored_fixture:oldCells.length,iterations:50,before_indexes:before,after_indexes:after,response_cells_bytes:{previous_unbounded:Buffer.byteLength(JSON.stringify({cells:oldCells})),bounded_first_page:Buffer.byteLength(JSON.stringify({cells:newCells,total:oldCells.length,next_cursor:'available'}))}},null,2));
}finally{db.close();}
