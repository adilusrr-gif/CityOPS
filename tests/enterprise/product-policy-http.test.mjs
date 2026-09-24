import {createEnterpriseApp} from '../../src/enterprise/server.mjs';
import {createTestDatabase} from './db-fixture.mjs';
import {featureKeys, startFeatureServer, featureHttp} from '../v4-http.test.mjs';
import {installPolicyHttpSuite, policyHttpEnv} from '../product-policy-http.test.mjs';

installPolicyHttpSuite('PostgreSQL policy', async t => {
  const storage = await createTestDatabase();
  let app;
  t.after(async () => {if (app) await app.close(); await storage.close();});
  app = await startFeatureServer(await createEnterpriseApp({db: storage.db, keys: featureKeys, env: policyHttpEnv()}));
  return {request: featureHttp([app])};
});
