# Обновление квестов · 4 октября 2026

Новая итерация после `4c06ae7a64efed8b3fa8a32f7472109cef8bfa95`:

- Основной suite: **285/285**.
- Native PostgreSQL 17.11 C.UTF-8: **167/167**, без пропусков.
- Deployment: **6/6**.
- Всего Node summaries: **458/458**; JUnit leaf cases: **442**. Представления не суммируются.
- Общая mobile-сборка + Android/iOS sync прошли; 18/18 asset hashes совпадают.
- 59 focused UI/mobile tests входят в основной suite, включая контраст ≥4.5:1 и гонки фильтра/пагинации.
- Оба production npm audit: 0 advisories. Demo origin намеренно отклоняется release gate.

Проверены метаданные квестов, миграции SQLite 6 / PostgreSQL 7, скрытые личные задания и поиск, фильтры с курсорами, безопасное раскрытие в радиусе прибытия, запрет непроверенных маршрутов, различение соседних GPS-точек и повтор без повторной награды. Редакционные задания/длительность не считаются полевой проверкой места или измеренной увлекательностью. [Протокол дружеского пилота](QUEST-PILOT.md).

Свежий CI этой итерации нужно сверять с точным SHA [отдельной ветки](https://github.com/adilusrr-gif/CityOPS/tree/release/cityquest-mobile-readiness-2026-10-04), а не с прогонами ниже. Финальная поставка содержит точный commit и CI в DELIVERY-MANIFEST.json. Main и production не менялись.

Новая визуальная browser QA и реальные Android/iOS устройства не проверены; предыдущие ограничения среды сохраняются. Для публичного production остаются целевые инфраструктурные, восстановительные, нагрузочные и пользовательские проверки.

---

## Предыдущий цикл: сервер и mobile foundation

# Проверка кандидата · 4 октября 2026

Baseline GitHub: `ba98a78aa0a4dd6d8eef62d294e8a9b1254ddacf` в `adilusrr-gif/CityOPS`.
Node.js 24.19.0, Debian Linux x64. Проверки используют только изолированные синтетические данные.

| Проверка | Выполнено | Результат |
| --- | ---: | --- |
| Основной `npm test` | 253 / 253 | PASS |
| Native PostgreSQL 17.11, `PG_TEST_REQUIRED=true`, C.UTF-8 | 155 / 155 | PASS, без пропусков |
| `node --test deploy/*.test.mjs` | 6 / 6 | PASS |
| Mobile-focused subset | 30 / 30 | PASS; входит в основные 253, не суммировать |
| Общие mobile assets www / Android / iOS | 18 / 18 | SHA-256 совпадает |
| Android+iOS `cap sync` | 2 / 2 платформы | PASS; не нативная компиляция |
| Production npm audit, root + mobile lockfile | 2 / 2 | 0 известных advisories на момент проверки |
| Caddy 2.10.2 конфигурация | 1 / 1 | PASS |
| Caddy + две API-копии + native PostgreSQL | 1 / 1 сценарий | После остановки одной API-копии оставшаяся обслужила 4 / 4 запроса |

Всего Node test summaries: 414 passed, 0 failed, 0 skipped. Эти summaries включают родительские subtest-контейнеры; JUnit содержит 400 leaf test cases. Это разные представления одного прогона, их нельзя суммировать.

Новый код исправляет окно чтения административного журнала после отзыва доступа, ложное отклонение настоящих SSO-идентичностей и добавляет fail-closed проверку локали PostgreSQL. Для мобильного клиента улучшены GPS-ошибки и повторный запуск, дубликаты SSO callback, background/resume, offline/reconnect, сохранение открытых форм и навигация на узком экране. Повтор подключения не переотправляет изменения или награды.

Проверка мобильного release намеренно отклоняет текущий `https://cityquest.example`. Этот origin демонстрационный, не работающий backend. Для реального выпуска нужно заново выполнить `CITYQUEST_API_ORIGIN=https://<ваш-api> npm --prefix mobile run release:prepare`. Положительные и отрицательные проверки release gate покрыты синтетическими файлами; доступность реального API отдельно не проверялась.

## Ограничения

- GitHub CI кода `34e9392ed85578bdc638c21de8e0ea58e5db249d` полностью прошёл: https://github.com/adilusrr-gif/CityOPS/actions/runs/37187065897. Воспроизведённый отказ старого образа: `exec /usr/bin/caddy: operation not permitted`. Официальный образ задаёт бинарнику CAP_NET_BIND_SERVICE, несовместимую с данным запуском с `cap_drop: ALL`. Производный pinned image снимает ненужную для порта 8080 file capability. CI проверил UID 1000, нулевой CapBnd и NoNewPrivs=1, HTTP readiness и обслуживание после остановки одной API-копии. Старый failed run сохранён как историческое свидетельство: https://github.com/adilusrr-gif/CityOPS/actions/runs/35998193012.
- Native PostgreSQL запущен из официального Debian-пакета 17.11 с проверенным SHA-256; runtime распакован во временную папку, без изменения системной службы. Исходный fixture с локалью C обнаружил проблему кириллического поиска; C.UTF-8 проходит. Производственная база не изменялась.
- Дополнительно к локальному Caddy smoke пройден Docker Compose networking и отказ одного API-процесса в CI. Kubernetes failover, репликация БД и PITR не проверены.
- Новая визуальная browser QA заблокирована окружением: запуск CLI Chromium отклонён ограничением socket, облачный браузер отклонил localhost. Существующие UI-тесты выполнялись с детерминированными fixtures; это не проверка реальной отрисовки или телефонов.
- Java runtime 21 есть, но javac, Android SDK/adb/sdkmanager и Xcode отсутствуют. APK/AAB/IPA, подпись, GPS/camera OS bridge, native SSO/deep-link доставка и store review не выполнены.
- Независимая проверка безопасности частичная. Отсутствие критической находки не доказывает отсутствие уязвимостей; npm audit не покрывает весь продукт или отдельно vendored JS.
- Production DNS/TLS, реальные origin/ключи, IdP, резервное копирование/восстановление, RPO/RTO, нагрузка и операторские privacy/terms требуют приёмки на целевой площадке.

Вердикт публичного запуска: **NO-GO до закрытия этих release gates**. Production не запускался.
