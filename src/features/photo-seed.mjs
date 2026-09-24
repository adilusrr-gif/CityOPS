import {run} from './store.mjs';

export function* seedPhotoContests(time = Date.now()) {
  const start = Math.floor(time / 86400000 + 1) * 86400000;
  for (const [cityId, name] of [['almaty', 'Алматы'], ['astana', 'Астана']]) {
    yield run('INSERT INTO photo_contests(id,city_id,title,description,status,starts_at,submissions_close_at,votes_close_at,version,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,NULL,$9,$9) ON CONFLICT(id) DO NOTHING', [`photo-${cityId}-first`, cityId, `${name}: красота новых мест`, 'Фотоконкурс пейзажей и городских мест. Только собственные фотографии; оцениваем места, а не внешность людей. Перед запуском организатор проверяет сроки и публикует конкурс.', 'draft', start, start + 7 * 86400000, start + 14 * 86400000, time]);
  }
}
