import {createTestDatabase} from './db-fixture.mjs';
import {productPolicySuite} from '../helpers/product-policy-suite.mjs';

productPolicySuite('PostgreSQL product policy', async t => {
  const fixture = await createTestDatabase();
  t.after(() => fixture.close());
  t.diagnostic(`SQL engine: ${fixture.engine}`);
  return {db: fixture.db, dialect: 'postgres'};
});
