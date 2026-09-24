import {openDb} from '../src/db.mjs';
import {photoCursorSuite} from './helpers/v8-photo-suite.mjs';

photoCursorSuite('SQLite', async t => {
  const db = openDb(':memory:', {withSnapshot: false}); t.after(() => db.close());
  return {db, dialect: 'sqlite'};
});
