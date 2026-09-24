# Проверка версии 0.7.0

24 сентября 2026, Linux x64, Node.js 24.19.0, Chromium Headless Shell 134 / Playwright 1.51.1. Ревью и воспроизведение дефектов: [ULTRACODE-REVIEW.md](ULTRACODE-REVIEW.md). Тестовые аккаунты, рабочие базы, реальные секреты и node_modules не включены в архив.

## Полный прогон

| Набор | Пройдено | Ошибки | Пропущено |
| --- | ---: | ---: | ---: |
| `npm test` — SQLite, HTTP, игровые функции, безопасность, provider fixtures, mobile transport, операции | 214 | 0 | 0 |
| `npm run test:enterprise` — PostgreSQL SQL, auth/OIDC/API, billing/photo/AI, две HTTP-реплики, pool и миграции | 122 | 0 | 2 |
| `node --test deploy/*.test.mjs` | 4 | 0 | 0 |
| **Всего** | **340** | **0** | **2** |

Два native-only пропуска: конкурентный SKIP LOCKED и неблокирующий append во время проверки аудита. Локальный PGlite/WASM сериализует транзакции: это не подтверждение native concurrency/failover. Исправленный native fixture проверен на уровне реального pg.Client startup config; его изоляция на настоящем сервере должна пройти обязательный CI `PG_TEST_REQUIRED=true`. CI здесь не запускался.

Новые тесты находятся в `tests/u7-*.test.mjs`, `tests/enterprise/u7-*.test.mjs` и общем `tests/helpers/drain-suite.mjs`. Проверены malformed MFA с сохранением попыток; отказ до SQL для некорректных ID/кодов; снятие владельца; временная граница вступления в команду; работа handler после закрытия сокета; privacy epoch между AI-стадиями и закрытие reservation; отмена upstream; глобальные рекламные слоты и один SQL readmodel; достижимость истории 200+ заявок; JPEG-структура и FK backup/restore. Unicode uppercase-совместимость кода сохранена. Наборы пересекаются с точечными прогонами агентов и повторно не суммируются.

## Настоящий браузер и финальный bundle

**11 новых сценариев**, ошибок JavaScript нет: 4 проверки совместимости транспорта/поздних результатов/выхода; 3 сценария истории 237 заявок и навигации; 4 сценария service-worker upgrade. [v7-browser-results.json](v7-browser-results.json). Для гонок используется минимальный стиль карты и настоящий SQLite HTTP API; доступность реальных тайлов в этом прогоне не измерялась. Финальные controls истории повторно проверены после последней правки; ширина 320 px без горизонтального переполнения.

PWA gate использует настоящий archived v0.6 worker и текущий v0.7 с минимальной версионной HTTP-оболочкой. Уже установленный v0.6 worker не исправляется до активации нового: закройте все controlled окна/вкладки и запустите приложение снова. После активации v0.7 проверены согласованные HTML/модули при online/offline reload, waiting update и очистка прежних кешей при следующем запуске.

После окончательного freeze выполнены `CITYQUEST_API_ORIGIN=https://cityquest.example npm --prefix mobile run sync` и **6 проверок конечного PWA/Capacitor bundle**: кеш только оболочки, офлайн-ошибка, восстановление сети, переключение Астаны, регистрация/уход за питомцем с XP, приключения/территории/форма фото на 320 px. [../mobile/validation-v7-pwa-bundle.json](../mobile/validation-v7-pwa-bundle.json). Хеши общих файлов Android/iOS сверены при упаковке. 22 transport-теста входят в unit total.

Версия 0.7.0, native build 7. API origin в архиве — пример, обязательна пересборка со своим сервером. Подписанные APK/AAB/IPA не созданы; реальные устройства, camera/GPS, системный SSO и магазины не проверялись. Предыдущие 27 сценариев v0.6 сохранены как история и не засчитаны заново.

## Эксплуатация и зависимости

Стратегия base Kubernetes исправлена для трёх worker-узлов: maxSurge=0, maxUnavailable=1. Kustomize и strict kubeconform: **8 ресурсов base valid**, 0 errors. Это статическая проверка, не измеренный rollout. Остальные результаты 9 Kustomize-каталогов и 17 ресурсов из v0.6 сохранены как исторические. [DEPLOYMENT-VALIDATION.json](DEPLOYMENT-VALIDATION.json).

Production dependency audit по lockfile: **0 известных уязвимостей**, это не независимый аудит безопасности. Миграционные файлы не переписывались, схемы остаются SQLite 5 / PostgreSQL 6. Проверка архива исключает пользовательские БД/логи/ключи; исходники и native assets входят в ZIP.

Измерения парсера base64 и SQL round trips описаны в отчёте ревью; они не определяют production capacity. Исторические v0.6 нагрузки не пересчитывались и не подменяют текущую приёмку. HMAC startup остаётся линейным; count/sort общей истории оплаты и оконное ранжирование рекламы требуют измерений на целевом объёме.

## Незавершённая внешняя приёмка

Не развёрнуты и не подтверждены production TLS/DNS/IdP, контейнерный runtime, native PostgreSQL contention/replication, Kubernetes failover, восстановление WAL/S3/PITR, реальные AI/payment вызовы и нагрузка площадки. `release:check` проверяет конфигурацию и выбранную область, а не объявляет сервис production-ready.

Каталог OSM не гарантирует полноту, GPS не доказывает присутствие, горный пример остаётся draft, фото-конкурс не гарантирует отсутствие накрутки. Медиа хранятся в ограниченном SQL-пилоте. Подробности выхода: [PRODUCT-LAUNCH.md](PRODUCT-LAUNCH.md).

История: [VALIDATION-V6.md](VALIDATION-V6.md), [VALIDATION-V5.md](VALIDATION-V5.md). Доступ к GitHub административно заблокирован, push не выполнен.
