# City Quest mobile

Android, iOS and browser use the same `../public` source. Setup and release instructions: [MOBILE.md](../docs/MOBILE.md).

```bash
npm ci
CITYQUEST_API_ORIGIN=https://your-api.example npm run sync
npm run android
# on macOS: npm run ios
```

The archived generated bundle points to reserved documentation domain `https://cityquest.example`; it cannot connect to a real service until you rebuild with your deployed HTTPS API origin. No default deployment or production credentials are included. `server.url` is deliberately absent: the interface and map engines are bundled into the app.

Before packaging a public release:

```bash
CITYQUEST_API_ORIGIN=https://YOUR_DEPLOYED_API_HOST npm run release:prepare
```

Use your actual deployed HTTPS host. `release:prepare` builds and syncs, then checks that Android/iOS shared assets match and that the embedded origin is neither a documentation/demo domain nor a local address. `release:check` can be run separately after sync. These checks do not verify backend availability, signing, device behavior or store readiness. The sample bundle deliberately fails the release-origin check.
