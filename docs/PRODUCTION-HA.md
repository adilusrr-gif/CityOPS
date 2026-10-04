# PostgreSQL, несколько реплик и production-развёртывание

## Что поставляется и что нужно запустить

Версия 0.3 добавляет PostgreSQL-режим, общие между процессами сессии/лимиты/аудит и манифесты Kubernetes. Код выбирает его при наличии `DATABASE_URL`; без него сохраняется локальный SQLite-режим. Веб, Android и iOS обращаются к одному API. Sticky sessions не требуются. Миграции и создание первого администратора выполняются отдельными командами; каждый HTTP-процесс не меняет схему при запуске.

В этой поставке кластер **не развёрнут**: нет доступа к вашему Kubernetes, DNS, registry, облачным ключам и IdP. Манифесты отрендерены и проверены по схемам; запуск на реальных узлах, проверка сетевых политик, переключения PostgreSQL, TLS, восстановления и ёмкости остаются приёмкой на вашем стенде. Три процесса сами по себе не подтверждают доступность при отказе узла, зоны или базы.

Два варианта базы:

- Управляемый PostgreSQL с HA endpoint, проверяемым TLS, backups/PITR и отдельными SQL-ролями. Оператор облака отвечает за реальную репликацию/переключение.
- Комплектный `deploy/k8s/cnpg`: три экземпляра PostgreSQL под CloudNativePG, синхронная репликация с одной подтверждающей репликой и резервирование WAL в S3. Нужны три независимые зоны, CSI-хранилище, операторы и внешнее объектное хранилище.

`compose.enterprise.yaml` — локальный стенд: два процесса приложения, один PostgreSQL, один прокси, один хост. Он позволяет проверить общие сессии и остановку одного приложения; его база и хост остаются единственными точками отказа.

## Зафиксированные компоненты

Проверенные 23 сентября 2026 источники: [CloudNativePG 1.30 installation](https://cloudnative-pg.io/docs/1.30/installation_upgrade/), [матрица совместимости](https://cloudnative-pg.io/docs/1.30/supported_releases/), [установка Barman Cloud](https://cloudnative-pg.io/plugin-barman-cloud/docs/installation/) и [PostgreSQL releases](https://www.postgresql.org/support/versioning/).

| Компонент | Версия в примерах |
| --- | --- |
| Kubernetes для CNPG 1.30 | 1.34–1.36; локальная проверка YAML для 1.35 |
| CloudNativePG | 1.30.1 |
| PostgreSQL | 17.11 |
| Barman Cloud plugin | 0.15.0 |
| Приложение | 0.8.0; свой registry и digest перед публикацией |
| Локальный прокси Caddy | 2.10.2 |

Образы PostgreSQL/Caddy закреплены по digest, полученному из соответствующего registry. Пример приложения `ghcr.io/YOUR_ORGANIZATION/cityquest:0.8.0` нужно заменить образом вашей сборки во **всех трёх** kustomization приложения, миграции и bootstrap. Перед публичным выпуском обязателен immutable digest; `production-check.mjs --manifest` отклоняет mutable tags. Установка операторов требует прав администратора кластера; сначала проверьте совместимость со своим дистрибутивом, существующими CRD и политикой обновлений. Версии не обновляются автоматически.

## Минимальные условия площадки

- Три worker-узла в трёх зонах с метками `topology.kubernetes.io/zone` и достаточными ресурсами для последовательной замены Pod. Сам control plane, балансировщик и ingress также должны переживать согласованный сценарий отказа.
- CNI с работающими NetworkPolicy, CoreDNS, NTP, зашифрованные диски и expandable CSI StorageClass `encrypted-rwo` (замените своим именем). Volume каждого PostgreSQL: данные 50 GiB + WAL 20 GiB; это начальная оценка, не расчёт ёмкости.
- На каждую app-реплику request 250m CPU / 256 MiB, limit 2 CPU / 768 MiB; на каждую DB-реплику 1 CPU / 2 GiB request, 2 CPU / 2 GiB limit. Barman sidecar имеет отдельные лимиты. Нужны дополнительные ресурсы для операторов, ingress, мониторинга и временного восстановления.
- Существующий поддерживаемый Traefik ingress class `traefik`, публичный балансировщик, домен и TLS. HTTP entrypoint перенаправляется на HTTPS настройкой контроллера; манифест приложения использует `websecure`.
- Secret manager или ограниченный доступ к Kubernetes Secrets с encryption at rest для etcd. Приложение запускается без Kubernetes API token; SQL owner доступен только maintenance Jobs.

`PodDisruptionBudget minAvailable=2` ограничивает добровольные disruptions. Стратегия приложения `maxUnavailable=1, maxSurge=0` освобождает один старый Pod перед заменой: обязательный anti-affinity по hostname не требует четвёртого узла, две реплики остаются доступными при штатном обновлении. Это требует готовности оставшихся реплик и успешного старта нового Pod. Он не предотвращает аварийную потерю узла. Обязательное распределение по трём зонам намеренно оставит часть Pod в Pending в однозонном кластере. Для лаборатории можно осознанно ослабить это правило, но такая лаборатория не проверяет отказ зоны.

## Подготовка образа и конфигурации

```sh
npm ci
npm test
npm run test:enterprise
node --test deploy/*.test.mjs
docker build -t REGISTRY/cityquest:0.8.0 .
docker push REGISTRY/cityquest:0.8.0
```

В `deploy/k8s/base/kustomization.yaml`, `jobs/kustomization.yaml` и `bootstrap/kustomization.yaml` задайте имя/digest опубликованного образа. Если registry приватный, добавьте свой `imagePullSecrets` во все три PodSpec. Команды ниже публикует оператор на своей площадке; из данной среды они не выполнялись.

Отредактируйте `deploy/k8s/foundation/config.yaml`: `PUBLIC_ORIGIN=https://ваш-домен`, параметры OIDC, `PG_POOL_MAX`, мобильные origins и доверенные прокси. Тот же домен должен быть в `base/networking.yaml` и сертификате. `PG_POOL_MAX=10` задаёт до 30 соединений для трёх app-реплик в штатном состоянии. В бюджете базы отдельно учитывайте завершающиеся Pod, Jobs, мониторинг и дополнительные реплики; отсутствие surge не заменяет контроль фактического числа соединений.

`TRUST_PROXY=none` безопасно игнорирует `X-Forwarded-For`, но объединяет лимиты клиентов, пришедших через один ingress IP. Для площадки задайте `TRUST_PROXY=cidr` и `TRUST_PROXY_CIDRS` **только для реальных CIDR доверенных ingress-прокси**. Приложение обходит цепочку справа налево до первого недоверенного адреса. Ingress обязан корректно очищать/добавлять forwarded headers; его namespace не должен содержать недоверенные workloads. CIDR `0.0.0.0/0` запрещён кодом.

```sh
kubectl apply -k deploy/k8s/foundation
kubectl label namespace YOUR_INGRESS_NAMESPACE cityquest-ingress=true
```

NetworkPolicy разрешает app входящий TCP 3000 только из помеченных ingress/monitoring namespaces, egress к DNS, CNPG TCP 5432 и публичному HTTPS. Для управляемой БД добавьте её точные IP/CIDR/port в egress; для внутреннего IdP — его маршрут. IPv6-only, другой DNS namespace и service mesh требуют соответствующих правил. Нельзя считать политику действующей, пока это не проверено выбранным CNI.

## Секреты и отдельные SQL-роли

Для **новой** базы можно создать приватный bundle. Он содержит случайные пароли и независимые ключи, не выводит их в консоль, не перезаписывает файл и создаёт его с правами 0600.

```sh
node deploy/generate-k8s-secrets.mjs \
  --db-host cityquest-pg-rw.cityquest.svc.cluster.local \
  --admin admin@example.com
kubectl apply -f data/deployment-secrets/secrets.json
```

Для перехода с v2 сначала передайте генератору исходные `DATA_ENCRYPTION_KEY` и `AUDIT_HMAC_KEY` через защищённый env-файл; новые ключи сломают чтение MFA и проверку аудита. Генератор предназначен для первого создания ролей/секретов, не для ротации живых паролей.

| Secret | Обязательные ключи и назначение |
| --- | --- |
| `cityquest-runtime` | `DATABASE_URL` роли `cityquest_app`, общие для всех реплик `DATA_ENCRYPTION_KEY` и `AUDIT_HMAC_KEY`; `METRICS_TOKEN` для мониторинга |
| `cityquest-migration` | `DATABASE_URL` роли `cityquest_owner` и те же два ключа для maintenance |
| `cityquest-bootstrap` | `ADMIN_EMAIL`, случайный `ADMIN_PASSWORD`; только разовый Job |
| `cityquest-pg-owner` | `username=cityquest_owner`, `password`, тип `kubernetes.io/basic-auth`; CNPG initdb |
| `cityquest-pg-app` | `username=cityquest_app`, `password`, basic-auth; CNPG managed role |
| `cityquest-pg-ca` | `ca.crt`; CNPG создаёт автоматически, для управляемой базы создайте Secret из CA провайдера |
| `cityquest-metrics` | `token`, равный `METRICS_TOKEN`; отделён от DB credentials для Prometheus |
| `cityquest-backup-s3` | `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY`; ограниченный доступ к backup prefix |
| `cityquest-tls` | `tls.crt`, `tls.key`, тип `kubernetes.io/tls` |

В `DATABASE_URL` не добавляйте никакие TLS/compatibility-параметры (`sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `ssl`, `uselibpqcompat`): код их отклоняет. Настройки TLS передаются отдельно через окружение. `PGSSLMODE=verify-full` и `PGSSLROOTCERT=/run/secrets/postgres/ca.crt` включают проверку CA **и имени хоста**. CNPG endpoint — `cityquest-pg-rw.cityquest.svc.cluster.local`; не подключайтесь напрямую к адресам отдельных Pod.

Для управляемого PostgreSQL заранее создайте роли `cityquest_owner` и `cityquest_app` с LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION; владелец базы `cityquest` — owner. App не должен наследовать owner. Bundle нужно согласовать с паролями этих ролей. Сертификат провайдера:

```sh
kubectl -n cityquest create secret generic cityquest-pg-ca --from-file=ca.crt=/secure/provider-ca.crt
kubectl -n cityquest create secret tls cityquest-tls --cert=/secure/tls.crt --key=/secure/tls.key
```

Сертификаты и их renewal можно поручить установленному cert-manager. В этом случае задайте проверенный Issuer/ClusterIssuer своей площадки; пользовательские DNS/API credentials не включены. DNS A/AAAA домена должен указывать на ingress LoadBalancer, а public origin — совпадать с доменом TLS.

Опционально `deploy/k8s/external-secrets` связывает эти секреты с уже настроенным `ClusterSecretStore cityquest-secret-store` через External Secrets Operator (`external-secrets.io/v1`). Перед применением создайте указанные `cityquest/prod/*` записи у провайдера. Формат см. в [официальной документации ExternalSecret](https://external-secrets.io/latest/api/externalsecret/). Не используйте одновременно ручное управление и `creationPolicy: Owner` для одних Secret. Обновление environment Secret требует контролируемого rollout Pod; само обновление объекта не меняет env запущенного процесса.

## Вариант с CloudNativePG

Пропустите этот раздел для управляемой базы. Требуются cert-manager и три доступные зоны. Проверьте загруженные release-манифесты по опубликованным подписям согласно документации CNPG; установка ниже изменяет CRD/RBAC кластера.

```sh
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.1.yaml
kubectl -n cnpg-system rollout status deployment/cnpg-controller-manager
kubectl apply -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.0/manifest.yaml
kubectl -n cnpg-system rollout status deployment/barman-cloud
```

В `cnpg/backups.yaml` замените bucket, prefix и endpoint своего S3-совместимого хранилища; bucket должен быть приватным, с encryption/KMS и отдельными правами для backup/restore. Credentials создаются из защищённого файла, а не копируются в Git:

```sh
kubectl -n cityquest create secret generic cityquest-backup-s3 --from-env-file=/secure/backup-s3.env
kubectl apply -k deploy/k8s/cnpg
kubectl -n cityquest wait --for=condition=Ready cluster/cityquest-pg --timeout=600s
kubectl -n cityquest get pods -l cnpg.io/cluster=cityquest-pg -o wide
```

Выбрано `synchronous: {method: any, number: 1, dataDurability: required}`: подтверждение записи ждёт одну синхронную реплику. При отсутствии достаточных здоровых реплик записи блокируются; настройка не понижает durability автоматически. Это осознанный компромисс, который нужно проверить при сетевых разделениях и отказе зоны. [Параметры репликации CNPG](https://cloudnative-pg.io/docs/1.30/replication/).

Обновления primary требуют supervised switchover; автоматическое аварийное переключение остаётся функцией оператора. Не отключайте fencing/isolation safeguards. PDB/replication не заменяют независимые backups. CA секрет CNPG монтируется напрямую; при ротации CA проверьте reload/reconnect приложений и выполните rollout после согласования CA цепочки.

## Обновление с v0.3 на v0.4

В v0.4 PostgreSQL-схема меняется с 3 на 4, SQLite — с 2 на 3. Планируйте окно обслуживания: остановите старые HTTP replicas и остальные writers **до** миграции. v0.3 проверяет прежнюю версию схемы, поэтому rolling update поверх миграции не обеспечивает непрерывную доступность. Сохраните backup и прежние encryption/audit keys; ключ encryption теперь также защищает историю питомца.

Сначала обновите схему и повторите grants с выключенными `BILLING_MANUAL_ENABLED` и AI credentials, затем запустите и проверьте v0.4. Вторым этапом отдельно подключите AI и, после настройки сверки реальных платежей, ручные web-заказы. Пошаговые команды и rollback — в [AI-PET.md](AI-PET.md#обновление-и-включение); условия оплаты — в [MONETIZATION.md](MONETIZATION.md). В v0.4 использовались отдельные имена Jobs `*-v4`; старый завершённый Job не считается миграцией нового релиза.

## Обновление с v0.4 на v0.5

В v0.5 PostgreSQL-схема меняется с 4 на 5, SQLite — с 3 на 4. Перед миграцией остановите HTTP replicas и остальные writers, сохраните проверенный backup и исходные encryption/audit keys. Старый процесс проверяет свою версию схемы; смешанный rolling update v0.4/v0.5 не поддерживается. Используйте согласованное окно обслуживания.

1. Соберите образ v0.5 и задайте его immutable digest в трёх kustomization. Остановите writers (`kubectl -n cityquest scale deployment/cityquest --replicas=0`; также остановите HPA и внешних writers, если они у вас настроены).
2. Примените обновлённый ConfigMap, затем последовательно выполните `cityquest-migrate-v5` и `cityquest-grants-v5` по командам ниже. Не запускайте bootstrap повторно без необходимости. Миграция добавляет таблицы приключений, территорий, фотографий и конкурса; прежние таблицы и миграционные checksums сохраняются.
3. Запустите три app-replicas из нового образа. Проверьте `/api/ready`, вход/MFA, прогресс питомца, старый квест и новую фотографию через разные app-процессы. Проверьте, что отклонённые и ожидающие модерации изображения недоступны постороннему пользователю.
4. Перед публичным горным заданием администратор отдельно проверяет доступные контрольные точки и публикует маршрут. Горный пример с двумя высотными отметками поставляется черновиком. Откройте фотоконкурсы только после назначения модератора и проверки сроков.

Фото пилота хранятся в общей БД, поэтому не требуют привязки к Pod или общего файлового тома приложения. Они увеличивают размер base backup, WAL и время восстановления. Начальный лимит полезных JPEG — 100 МиБ на всё приложение; base64 и служебные данные занимают больше места. Это ограниченный пилот, а не готовое безлимитное object storage. Сначала измерьте размер backup и время восстановления с реальными изображениями; не увеличивайте лимит без расчёта ёмкости. Подробности хранения, удаления и модерации — в [PHOTO-CONTESTS.md](PHOTO-CONTESTS.md).

Откат после миграции выполняйте восстановлением проверенного backup в отдельную базу с прежним образом; down-migration не поставляется. После появления новых записей v0.5 возврат к backup потеряет эти записи, поэтому решение требует плана переноса/сверки данных. Не подключайте старый образ к новой схеме. Jobs релиза имеют имена `*-v5`; применённый ранее `*-v4` не обновляет схему этого релиза.

## Обновление с v0.5 на v0.6

В v0.6 PostgreSQL-схема меняется с 5 на 6, SQLite — с 4 на 5. Новая additive-миграция `006-query-indexes.sql` добавляет индексы каталогов, администрирования, прогресса, истории наград и фото-квот. Прежние DDL-файлы и checksums не изменяются. Индексы строятся в транзакции миграции: на большой базе это отдельное окно обслуживания, а не обещание online upgrade.

1. На копии актуального backup измерьте продолжительность миграции и свободное место. Сохраните прежний image digest, backup и те же encryption/audit keys. Остановите writers и старые app Pod до изменения схемы; exact-schema readiness старого приложения несовместим с новым номером.
2. Настройте v0.6 ConfigMap, owner secret и новый digest. Выполните `cityquest-migrate-v6`, затем `cityquest-grants-v6`; завершённый v5 Job не заменяет эти задания. Bootstrap повторно не требуется. Исторические награды, деньги, фото и исправленный оператором контент не сбрасываются.
3. Запустите новые Pod и проверьте ready, вход/MFA, оба города, следующую страницу каталога/админки, старый прогресс, новые награды, pending/approved фото и кратковременную перегрузку. Выполните `production-check.mjs --database` с runtime ролью без bootstrap-пароля.
4. Для rollback восстановите backup в отдельную базу и используйте совместимый прежний образ. Не подключайте v0.5 к схеме 6. После возобновления записи возврат к старому backup требует отдельного решения о переносе/потере новых записей.

## Обновление с v0.7 на v0.8

Версия v0.8 сохраняет PostgreSQL-схему 6 и SQLite-схему 5; новых DDL-миграций и перезаписи checksums нет. При обновлении с более старой версии сначала выполните соответствующие исторические шаги выше. Текущие manifest используют образ v0.8.0 и Jobs `*-v8`; прежние имена в исторических разделах относятся к тем выпускам.

На существующей v0.7 базе обновление приложения допускает совместимый rolling update без изменения схемы, но только после обязательной проверки смешанных версий на staging. Проверьте общие сессии и SSO/MFA, одноразовые награды, фото, отзыв прав, пагинацию и остановку Pod с активным запросом. Сохраните backup, исходные ключи и прежний image digest. Для обновления v0.7 → v0.8 повторный bootstrap не нужен; migration CLI проверяет уже применённые версии и checksums.

Примените конфигурацию и новый immutable digest, затем `kubectl apply -k deploy/k8s/base` и `kubectl -n cityquest rollout status deployment/cityquest --timeout=300s`. На трёх узлах стратегия заменяет по одному Pod, сохраняя два доступных. Прерывайте rollout при ошибках readiness или бизнес-проверок. Совпадение версии схемы позволяет совместимый откат кода, но не отменяет проверки данных и смысла операций: возвращать старый образ с уже исправленными дефектами без согласованного решения нельзя.

## Порядок первого релиза

1. Foundation, secrets, database, CA и TLS уже созданы. Не создавайте app Deployment до завершения миграции и grants.
2. Для **новой пустой базы** Job содержит `--seed`, который добавляет оба города. Для переноса v2 уберите `--seed` и сначала выполните перенос по следующему разделу.
3. Выполните Jobs последовательно:

```sh
kubectl apply -k deploy/k8s/jobs
kubectl -n cityquest wait --for=condition=complete job/cityquest-migrate-v8 --timeout=600s
kubectl -n cityquest logs job/cityquest-migrate-v8
kubectl apply -k deploy/k8s/grants
kubectl -n cityquest wait --for=condition=complete job/cityquest-grants-v8 --timeout=180s
kubectl apply -k deploy/k8s/bootstrap
kubectl -n cityquest wait --for=condition=complete job/cityquest-bootstrap-v8 --timeout=120s
kubectl apply -k deploy/k8s/base
kubectl -n cityquest rollout status deployment/cityquest --timeout=300s
curl --fail https://quest.example.com/api/ready
```

Команда grants отнимает у runtime роли CREATE/TRUNCATE и изменение схемы, оставляет DML для приложения, но запрещает изменение/удаление исторических audit rows и мутации `schema_migrations`. Владелец БД остаётся привилегированным, поэтому его credentials не должны попадать в HTTP Pod.

Получите исходный admin password из своего secret manager/bundle, войдите и настройте MFA. `--bootstrap` ничего не меняет, если администратор уже существует. После входа удалите bootstrap Job и активный `cityquest-bootstrap` secret; для External Secrets сначала удалите соответствующий ExternalSecret, иначе Secret будет восстановлен. Owner credentials сохраняются в закрытом maintenance-контуре для будущих миграций.

У следующих релизов должны быть новые имена Jobs и образ/digest релиза. Завершённый Job не выполняется повторно от `kubectl apply`; старые неизменяемые Pod templates нельзя переиспользовать как новый релиз. TTL очищает Jobs через сутки, но это не планировщик миграций.

## Перенос SQLite v2 в PostgreSQL

Это контролируемый cutover со временем без записи. Репликации изменений из SQLite после снимка нет.

1. Остановите v2 writers; создайте и проверьте backup по `OPERATIONS.md`. Сохраните исходную SQLite и её encryption/audit keys. Целевая PostgreSQL должна быть новой, без `--seed` и без bootstrap.
2. С хоста оператора с разрешённой TLS-связью к базе и приватным `.env.migration` (owner URL, PG TLS CA, **старые** два ключа) выполните:

```sh
node --env-file=/secure/.env.migration scripts/import-sqlite-postgres.mjs --source /secure/v2.sqlite
```

3. Команда проверяет целостность источника, аудит и MFA encryption, переносит записи атомарно, сохраняет ID, права, прогресс и подписи аудита. Если цель уже содержит пользовательские данные, перенос отклоняется. Он не меняет исходный файл.
4. Выполните grants, запустите app и проверьте вход/выход, MFA, оба города, награды и audit verification. DNS/traffic переключайте только после проверок. Не запускайте v2 и v3 одновременно на разных копиях как два writer.
5. Для отката после новых записей в PostgreSQL требуется отдельный план переноса изменений. Простое возвращение к старому SQLite потеряет записи после cutover. Сохраните исходник до окончания согласованного периода.

## Backups, PITR и восстановление

Комплектная конфигурация задаёт непрерывное WAL archiving, `archive_timeout=60s`, ежедневную base backup в 02:00 UTC и retention 30 дней. Работоспособность определяется реальным доступом к bucket, состоянием WAL, полнотой base backup и проверенным восстановлением, а не наличием YAML. Подробности API: [Barman Cloud usage/recovery](https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/).

Цели приёмки: RPO ≤ 5 минут для восстановления из object storage, RTO ≤ 30 минут для базы данного размера; для потери одной DB-реплики — отсутствие потери подтверждённых записей при исправной синхронной репликации. Это **целевые показатели**, фактические значения в данной среде не измерялись. При одновременной потере зон, backup credentials или ключей поведение и потери могут отличаться.

На изолированном стенде:

1. Убедитесь в успешной base backup и непрерывной цепочке WAL до выбранного времени. Сделайте независимую контрольную запись audit head и тестовой бизнес-операции.
2. В `deploy/k8s/cnpg-restore/restore.yaml` задайте реальный `targetTime` и правильный source/serverName; образ и major PostgreSQL должны соответствовать архиву. Никогда не оставляйте примерное время из шаблона.
3. `kubectl apply -k deploy/k8s/cnpg-restore` создаёт **новый** cluster `cityquest-pg-restored`, не перезаписывая исходный. У него другой CA secret и endpoint; подготовьте отдельный app namespace/секреты для проверки. Не подключайте к нему live приложение автоматически.
4. С исходными `DATA_ENCRYPTION_KEY`/`AUDIT_HMAC_KEY` проверьте аудит, MFA, пользователей, counts, квесты и одноразовые награды. Запишите фактическую потерю интервала, время восстановления и все шаги. Ключи приложения резервируются отдельно от базы.
5. Перед production cutover остановите writers старого кластера. Для восстановленного кластера настройте **новый** backup prefix и WAL archiver, проверьте backup, обновите ограниченные NetworkPolicy, CA и DATABASE_URL, затем переключите трафик. Комплектный restore-манифест намеренно не пишет в backup prefix исходного кластера.

Раз в месяц и после изменений backup/ключей проводите восстановление. Контролируйте возраст внешнего WAL/base backup, replication lag, свободное место, ошибки object storage, сертификаты, число доступных replicas и возраст последней успешно отрепетированной копии. Bucket lifecycle не должен удалять WAL, нужный retained base backup. Object Lock/неизменяемое хранение настраиваются с учётом retention механизма Barman.

## Наблюдаемость и испытания отказов

`/api/health` проверяет процесс; `/api/ready` проверяет подключение и схему БД и отвечает 503 при drain/неисправности. Liveness не зависит от готовности БД, поэтому краткий failover не должен вызвать массовый рестарт приложений. На SIGTERM процесс помечается draining, закрывает HTTP listener и ожидает уже принятые обработчики и выполняющийся maintenance перед закрытием БД. Через 10 секунд оставшиеся HTTP-соединения принудительно закрываются; это не отменяет серверную операцию. Kubernetes даёт 40 секунд на завершение, включая preStop длительностью 5 секунд, после чего может применить SIGKILL. Успешное завершение каждой операции до этого предела не гарантируется; после обрыва сверяйте результат записи перед повтором. Подробности порядка остановки — в [OPERATIONS.md](OPERATIONS.md#остановка-и-обновление-процесса-v07).

`/metrics` отдаёт Prometheus counters с `Authorization: Bearer METRICS_TOKEN`. Значения относятся к конкретной реплике; суммируйте их в Prometheus. `deploy/k8s/monitoring` содержит опциональный ServiceMonitor для установленного Prometheus Operator. Выберите его label selector в своём Prometheus, пометьте namespace мониторинга `cityquest-monitoring=true` и разрешите чтение только `cityquest-metrics`, а не runtime DB secret. `/api/admin/metrics` и аудит остаются под admin/MFA.

Перед первым публичным запуском проведите следующие сценарии на принадлежащем вам staging:

- Создать игрока/сессию и команду; чередовать запросы между тремя app-репликами. Сессия, прогресс, revoke и rate limit должны быть общими.
- Одновременно завершить один квест и погасить один token через разные процессы: один результат, одно начисление XP. Повторный запрос после неоднозначного обрыва сначала сверяет результат, не выдаёт награду заново.
- Удалить **один** staging app Pod, затем выполнить rolling update; проверить ошибки, p95, готовность и отсутствие потери сессий. Объявленный availability budget оценивается по внешнему трафику, а не только status Deployment.
- Контролируемо остановить primary PostgreSQL штатной процедурой CNPG/провайдера; измерить переключение и reconnection. Обрыв во время commit имеет неоднозначный результат: общий автоматический retry всех записей запрещён. Сверьте бизнес-операцию и audit.
- Испытать недоступность одной зоны, потерю связи между DB-репликами, недоступный IdP, object storage и DNS. Записать, какие операции остаются доступными и кто принимает решение о degraded режиме.
- Восстановить backup в отдельный кластер и выполнить проверки раздела PITR. Приёмка завершается отчётом с измеренными RPO/RTO, версиями и ответственными, а не отметкой «есть три replicas».

## Локальный двухпроцессный стенд

Требуется Docker Compose v2. Секреты генерируются локально; один postgres volume сохраняется между перезапусками. PostgreSQL не публикует порт наружу; HTTP доступен только на loopback.

```sh
node deploy/local/init-env.mjs
docker compose --env-file .env.enterprise.local -f compose.enterprise.yaml config --quiet
docker compose --env-file .env.enterprise.local -f compose.enterprise.yaml up --build --wait app1 app2 proxy
docker compose --env-file .env.enterprise.local -f compose.enterprise.yaml run --rm bootstrap
curl --fail http://localhost:8080/api/config?city=astana
```

Откройте `http://localhost:8080`; пароль администратора прочитайте из локального приватного env-файла. `X-CityQuest-Upstream` в ответе показывает выбранный upstream только в этом демонстрационном прокси. После авторизации остановите `app1`, дождитесь health check и проверьте ту же сессию через `app2`; затем верните `app1`.

```sh
docker compose --env-file .env.enterprise.local -f compose.enterprise.yaml stop app1
curl --fail --retry 5 --retry-all-errors http://localhost:8080/api/ready
docker compose --env-file .env.enterprise.local -f compose.enterprise.yaml up -d app1
```

Этот файл использует development HTTP и отключает PG TLS только внутри локальной Docker-сети. Он не подходит для интернета. Не удаляйте volume командой `down --volumes`, если нужны созданные данные. Повторная генерация env с новыми DB-паролями не обновляет роли в существующем volume.

## Проверка поставки

Все девять Kustomize-каталогов рендерятся через kubectl 1.35.3 / Kustomize 5.7.1. Kubeconform 0.8.0 проверил основные Kubernetes-ресурсы по schema 1.35 и CNPG/Barman CRD, извлечённым из официальных зафиксированных release manifests. Это статическая проверка; Kubernetes admission/webhooks и сеть не запускались. Optional ExternalSecret/ServiceMonitor зависят от CRD операторов вашей площадки.

Четыре теста `node --test deploy/secrets.test.mjs` проверяют разделение DB-ролей, согласованность ключей, права 0600, отсутствие credentials в stdout/stderr, сохранение старых ключей при migration и отказ от перезаписи. CI добавляет native PostgreSQL integration, сборку общих mobile assets и Docker Compose smoke с остановкой одного процесса; эти проверки выполнятся в GitHub после восстановления доступа и запуска workflow. Фактические результаты всей сборки приведены в `VALIDATION.md`.


## Gate публичного выпуска v0.8

Перед открытием ingress выполните [PRODUCT-LAUNCH.md](PRODUCT-LAUNCH.md): конфигурационный gate, read-only DB check после bootstrap/MFA и lint ваших отрендеренных manifest. Примеры доменов, registry и bucket намеренно не являются рабочей production-конфигурацией. Проверка не вызывает AI, оплату, seed или миграции. Успешный JSON gate не заменяет измерение restore/failover и приёмку устройств.

Новые HTTP/SQL лимиты задают ограниченную приёмку нагрузки; на каждую app-реплику отдельно учитываются HTTP inflight, upload slots и очередь соединений. Для трёх Pod `PG_POOL_MAX=10` задаёт 30 активных DB connections в штатном состоянии; при расчёте резерва учитывайте завершающиеся Pod, Jobs и мониторинг. Текущая стратегия не создаёт surge-реплику. Общие лимиты наград, фото и AI по-прежнему используют общую БД. Контакты и policy должны совпадать на всех репликах.

### Проверка ключа при обновлении v0.8

До открытия ingress выполните `release:check -- --database` с исходным DATA_ENCRYPTION_KEY. Проверка читает все MFA и шифротексты питомца; обычный startup проверяет только ограниченную выборку. Не генерируйте новый ключ при redeploy. Пустая база не позволяет проверить совпадение ключей реплик. Старый backend без location TTL будет скрывать точки команды в новом UI до обновления всех реплик.

## Кандидат квестов · схемы SQLite 6 / PostgreSQL 7

Перед обновлением сохраните проверенный backup и прежние ключи. Остановите старые writers, примените новую аддитивную миграцию отдельной migration-ролью, обновите grants и запустите согласованный код. Старый exact-schema readiness с новой схемой несовместим; mixed rollout не поддерживается. При откате восстанавливайте соответствующие код и backup, не удаляйте новые колонки вручную. На копии базы сначала проверьте сохранение пользователей, завершений и XP. Повторный seed не перезаписывает существующие квесты, поэтому новые редакционные задания для старой базы принимаются оператором в редакторе. Непроверенные маршруты остаются недоступны для новых отметок даже при историческом open. [Пилот](QUEST-PILOT.md).
