import {createTestDatabase} from './db-fixture.mjs';
import {photoCursorSuite} from '../helpers/v8-photo-suite.mjs';

photoCursorSuite('PostgreSQL', async t => {
  const fixture = await createTestDatabase(); t.after(() => fixture.close());
  t.diagnostic(`SQL engine: ${fixture.engine}`);
  return {db: fixture.db, dialect: 'postgres'};
});
