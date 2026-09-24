# Bounded read models — v0.6

SQLite and PostgreSQL execute the same read-model generators in `src/features/list-routes.mjs`. Public catalogs, quest listings, exploration history, administration and redemption history no longer require an unbounded response or silently stop at a hidden limit. The browser exposes continuation controls and loads fog only for the current map viewport.

| Endpoint | Default / maximum page size | Continuation and filtering |
| --- | --- | --- |
| `GET /api/organizations` | 500 / 500 | `cursor`, `q`, `bbox`; legacy `offset` remains accepted up to 100,000, but cannot be combined with `cursor` |
| `GET /api/quests` | 100 / 200 | `cursor`, `q`, `scope=public\|personal` |
| `GET /api/progress` | 500 / 1,000 per history | Independent `cells_cursor` and `completed_cursor`; exact `cells_total` and `completed_total` |
| `GET /api/explored` | 500 / 1,000 | Required `bbox=west,south,east,north`, plus `cursor`; returns `cells`, `total`, `next_cursor` |
| `GET /api/manage` | 50 / 100 per collection | Independent `organizations_cursor`, `quests_cursor`, `users_cursor`; filters `search`, `quest_search`, `user_search` |
| `GET /api/manage/users` | 20 / 100 | Admin user lookup by `q` (name, email or ID), `cursor` |
| `GET /api/manage/rewards` | 50 / 100 | `cursor` |
| `GET /api/manage/quests/:id/redemptions` | 50 / 100 | `cursor`; token secrets and hashes are never returned |

All accept `limit` within the documented bounds. City endpoints retain `city=almaty|astana`. Normal paginated responses contain `items`, `limit`, `total` and `next_cursor`; a null cursor means the last page. `/manage` returns the three arrays and their independent metadata in `pagination.organizations`, `pagination.quests`, and `pagination.users`. `/progress` exposes `cells_next_cursor` and `completed_next_cursor` instead of one combined cursor.

Cursors are opaque positions scoped to the authenticated account, city and filters where relevant. They are not credentials. Each private request revalidates session, role and ownership. Never change filters while reusing a cursor; start from the first page. These are live pages, not a snapshot export: concurrent edits that change sorting fields can move records between pages. Refresh before administrative edits; writes still require the optimistic version.

Quest responses contain server-computed `completed` and `unlocked`. A personal quest can remain unlocked even when its visited cell is outside the loaded fog page. UI totals come from the server, not the length of the currently displayed page. Location updates return the authoritative `cells_total`; repeated visits cannot inflate the visible counter.

Search treats `%`, `_` and backslash literally. PostgreSQL uses `ILIKE`; SQLite registers `cityquest_lower` at database startup to support case-insensitive Cyrillic and Kazakh search rather than the built-in ASCII-only folding. Grid membership uses the shared, persisted `EXPLORATION_GRID` contract; changing that grid requires a data migration.

Migration `006-query-indexes.sql` adds indexes for the actual authorization, city and ordering predicates; it does not modify released SQL migrations. SQLite moves from schema 4 to 5 and PostgreSQL from schema 5 to 6. The SQLite importer still accepts schema 2, 3, 4 and 5. Application replicas retain exact schema readiness checks; follow the documented maintenance cutover instead of mixing old and new binaries during migration.

`node scripts/benchmark-queries.mjs` reproduces a local in-memory SQLite index comparison using all 13,128 bundled real organization records and 20,000 synthetic visited cells. The committed observation is `QUERY-BENCHMARK.json`. It records query plans, median/p95 query times and response byte counts. It is not a native PostgreSQL, HTTP load or HA benchmark. Substring search still scans matching city rows, and viewport filtering still examines the selected user's city history; production capacity must be measured with the target dataset and infrastructure.

## История оплат администратора (0.7)

`GET /api/admin/billing?limit=50&cursor=...` возвращает `orders`, точный `total`, `limit`, `next_cursor`, `notice`. По умолчанию 50, максимум 200. Порядок: `created_at DESC, id DESC`; курсор привязан к администратору, не является разрешением доступа. Каждая страница снова требует активную роль admin и подтверждённую MFA. Offset не поддерживается. `GET /api/admin/billing/:id` даёт одну заявку с теми же проверками. Клиент хранит стек предыдущих курсоров, отменяет результат устаревшей страницы и не обрезает историю на 200 записях.

Сортировка общего списка и точный count требуют проверки на объёме целевой площадки; отдельный индекс общей истории в этом патче не добавляется, исторические миграции не переписываются. Пользовательская краткая история и прочие списки сохраняют отдельные документированные пределы.

## Реклама v0.8

`GET /api/manage/promotions` и `GET /api/admin/promotions` возвращают `items`, `total`, `next_cursor`; default limit 50, максимум 200. Передайте `cursor=next_cursor` для следующей страницы. Курсор привязан к аккаунту, роли, виду кабинета и городу. История сверх 200 кампаний остаётся доступна, включая архивирование старой активной кампании.
