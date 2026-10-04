import {choice,fail,text} from './domain.mjs';

export const HIDDEN_QUEST_TITLE='Скрытая история';
export const QUEST_DIFFICULTIES=Object.freeze(['easy','moderate','hard']);
export const QUEST_METADATA_LIMITS=Object.freeze({steps:8,stepText:240,stepId:40,hint:500,reason:500,minutes:240});

function readSteps(row){
 try{const value=JSON.parse(row?.objective_steps_json??'[]');return Array.isArray(value)?value:[];}catch{return [];}
}
function steps(value){
 if(!Array.isArray(value)||value.length>QUEST_METADATA_LIMITS.steps)fail('Укажите не более 8 шагов задания');
 const ids=new Set();
 return value.map(step=>{
  if(!step||typeof step!=='object'||Array.isArray(step)||Object.keys(step).some(key=>!['id','text'].includes(key)))fail('Шаг задания должен содержать только id и text');
  if(typeof step.id!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(step.id)||ids.has(step.id))fail('Шагу нужен уникальный id: латинские буквы, цифры и дефис (до 40 символов)');
  ids.add(step.id);return {id:step.id,text:text(step.text,'Шаг задания',QUEST_METADATA_LIMITS.stepText,3)};
 });
}
// One shared write model for SQLite and PostgreSQL. Omitted fields preserve the
// current revision; explicit null clears nullable values. Difficulty is editorial
// effort/complexity, never inferred from XP, distance or a client's GPS report.
export function parseQuestMetadata(body,old){
 const value=(key,fallback)=>body[key]===undefined?(old?.[key]??fallback):body[key];
 const difficulty=value('difficulty',null);
 if(difficulty!==null)choice(difficulty,QUEST_DIFFICULTIES,'сложность квеста');
 const difficultyReason=text(value('difficulty_reason',''),'Обоснование сложности',QUEST_METADATA_LIMITS.reason,difficulty===null?0:10);
 if(difficulty===null&&difficultyReason)fail('Для обоснования сначала укажите сложность');
 const estimatedMinutes=value('estimated_minutes',null);
 if(estimatedMinutes!==null&&(!Number.isSafeInteger(estimatedMinutes)||estimatedMinutes<1||estimatedMinutes>QUEST_METADATA_LIMITS.minutes))fail('Время на месте: целое число от 1 до 240 минут');
 const objectiveSteps=steps(body.objective_steps===undefined?readSteps(old):body.objective_steps);
 const hint=text(value('hint',''),'Подсказка',QUEST_METADATA_LIMITS.hint,0);
 return {difficulty,difficulty_reason:difficultyReason,estimated_minutes:estimatedMinutes,objective_steps_json:JSON.stringify(objectiveSteps),hint};
}

// Raw storage and verification secrets never leave these shared read models.
// A locked personal card exposes no instructions or hints before exploration.
export function publicQuest(row,{hideObjectives=false}={}){
 const {code_hash,objective_steps_json,...rest}=row;
 return {...rest,difficulty:row.difficulty??null,difficulty_reason:hideObjectives?'':row.difficulty_reason??'',estimated_minutes:row.estimated_minutes??null,objective_steps:hideObjectives?[]:readSteps(row),hint:hideObjectives?'':row.hint??'',...(hideObjectives?{title:HIDDEN_QUEST_TITLE,description:''}:{})};
}
