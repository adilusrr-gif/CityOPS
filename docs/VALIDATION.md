# Проверка версии 0.8.0

24 сентября 2026, Linux x64, Node.js 24.19.0, Chromium Headless Shell / Playwright 1.51.1. Повторное ревью v0.7 и 15 исправленных дефектов: [ULTRACODE-REVIEW.md](ULTRACODE-REVIEW.md). Тестовые базы, реальные секреты, пользовательские данные и node_modules не включены в архив.

## Общий прогон

| Набор | Пройдено | Ошибки | Пропущено |
| --- | ---: | ---: | ---: |
| `npm test` — SQLite, HTTP, безопасность, provider fixtures, UI lifecycle, mobile transport и операции | 239 | 0 | 0 |
| `npm run test:enterprise` — PostgreSQL SQL, auth/OIDC/API, billing/photo/AI, pool, миграции и read-only gate | 141 | 0 | 3 |
| `node --test deploy/*.test.mjs` | 4 | 0 | 0 |
| **Всего** | **384** | **0** | **3** |

PostgreSQL-набор выполнен на PGlite/WASM с сериализацией транзакций. Три native-only пропуска: конкурирующие maintenance workers с SKIP LOCKED, append во время repeatable-read проверки аудита, admission при конкурентном обновлении rate counter. Эти сценарии требуют настоящего PostgreSQL в обязательном CI `PG_TEST_REQUIRED=true`. CI здесь не запускался. Управляемые барьеры в остальных новых тестах проверяют порядок прикладных действий, а не native contention или failover.

Первый основной прогон обнаружил нестабильную старую проверку KDF: под нагрузкой libuv callback мог законно опередить setImmediate. Тест заменён наблюдением реального SCRYPTREQUEST callback и microtask; синхронная подмена такую проверку не пройдёт. Production KDF не менялся. Приведённые 239 — результат повторного полного прогона после исправления теста.

Новые регрессии находятся в `tests/v8-*.test.mjs`, `tests/enterprise/v8-*.test.mjs` и общих `tests/helpers/v8-*.mjs`. Они проверяют отзыв сессий во время heartbeat, clock skew, личное назначение квестов, отзыв организации, ends_at=0, TTL координат, истечение retention во время AI, 237 рекламных карточек, типы photo cursor, ключи/MFA и поздние UI-операции. Точечные повторные прогоны агентов и прежние результаты не суммируются.

## Браузер и мобильная сборка

**7 проверок Chromium**, ошибок JavaScript нет: поздний MFA после logout, задержанный OSM-файл при смене города, закрытие фотоформы, истечение координат, страницы рекламы и retry, ширина 390 px, отсутствие необработанных ошибок. Использованы настоящий public UI/MapLibre/Three и детерминированные API fixtures. [v8-browser-results.json](v8-browser-results.json).

После окончательного freeze выполнены `CITYQUEST_API_ORIGIN=https://cityquest.example npm --prefix mobile run sync` и **6 проверок финального PWA/compiled-native bundle**: новая версия кеша и team-presence, отсутствие приватных API/медиа в кеше, offline shell, восстановление сети, Астана/питомец на 320 px, bearer login/logout с очисткой токена. [../mobile/validation-v8-pwa-bundle.json](../mobile/validation-v8-pwa-bundle.json).

Native bundle исполнялся в Chromium через симуляцию Capacitor platform и web plugins; реальный OS bridge не проверен. Версия 0.8.0, build 8. Сравнены байты 18 общих файлов в `mobile/www`, Android и iOS. API origin — пример, требуется пересборка со своим сервером. Подписанные APK/AAB/IPA не создавались, устройства, разрешения camera/GPS и системный SSO не испытаны.

Обновление установленного PWA активируется после закрытия прежних controlled окон. Проверки v0.7 service-worker upgrade сохранены как исторические, заново не засчитаны.

## Зависимости и упаковка

Production audit корневого и мобильного lockfile: **0 известных уязвимостей** на момент проверки. Это проверка базы advisories, не независимый аудит безопасности. Версии пакетов и lockfile согласованы; SQL-миграции и SQLite migration source сверены побайтно с v0.7. Схемы остаются SQLite 5 / PostgreSQL 6. [ARCHIVE-CHECKS.json](ARCHIVE-CHECKS.json).

Deployment image tags и имена Jobs обновлены до v0.8.0/v8. Четыре теста генератора секретов выполнены сейчас. Kustomize/kubeconform результаты v0.7 и более ранних выпусков в [DEPLOYMENT-VALIDATION.json](DEPLOYMENT-VALIDATION.json) являются историческими; новый runtime rollout не выполнялся.

## Что остаётся проверить вне этого окружения

Не подтверждены production TLS/DNS/IdP, контейнерный runtime, native PostgreSQL contention/replication, Kubernetes failover, WAL/S3/PITR restore, живой AI/эквайринг, целевая нагрузка и телефоны. Startup encryption sample не проверяет всю историю; полный read-only gate нужно запускать отдельно. Структурная проверка операторского JPEG-импорта не исключает все скрытые entropy-данные; подробности и допустимая доверенная граница приведены в отчёте ревью.

Каталог OSM не гарантирует полноту, GPS не доказывает присутствие, горный пример остаётся draft, фото-конкурс не исключает все виды накрутки. Медиа хранятся в ограниченном SQL-пилоте. Условия выпуска: [PRODUCT-LAUNCH.md](PRODUCT-LAUNCH.md).

История: [VALIDATION-V7.md](VALIDATION-V7.md), [VALIDATION-V6.md](VALIDATION-V6.md). GitHub административно заблокирован; push не выполнен.
