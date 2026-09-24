import {CITIES} from './cities.mjs';

// Editorial starting points. Almaty includes approximate approaches; Astana
// coordinates are source node/centres from the bundled snapshot. See docs/DATA.md.
export const places = [
  ['panfilov','Парк 28 гвардейцев-панфиловцев','park',76.9538,43.2580,'https://www.openstreetmap.org/way/208493040'],
  ['cathedral','Вознесенский собор','landmark',76.9531145,43.2587859,'https://www.openstreetmap.org/way/50648292'],
  ['green-bazaar','Зелёный базар','market',76.9548857,43.2636658,'https://www.openstreetmap.org/relation/20040804'],
  ['arbat','Арбат · улица Жибек Жолы','landmark',76.9431,43.2614,'https://visitalmaty.kz/'],
  ['opera','Театр оперы и балета имени Абая','culture',76.9458545,43.2486619,'https://www.openstreetmap.org/relation/6609239'],
  ['republic','Площадь Республики','landmark',76.9457,43.2383,'https://visitalmaty.kz/'],
  ['museum','Центральный государственный музей','culture',76.9507469,43.2358799,'https://www.openstreetmap.org/way/444574821'],
  ['palace','Площадь перед Дворцом Республики','culture',76.9587,43.2426,'https://www.openstreetmap.org/way/53280121'],
  ['president-park','Парк Первого Президента · колоннада','park',76.8869809,43.1938175,'https://www.openstreetmap.org/way/292274862'],
  ['botanical','Главный ботанический сад · вход','park',76.9137,43.2257,'https://www.openstreetmap.org/relation/3048271'],
  ['central-park','Центральный парк · главный вход','park',76.9684,43.2620,'https://www.openstreetmap.org/way/232715414'],
  ['art-museum','Музей искусств имени Кастеева','culture',76.9193365,43.2356381,'https://www.openstreetmap.org/relation/418680']
];
const stories = [
  ['Зелёное сердце города','Найди вход в парк и выбери деталь, которая делает это место узнаваемым. Пройди к общедоступной точке у входа.'],
  ['Деревянная легенда','Рассмотри собор снаружи. Найди три разных цвета на фасаде. Вход в здание для задания не нужен.'],
  ['Голоса базара','Доберись до внешнего входа рынка. Заметь, на каких языках написаны вывески. Ничего покупать не нужно.'],
  ['Ритм Арбата','Прогуляйся по пешеходному участку Жибек Жолы и найди интересную витрину или уличную работу.'],
  ['Театр снаружи','На общедоступной площади перед театром рассмотри фасад. Найди повторяющийся архитектурный элемент.'],
  ['Точка встречи','Найди открытый пешеходный участок на площади Республики. Остановись и осмотрись, прежде чем подтверждать прибытие.'],
  ['История рядом','Дойди до общедоступного тротуара у музея. Найди название на фасаде или указателе. Билет не требуется.'],
  ['Городская сцена','Найди Дворец Республики и рассмотри его крышу с площади. Задание выполняется снаружи.'],
  ['Южная прогулка','Дойди до главного входа в парк и найди указатель. Учитывай часы доступа; не заходи через закрытые ворота.'],
  ['У ворот сада','Найди официальный вход в ботанический сад и информационный стенд. Проход на платную территорию не требуется.'],
  ['Парк воспоминаний','Подойди к главному входу Центрального парка. Отметь одну деталь, которую захочешь вспомнить.'],
  ['Искусство начинается с улицы','Найди вывеску музея Кастеева с общедоступной дорожки. Экспозицию посещать необязательно.']
];
// [key, editorial name, category, longitude, latitude, source URL].
// Astana coordinates match datasets/astana-osm.json exactly; they are not verified entrances.
export const astanaPlaces = [
 ['astana-opera','Астана Опера','culture',71.410753,51.1354512,'https://www.openstreetmap.org/way/917478479'],
 ['astana-national-museum','Национальный музей Республики Казахстан','culture',71.4693823,51.1182297,'https://www.openstreetmap.org/node/4894937300'],
 ['astana-pyramid','Дворец мира и согласия','culture',71.4634559,51.123123,'https://www.openstreetmap.org/way/166197368'],
 ['astana-khan-shatyr','Хан Шатыр','landmark',71.4038726,51.1325089,'https://www.openstreetmap.org/way/460703779'],
 ['astana-library','Национальная академическая библиотека Республики Казахстан','culture',71.4271515,51.1272145,'https://www.openstreetmap.org/way/230358855'],
 ['astana-ballet','Астана балет','culture',71.4196527,51.0992346,'https://www.openstreetmap.org/way/499328449'],
 ['astana-atyrau','Мост Атырау','landmark',71.4249916,51.1560749,'https://www.openstreetmap.org/way/1239177393'],
 ['astana-seifullin','Музей Сакена Сейфуллина','culture',71.4235922,51.1714825,'https://www.openstreetmap.org/way/240376692'],
 ['astana-zhetigenshi','Жетігенші','landmark',71.4106104,51.1346692,'https://www.openstreetmap.org/node/13340040665'],
 ['astana-zher-ana','Жер-ана (Томирис)','landmark',71.4317199,51.1533831,'https://www.openstreetmap.org/node/4109068593'],
 ['astana-horses','Табун Лошадей','landmark',71.4146358,51.1318367,'https://www.openstreetmap.org/node/14087643081'],
 ['astana-ataturk','Парк Ататюрка','park',71.4318117,51.152019,'https://www.openstreetmap.org/way/1460702136']
];
const astanaStories = [
 ['Увертюра города','С общедоступной площади у «Астана Опера» найди повторяющиеся колонны на фасаде. Билет и вход в театр не нужны.'],
 ['История на фасаде','Найди название Национального музея на указателе или фасаде с доступного тротуара. Посещение экспозиции не требуется.'],
 ['Пирамида мира','Рассмотри Дворец мира и согласия с открытой пешеходной дорожки. Найди треугольные элементы; внутрь заходить не нужно.'],
 ['Силуэт шатра','С общедоступного тротуара рассмотри силуэт «Хан Шатыр» и найди его верхнюю точку. Не пересекай парковку вне переходов; покупки не требуются.'],
 ['Дом городских историй','У Национальной академической библиотеки найди название на наружной вывеске. Остановись в месте, где не мешаешь проходу; вход не требуется.'],
 ['Балет без билета','Рассмотри фасад театра «Астана балет» с общедоступной территории. Выбери одну повторяющуюся форму; посещение спектакля не нужно.'],
 ['Узор над рекой','Рассмотри узор моста Атырау с открытой набережной. Заходить на мост для задания необязательно; не спускайся к воде и не выходи на лёд.'],
 ['Литературная остановка','Найди наружную вывеску музея Сакена Сейфуллина с общедоступного тротуара. Узнай имя писателя по вывеске; билет не нужен.'],
 ['Музыка в камне','Найди скульптуру «Жетігенші» на общедоступной площади у оперы и рассмотри музыкальный инструмент. Не трогай и не залезай на скульптуру.'],
 ['Образ Жер-ана','Рассмотри скульптуру «Жер-ана (Томирис)» с доступной дорожки. Найди одну деталь силуэта; не заходи за ограждения и не поднимайся на постамент.'],
 ['Движение в бронзе','Найди композицию «Табун Лошадей» с общедоступной дорожки. Заметь, как автор передал движение; не заходи на клумбы и не трогай композицию.'],
 ['Пауза в парке','На открытой дорожке парка Ататюрка найди место для короткой остановки и отметь три детали вокруг. Если проход закрыт, отложи задание.']
];

function seedCity(db,cityId,cityPlaces,cityStories,metaKey,radius) {
 if(db.prepare('SELECT value FROM meta WHERE key=?').get(metaKey))return;
 const now=Date.now();db.exec('BEGIN');
 try {
  for(let i=0;i<cityPlaces.length;i++){
   const [key,name,category,lng,lat,source]=cityPlaces[i];
   const osmId=source.match(/openstreetmap\.org\/(node\/\d+|way\/\d+|relation\/\d+)$/)?.[1]||null;
   // Importing a city before its editorial seed must not create duplicate OSM cards.
   const existing=osmId?db.prepare('SELECT id FROM organizations WHERE osm_id=?').get(osmId):null;
   const organizationId=existing?.id||`seed-${key}`;
   if(!existing)db.prepare('INSERT INTO organizations(id,name,category,lng,lat,address,description,status,source,osm_id,created_at,city_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(organizationId,name,category,lng,lat,`${CITIES[cityId].name} · уточните вход на месте`,'Городская достопримечательность. Партнёрство с проектом не заявлено. Точка из карты не гарантирует доступный вход.','approved',source,osmId,now,cityId);
   const safety=cityId==='astana'?' Выполняй днём с открытой пешеходной территории. Учитывай погоду, ветер и гололёд; при закрытом доступе отложи задание.':' Выполняй днём, только с доступной пешеходной территории.';
   db.prepare('INSERT INTO quests(id,title,description,lng,lat,radius,xp,scope,verification,organization_id,status,goal,created_at,city_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(`quest-${key}`,cityStories[i][0],cityStories[i][1]+safety,lng,lat,radius,100+i*10,i%3===0?'personal':'public','checkin',organizationId,'published',20,now,cityId);
  }
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(metaKey,'1');
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}

export function seed(db) {
 // Keep the original marker and IDs: upgrading a v1 database preserves player progress.
 seedCity(db,'almaty',places,stories,'seed_version',180);
 seedCity(db,'astana',astanaPlaces,astanaStories,'seed_astana_v1',250);
}
