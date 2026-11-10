import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {ENTITY_HISTORICAL_IMPORT_CAPABILITIES as capabilities, ENTITY_HISTORICAL_IMPORT_RUNTIME as runtime} from '../dist/index.js';
import {localUnitCanonical,localUnitHash} from '../dist/XEntityManager/EntityLocalUnit.js';
export {localUnitCanonical as canonical,localUnitHash as hash};
export async function makeSource(destination, profile='expanded-v1', count=4) {
 const names=['account','user','ledger','operation','catalog0','catalog1','catalog2','catalog3','catalog4','catalog5','catalog6','catalog7','catalog8'];
 const password='synthetic:'+randomUUID(),passwordHash=await bcrypt.hash(password,10);
 const definitions=names.map(_id=>({_id,_storage:{_provider:'sqlite',_scope:'app',...(_id==='ledger'?{_append_only:true}:{})},_schema:{
   value:{_type:'String',_required:true,_index:{_unique:true}},details:{_type:'Object'},flag:{_type:'Boolean'},amount:{_type:'Number',_min:0},
   _state:{_type:'String'},_owner_id:{_type:'String'},_owner_epoch:{_type:'Number'},_version:{_type:'Number'},_lease_expires_at:{_type:'Number'},
   ...(_id==='user'?{password:{_type:'Hash',_required:true},account_id:{_type:'ObjectId'}}:{})}}));
 const records=names.slice(0,count).map((_entity,i)=>({_entity,_record:{_id:randomUUID(),value:randomUUID(),details:{nested:['original',i]},flag:false,amount:i,
  _created_at:'2020-01-01T01:02:03.004Z',_updated_at:'2021-02-03T04:05:06.007Z',...(_entity==='user'?{password:passwordHash}:{})}}));
 if(records[1]?._entity==='user')records[1]._record.account_id=records[0]._record._id;
 const refs=records.map(r=>({_entity:r._entity,_id:r._record._id,_sha256:localUnitHash(r._record)})).sort((a,b)=>{const x=localUnitCanonical([a._entity,a._id]),y=localUnitCanonical([b._entity,b._id]);return x<y?-1:x>y?1:0;});
 const manifest={_version:1,_run_id:randomUUID(),_destination_id:randomUUID(),_source_id:randomUUID(),_source_root:localUnitHash({frozen:'synthetic',id:randomUUID()}),
  _record_root:localUnitHash(refs),_captured_at:'2022-01-01T00:00:00.000Z',_env:'default',_app_id:'synthetic-historical',_runtime:runtime,
  _entities:definitions.map(d=>({_entity:d._id,_schema_sha256:localUnitHash(d),_records:refs.filter(r=>r._entity===d._id).map(({_id,_sha256})=>({_id,_sha256}))}))};
 return {options:{_destination:destination,_manifest:manifest,_manifest_sha256:localUnitHash(manifest),_expected_capability:capabilities,_entities:definitions,_capacity_profile:profile,_clock:()=>Date.parse('2023-01-01T00:00:00.000Z')},records,password};
}
export const batch=records=>({_records:records.map(r=>({_entity:r._entity,_id:r._record._id,_expect:null,_create:structuredClone(r._record)}))});
