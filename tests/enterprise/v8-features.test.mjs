import {v8FeaturesSuite} from '../helpers/v8-features-suite.mjs';
import {createTestDatabase} from './db-fixture.mjs';
v8FeaturesSuite('PostgreSQL', async () => ({...await createTestDatabase(), audit() {}}));
