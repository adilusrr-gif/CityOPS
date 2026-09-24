import {createEnterpriseApp} from '../../src/enterprise/server.mjs';
import {createTestDatabase} from './db-fixture.mjs';
import {featureEnv,featureKeys,startFeatureServer,featureHttp} from '../v4-http.test.mjs';
import {installAdventureHttpSuite} from '../v5-http.test.mjs';

installAdventureHttpSuite('PostgreSQL v5',async t=>{
 const storage=await createTestDatabase(),apps=[];
 t.after(async()=>{for(const app of apps)await app.close();await storage.close();});
 for(const [index,db] of [storage.db,storage.db2].entries())apps.push(await startFeatureServer(await createEnterpriseApp({db,keys:featureKeys,env:featureEnv({INSTANCE_ID:'v5-http-'+index,REQUIRE_ADMIN_MFA:'true'})})));
 return {...storage,apps,request:featureHttp(apps),
  async blockPhotoAudit(){await storage.db.query("CREATE FUNCTION reject_photo_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'photo.%' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$");await storage.db.query('CREATE TRIGGER reject_photo_audit BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION reject_photo_audit()');},
  async unblockPhotoAudit(){await storage.db.query('DROP TRIGGER reject_photo_audit ON audit');await storage.db.query('DROP FUNCTION reject_photo_audit()');},
 };
});
