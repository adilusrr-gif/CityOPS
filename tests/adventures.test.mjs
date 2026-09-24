import {openDb} from '../src/db.mjs';
import {adventureSuite} from './helpers/adventure-suite.mjs';
adventureSuite('SQLite adventures',async t=>{const db=openDb(':memory:',{withSnapshot:false});t.after(()=>db.close());return{db,dialect:'sqlite'};});
