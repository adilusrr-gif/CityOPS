# Проверка кандидата · 4 октября 2026

Baseline GitHub: `ba98a78aa0a4dd6d8eef62d294e8a9b1254ddacf` в `adilusrr-gif/CityOPS`.
Node.js 24.19.0, Debian Linux x64. Проверки используют только изолированные синтетические данные.

| Проверка | Выполнено | Результат |
| --- | ---: | --- |
| Основной `npm test` | 253 / 253 | PASS |
| Native PostgreSQL 17.11, `PG_TEST_REQUIRED=true`, C.UTF-8 | 155 / 155 | PASS, без пропусков |
| `node --test deploy/*.test.mjs` | 5 / 5 | PASS |
| Mobile-focused subset | 30 / 30 | PASS; входит в основные 253, не суммировать |
| Общие mobile assets www / Android / iOS | 18 / 18 | SHA-256 совпадает |
| Android+iOS `cap sync` | 2 / 2 платформы | PASS; не нативная компиляция |
| Production npm audit, root + mobile lockfile | 2 / 2 | 0 известных advisories на момент проверки |
| Caddy 2.10.2 конфигурация | 1 / 1 | PASS |
| Caddy + две API-копии + native PostgreSQL | 1 / 1 сценарий | После остановки одной API-копии оставшаяся обслужила 4 / 4 запроса |

Всего Node test summaries: 413 passed, 0 failed, 0 skipped. Эти summaries включают родительские subtest-контейнеры; JUnit содержит 399 leaf test cases. Это разные представления одного прогона, их нельзя суммировать.

Новый код исправляет окно чтения административного журнала после отзыва доступа, ложное отклонение настоящих SSO-идентичностей и добавляет fail-closed проверку локали PostgreSQL. Для мобильного клиента улучшены GPS-ошибки и повторный запуск, дубликаты SSO callback, background/resume, offline/reconnect, сохранение открытых форм и навигация на узком экране. Повтор подключения не переотправляет изменения или награды.

Проверка мобильного release намеренно отклоняет текущий `https://cityquest.example`. Этот origin демонстрационный, не работающий backend. Для реального выпуска нужно заново выполнить `CITYQUEST_API_ORIGIN=https://<ваш-api> npm --prefix mobile run release:prepare`. Положительные и отрицательные проверки release gate покрыты синтетическими файлами; доступность реального API отдельно не проверялась.

## Ограничения

- Опубликованный GitHub CI на baseline падает на Compose smoke: https://github.com/adilusrr-gif/CityOPS/actions/runs/35998193012. Добавлены HTTP healthcheck прокси и его диагностические логи. Нужен новый успешный CI на точном commit. Корневая причина старого контейнерного отказа не установлена.
- Native PostgreSQL запущен из официального Debian-пакета 17.11 с проверенным SHA-256; runtime распакован во временную папку, без изменения системной службы. Исходный fixture с локалью C обнаружил проблему кириллического поиска; C.UTF-8 проходит. Производственная база не изменялась.
- Caddy проверялся как локальный процесс с loopback upstream. Это не Docker networking, Kubernetes failover, репликация БД или PITR.
- Новая визуальная browser QA заблокирована окружением: запуск CLI Chromium отклонён ограничением socket, облачный браузер отклонил localhost. Существующие UI-тесты выполнялись с детерминированными fixtures; это не проверка реальной отрисовки или телефонов.
- Java runtime 21 есть, но javac, Android SDK/adb/sdkmanager и Xcode отсутствуют. APK/AAB/IPA, подпись, GPS/camera OS bridge, native SSO/deep-link доставка и store review не выполнены.
- Независимая проверка безопасности частичная. Отсутствие критической находки не доказывает отсутствие уязвимостей; npm audit не покрывает весь продукт или отдельно vendored JS.
- Production DNS/TLS, реальные origin/ключи, IdP, резервное копирование/восстановление, RPO/RTO, нагрузка и операторские privacy/terms требуют приёмки на целевой площадке.

Вердикт публичного запуска: **NO-GO до закрытия этих release gates**. Production не запускался.
