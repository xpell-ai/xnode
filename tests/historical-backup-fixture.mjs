import {randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';
import {makeSource,batch,hash} from './historical-import-fixture.mjs';
import {ENTITY_HISTORICAL_IMPORT_BACKUP_CAPABILITIES as capability} from '../dist/index.js';
export async function backupSource(root) {
 const f=await makeSource(path.join(root,'original'),'expanded-v1',13);
 // All eighteen approved application tables, including five empty new evidence types.
 for(let i=0;i<5;i++) {
  const def=structuredClone(f.options._entities[2]);def._id='empty-evidence-'+i;f.options._entities.push(def);
  f.options._manifest._entities.push({_entity:def._id,_schema_sha256:hash(def),_records:[]});
 }
 f.options._manifest_sha256=hash(f.options._manifest);
 f.units=[];for(let i=0;i<f.records.length;i+=4)f.units.push(batch(f.records.slice(i,i+4)));
 f.key=randomBytes(32);f.backup=path.join(root,'backup');f.restored=path.join(root,'restored');f.restoreID=randomUUID();
 f.backupOptions=owner=>({_owner:owner,_destination:f.backup,_units:f.units,_key_id:'synthetic-v1',_key:f.key,_expected_capability:capability});
 f.restoreOptions=()=>({...f.options,_destination:f.restored,_backup:f.backup,_restore_id:f.restoreID,
  _units:f.units,_key_id:'synthetic-v1',_key:f.key,_expected_capability:capability});
 return f;
}
