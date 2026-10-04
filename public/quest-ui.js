// Shared by the web UI and the Android/iOS bundle. No location, account or
// reward state lives here; rendering an activity never confirms completion.
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const DIFFICULTIES=Object.freeze({
 easy:Object.freeze({label:'Лёгкий',symbol:'●',color:'#80dcab'}),
 moderate:Object.freeze({label:'Средний',symbol:'▲',color:'#ffba76'}),
 hard:Object.freeze({label:'Сложный',symbol:'◆',color:'#ccb0ff'})
});
const unknown=Object.freeze({label:'Сложность не оценена',symbol:'?',color:'#b0bbc9'});
export function difficultyInfo(value){return Object.hasOwn(DIFFICULTIES,value)?DIFFICULTIES[value]:unknown;}
export function difficultyBadge(value){const info=difficultyInfo(value);return `<span class="difficulty-badge difficulty-${Object.hasOwn(DIFFICULTIES,value)?value:'unknown'}"><span aria-hidden="true">${info.symbol}</span> ${info.label}</span>`;}
export function questPlanning(quest){const minutes=quest.estimated_minutes;return `<div class="quest-planning">${difficultyBadge(quest.difficulty)}<span>${Number.isSafeInteger(minutes)&&minutes>0?`≈ ${minutes} мин на месте`:'Время на месте не оценено'}</span></div>`;}
export function questControls({search='',scope='all',difficulty='all'},prefix='quest'){
 return `<div class="search-wrap"><label class="sr-only" for="${prefix}-search">Поиск квеста</label><input id="${prefix}-search" data-quest-search placeholder="Найти приключение…" type="search" maxlength="100" value="${escapeHtml(search)}"></div><fieldset class="filters quest-filter-group"><legend>Кому доступен</legend>${[['all','Все'],['public','Общие'],['personal','Личные']].map(([id,title])=>`<button type="button" class="chip ${scope===id?'selected':''}" data-filter="${id}" aria-pressed="${scope===id}">${title}</button>`).join('')}</fieldset><fieldset class="filters quest-filter-group"><legend>Сложность занятия на месте</legend><button type="button" class="chip ${difficulty==='all'?'selected':''}" data-difficulty="all" aria-pressed="${difficulty==='all'}">Любая</button>${Object.entries(DIFFICULTIES).map(([id,info])=>`<button type="button" class="chip difficulty-${id} ${difficulty===id?'selected':''}" data-difficulty="${id}" aria-pressed="${difficulty===id}"><span aria-hidden="true">${info.symbol}</span> ${info.label}</button>`).join('')}</fieldset>`;
}
export function questObjectives(quest,{secret=false,checked=new Set()}={}){
 if(secret)return '';
 const steps=Array.isArray(quest.objective_steps)?quest.objective_steps:[];
 const count=steps.filter(step=>checked.has(step.id)).length;
 return `<section class="quest-activity" aria-label="Занятие на месте"><h3>Твой план на месте</h3>${quest.difficulty_reason?`<p class="help">${escapeHtml(quest.difficulty_reason)}</p>`:''}<p class="help">Сложность относится к занятию, а не к дороге или проверке GPS. Время указано без пути до места.</p>${steps.length?`<p class="help" id="objective-note">Необязательный список для себя. Отметки хранятся только до смены города или аккаунта либо закрытия приложения. Они не проверяются, не подтверждают прибытие и не дают дополнительный XP.</p><ol class="objective-list">${steps.map(step=>`<li><label><input type="checkbox" data-objective="${escapeHtml(step.id)}" data-objective-quest="${escapeHtml(quest.id)}" aria-describedby="objective-note" ${checked.has(step.id)?'checked':''}><span>${escapeHtml(step.text)}</span></label></li>`).join('')}</ol><p class="help" id="objective-progress" role="status" aria-live="polite">Отмечено для себя: ${count} из ${steps.length}</p>`:'<p class="help">Для этого квеста пока нет дополнительных шагов. Подтверждение прибытия доступно отдельно.</p>'}${quest.hint?`<details class="quest-hint"><summary>Показать подсказку</summary><p>${escapeHtml(quest.hint)}</p></details>`:''}</section>`;
}
export function nextCheckpoint(route){
 const points=Array.isArray(route.checkpoints)?route.checkpoints:[];
 const raw=route.progress?.visited??0;
 // The server records checkpoints sequentially. An invalid/complete progress
 // value must not send a player back to a claimed or nonexistent checkpoint.
 if(route.progress?.completed||!Number.isSafeInteger(raw)||raw<0||raw>=points.length)return null;
 return {point:points[raw],index:raw,total:points.length};
}
export function isRoutePlayable(route){return route?.status==='open'&&route.playable===true;}
export function routeGuidance(route){
 if(!isRoutePlayable(route))return '<p class="route-next help">Прохождение недоступно. Дождись открытия оператором и проверь условия.</p>';
 const next=nextCheckpoint(route);
 if(!next)return `<p class="route-next help">${route.progress?.completed?'Все точки пройдены.':'Нет доступной следующей точки. Обнови данные.'}</p>`;
 return `<p class="route-next"><span class="help">Следующая отметка · ${next.index+1} из ${next.total}</span><strong>${escapeHtml(next.point.title)}</strong></p>`;
}
export function questMapProperties(quest){const info=difficultyInfo(quest.difficulty);return {id:quest.id,done:!!quest.completed,locked:!!quest.locked,color:quest.locked?'#b0bbc9':info.color,symbol:quest.locked?'?':quest.completed?'✓':info.symbol};}
