import {pathToFileURL} from 'node:url';
import {openPostgres,migratePostgres,seedPostgres} from '../src/enterprise/db.mjs';

export async function main(argv=process.argv.slice(2)) {
 if(argv.some(arg=>!['--seed','--help'].includes(arg)))throw new Error('Unknown option. Usage: node scripts/migrate-postgres.mjs [--seed]');
 if(argv.includes('--help')){console.log('Usage: node --env-file=.env.production scripts/migrate-postgres.mjs [--seed]\nRuns PostgreSQL schema migrations. --seed initializes both cities in an empty database and adds new editorial adventure/photo seeds to initialized databases without overwriting edits.\nFor SQLite cutover, omit --seed before import-sqlite-postgres.mjs; run --seed after a successful import if new editorial content is wanted.');return;}
 const db=await openPostgres();
 try {
  const migration=await migratePostgres(db);
  const seed=argv.includes('--seed')?await seedPostgres(db):undefined;
  console.log(JSON.stringify({migration,...(seed?{seed}:{})}));
 }finally{await db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(`PostgreSQL migration failed: ${error.message}`);process.exitCode=1;});
