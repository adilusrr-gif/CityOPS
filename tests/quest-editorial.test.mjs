import test from 'node:test';
import assert from 'node:assert/strict';
import {places,astanaPlaces,seed} from '../src/seed.mjs';
import {QUEST_GUIDANCE,QUEST_DIFFICULTY_RUBRIC} from '../src/quest-editorial.mjs';
import {parseQuestMetadata} from '../src/quest-metadata.mjs';
import {ADVENTURE_SEEDS} from '../src/features/adventure-seed.mjs';
import {openDb} from '../src/db.mjs';

test('all 24 editorial stops have validated varied activities and an explicit complexity rationale',()=>{
 const keys=[...places,...astanaPlaces].map(p=>p[0]);
 assert.equal(keys.length,24);assert.deepEqual(Object.keys(QUEST_GUIDANCE).sort(),keys.sort());
 const texts=new Set();
 for(const key of keys){
  const value=QUEST_GUIDANCE[key],parsed=parseQuestMetadata(value);
  assert.ok(QUEST_DIFFICULTY_RUBRIC[value.difficulty]);
  assert.ok(parsed.difficulty_reason.length>10);assert.ok(value.hint.length>10);
  assert.equal(value.objective_steps.length,value.difficulty==='hard'?5:value.difficulty==='moderate'?3:2);
  assert.ok(value.estimated_minutes>=5&&value.estimated_minutes<=30);
  for(const step of value.objective_steps){assert.ok(!texts.has(step.text),'editorial activities must not repeat identical chores');texts.add(step.text);}
 }
 // The creative exercises are hard because they synthesize observations, not
 // because a location is dangerous or a GPS/reward requirement became stricter.
 for(const value of Object.values(QUEST_GUIDANCE).filter(x=>x.difficulty==='hard'))assert.match(value.difficulty_reason,/не в физическом риске/);
});

test('fresh seed adds guidance without changing stable quest IDs or historical reward amounts',()=>{
 const db=openDb(':memory:',{withSnapshot:false});
 try{
  for(const list of [places,astanaPlaces])for(const [i,[key]] of list.entries()){
   const row=db.prepare('SELECT * FROM quests WHERE id=?').get(`quest-${key}`);
   assert.equal(row.xp,100+i*10);assert.equal(row.difficulty,QUEST_GUIDANCE[key].difficulty);
   assert.deepEqual(JSON.parse(row.objective_steps_json),QUEST_GUIDANCE[key].objective_steps);
  }
  const id='quest-panfilov',at=Date.now();
  db.prepare("INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES('editorial-player','editorial@example.test','Игрок','unused','player',100,?)").run(at);
  db.prepare("INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES('editorial-player',?,100,?)").run(id,at);
  db.prepare("UPDATE quests SET title='Изменено оператором',difficulty='easy',difficulty_reason='Собственная редакционная оценка',hint='Сохранённая подсказка',version=9 WHERE id=?").run(id);
  seed(db);
  const row=db.prepare('SELECT * FROM quests WHERE id=?').get(id);
  assert.equal(row.title,'Изменено оператором');assert.equal(row.hint,'Сохранённая подсказка');assert.equal(row.version,9);
  assert.equal(db.prepare('SELECT count(*) n FROM quests').get().n,24);
  assert.equal(db.prepare("SELECT xp FROM completions WHERE user_id='editorial-player'").get().xp,100);
  assert.equal(db.prepare("SELECT xp FROM users WHERE id='editorial-player'").get().xp,100);
 }finally{db.close();}
});

test('unverified editorial adventure routes are drafts, not field-approved playable routes',()=>{
 assert.equal(ADVENTURE_SEEDS.length,3);
 for(const route of ADVENTURE_SEEDS){assert.equal(route.status,'draft');assert.match(route.statusReason,/проверк|провер/);}
});

test('museum editorial name follows the current institution while preserving its source identity',()=>{
 const museum=places.find(p=>p[0]==='museum');
 assert.equal(museum[1],'Национальный центральный музей Республики Казахстан');
 assert.equal(museum[5],'https://www.openstreetmap.org/way/444574821');
});
