# SSO / OpenID Connect

SSO работает в PostgreSQL-режиме v3. SQLite-режим сохраняет локальный вход.
Поддерживается один доверенный OIDC-поставщик на развёртывание: Authorization Code Flow, PKCE S256, state, nonce, RS256 ID token, проверка подписи по JWKS. Реализация использует `openid-client` 6.8.8; собственный JWT-парсер не используется.

## Настройка поставщика

1. Создайте confidential web client в вашем Keycloak, Entra ID или другом совместимом OIDC-поставщике. Выберите code flow, PKCE S256, подписанные RS256 ID tokens.
2. Зарегистрируйте **точный** redirect URI `https://ВАШ-ДОМЕН/api/auth/sso/callback`. Wildcard redirect URI не нужен. После входа сервер возвращает пользователя на свой фиксированный origin, произвольного `returnTo` нет.
3. Передайте через секреты одинаковые для всех реплик:

```dotenv
PUBLIC_ORIGIN=https://quest.example.com
OIDC_ISSUER=https://identity.example.com/realms/city-quest
OIDC_CLIENT_ID=city-quest
OIDC_CLIENT_SECRET=REPLACE_WITH_PROVIDER_SECRET
OIDC_BUTTON_LABEL=Войти через организацию
```

`OIDC_ISSUER` должен **точно** совпадать с issuer из discovery и `iss` подписанного токена. HTTPS и проверка TLS обязательны. Секрет не попадает в веб- или мобильную сборку. Для клиентов, зарегистрированных без секрета, используется token endpoint authentication method `none`; для confidential client — `client_secret_post`.

Обязательный redirect URI не меняется для мобильного приложения: поставщик возвращает ответ серверу. Сервер перенаправляет в `cityquest://auth/callback?code=...`, после чего приложение обменивает одноразовый код с собственным PKCE verifier. Нельзя регистрировать custom scheme как redirect URI OIDC web client.

## Аккаунты, роли и MFA

Идентичность определяется парой **issuer + subject**, а не email. При первом SSO-входе создаётся отдельный **player**, независимо от `roles`, `groups`, `email` и `email_verified` в claims. Его технический адрес `sso-<id>@identity.invalid` не используется для доставки почты. Парольный вход выключен; случайный пароль неизвестен пользователю и приложению после создания.

Чтобы использовать существующий локальный аккаунт администратора или бизнеса, оператор предварительно проверяет личность и связывает точные issuer + subject:

```bash
node --env-file=.env.enterprise scripts/link-oidc.mjs \
  --issuer https://identity.example.com/realms/city-quest \
  --subject EXACT_SUBJECT_FROM_IDP \
  --email existing-local-account@example.com
```

Команда требует доступ к PostgreSQL и ключу аудита; не меняет роль, не переносит другую привязку, аннулирует действующие сессии и пишет событие в аудит. Создавайте привязку до первого SSO-входа; уже занятую идентичность команда намеренно не переназначает. В таком случае сначала требуется проверенный операторский процесс объединения аккаунтов, который в эту версию не включён.

Если у связанного аккаунта включена локальная MFA, успешного OIDC-входа недостаточно: приложение запросит локальный TOTP или recovery code. Claims `amr` и `acr` не отменяют эту проверку. Для административных операций в production локальная MFA обязательна. Поэтому администраторам выдавайте локальный аккаунт с настроенной MFA и затем привязывайте SSO. Новые SSO-only players управляют MFA на стороне IdP; локальная настройка MFA для них недоступна, поскольку она требует повторного подтверждения локального пароля.

## Сессии и защита протокола

- State и PKCE verifier хранятся в общей PostgreSQL; verifier зашифрован `DATA_ENCRYPTION_KEY`. State дополнительно привязан к HttpOnly SameSite=Lax cookie браузера, что блокирует login CSRF. State действует 5 минут и атомарно удаляется до обращения к token endpoint.
- Callback можно принять другой репликой; sticky sessions не нужны. У реплик должны совпадать origin, OIDC-параметры и ключи.
- ID token проверяется по signature, issuer, audience, nonce и времени жизни библиотекой. ID/access/refresh tokens IdP не сохраняются и клиентам не выдаются.
- В браузере сессия — HttpOnly cookie. В мобильном приложении — непрозрачный bearer token только в памяти; сервер сохраняет только SHA-256 и проверяет общую таблицу сессий при каждом запросе.
- Мобильный обмен действует 2 минуты, одноразовый, с обязательным PKCE S256; перехваченная custom-scheme ссылка без verifier не открывает сессию. Закрытие приложения требует нового входа.
- Выход City Quest аннулирует сессию City Quest. **Глобальный logout IdP / back-channel logout / SCIM в этой версии не реализованы**. Отключение пользователя в City Quest блокирует текущие сессии сразу; отключение только в IdP не аннулирует уже открытую City Quest сессию. Выберите короткий idle timeout и отдельную процедуру отключения аккаунтов.
- Rate limits, MFA attempts, сессии, привязки и коды общие для всех реплик. Очистку истёкших записей выполняет приложение; это не меняет проверку expiry.

## API клиента

| Запрос | Ответ |
| --- | --- |
| `GET /api/auth/sso/config` | `{enabled,buttonLabel}` |
| `GET /api/auth/sso/start` | Redirect к IdP, web flow |
| `GET /api/auth/sso/start?platform=mobile&code_challenge=S256` | Redirect к IdP, mobile flow |
| `POST /api/auth/mobile/exchange` с `{code,code_verifier}` | `{user,accessToken}` или `{mfaRequired,challengeId}` |
| `POST /api/auth/mfa/login` с `{challengeId,code}` | `{user}` + cookie или `{user,accessToken}` для native |

Native запросы используют `X-CityQuest-Client: native` и разрешённый `Origin`; список задаётся `MOBILE_ORIGINS`. При отсутствии Origin заголовок native разрешает выдачу токена только после обычной проверки учётных данных/PKCE. Same-origin web-запрос никогда не получает accessToken в JSON. Web MFA challenge передаётся в fragment `/#mfaChallenge=...`, который не отправляется в HTTP access logs; клиент удаляет fragment после чтения.

## Проверка перед подключением организации

Локальный mock IdP в тестах подписывает настоящие RS256 JWT и проверяет PKCE: проверяются неверная подпись, nonce, audience, отсутствие cookie binding, повтор callback/code, local MFA и вход через две app instances. Это протокольные тесты, а не аттестация совместимости с конкретным tenant Entra/Keycloak. Проведите staging-вход, MFA, logout, отключение пользователя и ротацию секретов со своим IdP до выпуска.

Официальные источники: [openid-client OIDC example](https://github.com/panva/openid-client/blob/main/examples/oidc.ts), [AuthorizationCodeGrantChecks](https://github.com/panva/openid-client/blob/main/docs/interfaces/AuthorizationCodeGrantChecks.md), [явное включение проверки подписи](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md).
