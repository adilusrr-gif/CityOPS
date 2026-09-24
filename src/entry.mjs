import {VERSION} from './version.mjs';
import {createEnterpriseApp} from './enterprise/server.mjs';
import {createApp,bootstrapAdmin} from './server.mjs';

const enterprise=!!process.env.DATABASE_URL;
const app=enterprise?await createEnterpriseApp():createApp();
if(!enterprise){const admin=bootstrapAdmin(app.db);if(admin)app.audit(admin,'bootstrap.admin',admin);}
const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be 1..65535');
app.server.listen(port,host,()=>console.log(JSON.stringify({event:'listening',host,port,deployment:enterprise?'postgresql-shared':'sqlite-local',version:VERSION})));
let stopping=false;
const stop=async()=>{
 if(stopping)return;stopping=true;app.beginDrain();
 const force=setTimeout(()=>app.server.closeAllConnections(),10000);force.unref();
 app.server.closeIdleConnections();
 try{await app.close();clearTimeout(force);process.exitCode=0;}
 catch(e){console.error(JSON.stringify({event:'shutdown_failed',name:e.name}));process.exitCode=1;}
};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
