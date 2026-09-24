import {createEnterpriseApp} from '../../src/enterprise/server.mjs';
import {createTestDatabase} from './db-fixture.mjs';
import {installFeatureHttpSuite,featureProvider,featureEnv,featureKeys,startFeatureServer,featureHttp} from '../v4-http.test.mjs';

installFeatureHttpSuite('PostgreSQL v4',async t=>{
 const storage=await createTestDatabase(),provider=featureProvider(),apps=[];
 t.after(async()=>{for(const app of apps)await app.close();await storage.close();});
 for(const [index,db] of [storage.db,storage.db2].entries()){
  const app=await createEnterpriseApp({db,keys:featureKeys,env:featureEnv({INSTANCE_ID:'v4-http-'+index}),petFetchImpl:provider.fetch});
  apps.push(await startFeatureServer(app));
 }
 return {...storage,provider,apps,request:featureHttp(apps)};
});
