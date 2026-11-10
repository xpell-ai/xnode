import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import * as XNode from '../dist/index.js';
import { _x, _xem, bindEntityLocalUnit, ENTITY_LOCAL_UNIT_HASH_CAPABILITIES as capabilities } from '../dist/index.js';
import { XEntityManager } from '../dist/XEntityManager/XEntityManager.js';

const policy = 'create-and-preserve-v1';
const ack = { _version: 1, _policy: policy, _create: 'provider-bcrypt-10', _update: 'preserve-existing-hash', _prehashed_create: 'reject' };
const secret = () => 'synthetic:' + randomUUID();
const work = mkdtempSync(path.join(tmpdir(), 'xnode-hash-'));
const manager = new XEntityManager({ _provider_runtime_context: { _work_folder: work, _sqlite_require_full_durability: true } });
await _x.loadModuleAsync(manager);
after(() => rmSync(work, { recursive: true, force: true }));
async function fixture(t, extra = {}) {
  const scope = { _env: 'default', _app_id: 'synthetic-hash-' + randomUUID() };
  const command = (op, params) => _x.execute({ _module: 'entity-manager', _op: op, _params: { ...scope, ...params } });
  const names = ['account', 'user', 'ledger', 'operation', 'audit'];
  const definitions = names.map(_id => ({ _id, _storage: { _provider: 'sqlite', _scope: 'app',
    ...(['ledger', 'audit'].includes(_id) ? { _append_only: true } : {}) },
    _schema: { value: { _type: 'String', _required: true, _index: { _unique: true }, _max_length: 65000 },
      ...( _id === 'user' ? { password: { _type: 'Hash', _required: true }, recovery: { _type: 'hAsH' } } : {}),
      _state: { _type: 'String' }, _owner_id: { _type: 'String' }, _owner_epoch: { _type: 'Number' },
      _version: { _type: 'Number' }, _lease_expires_at: { _type: 'Number' } } }));
  for (const def of definitions) assert.equal((await command('register', { _entity: def }))._ok, true);
  const options = { ...scope, _entities: names.map(_entity => ({ _entity, _write: true })),
    _capacity_profile: 'expanded-v1', _hash_policy: policy, _clock: () => 1000, ...extra };
  const bound = await bindEntityLocalUnit(options);
  t.after(async () => { for (const name of names) await command('unregister', { _entity: name }); });
  const unit = (password = secret()) => ({ _unit_id: randomUUID(), _records: names.map(_entity => {
    const _id = randomUUID(); return { _entity, _id, _expect: null, _create: { _id, value: randomUUID(), ...(_entity === 'user' ? { password } : {}) } };
  }) });
  const read = async op => (await command('get', { _entity: op._entity, _id: op._id }))._result._record;
  const absent = async u => { for (const op of u._records) assert.equal(await read(op), null); };
  return { work, manager, command, options, bound, unit, read, absent, definitions };
}
const failed = (r, code) => { assert.equal(r._ok, false); if (code) assert.equal(r._result._code, code); };

test('independent deeply frozen Hash descriptor and exact opt-in acknowledgements fail closed', async t => {
  assert.deepEqual(capabilities, { _version: 1, _policies: { [policy]: {
    _create: ack._create, _update: ack._update, _prehashed_create: ack._prehashed_create } } });
  const f = await fixture(t);
  for (const value of [capabilities, capabilities._policies, capabilities._policies[policy], f.bound, f.bound._hash]) assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(f.bound._hash, ack);
  const negotiate = (c, b) => { assert.deepEqual(c, capabilities); assert.deepEqual(b?._hash, ack); };
  for (const [c,b] of [[undefined,f.bound],[{...capabilities,_version:0},f.bound],[capabilities,{}],[capabilities,{_hash:{...ack,_create:'caller-hash'}}]]) assert.throws(() => negotiate(c,b));
  const r = await f.bound.commit(f.unit()); assert.equal(r._ok, true); negotiate(capabilities, r._result);
  assert.deepEqual(r._result._capacity, f.bound._capacity);
  assert.deepEqual(r._result._durability, { _journal_mode: 'wal', _synchronous: 2, _foreign_keys: 1 });
  const before = f.manager._local_units.size;
  for (const _hash_policy of [null,'',{},'toString','__proto__','create-and-preserve-v2']) {
    await assert.rejects(bindEntityLocalUnit({...f.options,_hash_policy}), e => e._code === 'E_ENTITY_LOCAL_UNIT_HASH_POLICY');
    assert.equal(f.manager._local_units.size,before);
  }
});

test('default bindings reject Hash creates and profile writes, but permit full Hash read guards', async t => {
  const f = await fixture(t, { _hash_policy: undefined });
  assert.equal(Object.hasOwn(f.bound, '_hash'), false);
  const u = f.unit(); u._records = u._records.slice(0,2);
  failed(await f.bound.commit(u), 'E_ENTITY_LOCAL_UNIT_SCHEMA'); await f.absent(u);
  const seed = (await f.command('add',{_entity:'user',_data:{value:randomUUID(),password:secret()}}))._result._record;
  failed(await f.bound.commit({_unit_id:randomUUID(),_records:[{_entity:'user',_id:seed._id,_expect:seed,_update:{value:randomUUID()}}]}),'E_ENTITY_LOCAL_UNIT_SCHEMA');
  const r=await f.bound.commit({_unit_id:randomUUID(),_records:[{_entity:'user',_id:seed._id,_expect:seed}]});
  assert.equal(r._ok,true); assert.equal(Object.hasOwn(r._result,'_hash'),false);
});

test('provider bcrypt creation, ordinary bcrypt compatibility, profile preservation and sanitized events', async t => {
  const f=await fixture(t), password=secret(), recovery=secret(), u=f.unit(password);
  u._records[1]._create.recovery=recovery;
  const events=[]; const listener=_xem.on('xdb:create',v=>events.push(v));
  t.after(()=>_xem.remove(listener));
  assert.equal((await f.bound.commit(u))._ok,true);
  const op=u._records[1], before=await f.read(op);
  assert.equal(bcrypt.getRounds(before.password),10); assert.equal(await bcrypt.compare(password,before.password),true);
  assert.equal(await bcrypt.compare(recovery,before.recovery),true);
  const event=events.find(v=>v._entity==='user'); assert.ok(event); assert.equal(Object.hasOwn(event._record,'password'),false); assert.equal(Object.hasOwn(event._record,'recovery'),false);
  const r=await f.bound.commit({_unit_id:randomUUID(),_records:[{_entity:'user',_id:op._id,_expect:before,_update:{value:randomUUID()}}]});
  assert.equal(r._ok,true); const after=await f.read(op); assert.equal(after.password,before.password); assert.equal(after.recovery,before.recovery);
  for (const value of [secret(),null,before.password]) {
    failed(await f.bound.commit({_unit_id:randomUUID(),_records:[{_entity:'user',_id:op._id,_expect:after,_update:{password:value}}]}),'E_ENTITY_LOCAL_UNIT_HASH_MUTATION');
    assert.deepEqual(await f.read(op),after);
  }
  const ordinary=await f.command('add',{_entity:'user',_data:{value:randomUUID(),password:before.password}});
  assert.equal(ordinary._ok,true); assert.equal(ordinary._result._record.password,before.password);
});

test('prehashed, invalid, truncated, missing and default plaintext credentials cannot enter atomic storage', async t => {
  const f=await fixture(t);
  const encoded=await bcrypt.hash(secret(),10);
  for (const value of [encoded,'$2y$10$invalid','$2x$10$invalid','$argon2id$v=19$invalid','{SHA}encoded','a'.repeat(64),'',null,12,{},'א'.repeat(37)]) {
    const u=f.unit(value); failed(await f.bound.commit(u),'E_ENTITY_LOCAL_UNIT_HASH_INPUT'); await f.absent(u);
  }
  const missing=f.unit(); delete missing._records[1]._create.password; failed(await f.bound.commit(missing),'E_ENTITY_LOCAL_UNIT_HASH_INPUT');
  const u=f.unit(); u._records[1]._create.recovery=null; failed(await f.bound.commit(u),'E_ENTITY_LOCAL_UNIT_HASH_INPUT');
  const def=structuredClone(f.definitions[1]); def._schema.recovery._default=secret();
  assert.equal((await f.command('register',{_entity:def}))._ok,true);
  const bound=await bindEntityLocalUnit(f.options); failed(await bound.commit(f.unit()),'E_ENTITY_LOCAL_UNIT_HASH_INPUT');
});

test('Hash authority cannot be selected through units, commands, transport context or mutable bootstrap input', async t => {
  const f=await fixture(t,{_hash_policy:undefined}), key=[...f.manager._local_units.keys()].at(-1);
  f.options._hash_policy=policy;
  failed(await f.bound.commit(f.unit()),'E_ENTITY_LOCAL_UNIT_SCHEMA');
  for (const extra of [{_hash_policy:policy},{_hash:ack}]) {
    failed(await f.bound.commit({...f.unit(),...extra}));
    failed(await _x.execute({_module:'entity-manager',_op:'commit-local-unit',_params:{_local_unit_key:key,_unit:f.unit(),...extra}}),'E_ENTITY_LOCAL_UNIT_UNAUTHORIZED');
  }
  failed(await _x.execute({_module:'entity-manager',_op:'commit-local-unit',_ctx:{_sid:'synthetic'},_params:{_local_unit_key:key,_unit:f.unit()}}),'E_ENTITY_LOCAL_UNIT_UNAUTHORIZED');
  const reader=await bindEntityLocalUnit({...f.options,_entities:f.options._entities.map(e=>({...e,_write:false}))});
  failed(await reader.commit(f.unit()),'E_ENTITY_LOCAL_UNIT_UNAUTHORIZED');
});

test('raw, prepared and result byte budgets and all non-Hash equality checks remain strict', async t => {
  const f=await fixture(t);
  const coercion=f.unit(); coercion._records[0]._create.value=17; failed(await f.bound.commit(coercion)); await f.absent(coercion);
  const truncated=f.unit(); truncated._records[0]._create.value='x'.repeat(65001); failed(await f.bound.commit(truncated));
  const prepared=f.unit('short'); prepared._records[0]._create.value='';
  prepared._records[0]._create.value='x'.repeat(65536-Buffer.byteLength(JSON.stringify(prepared)));
  failed(await f.bound.commit(prepared)); await f.absent(prepared);
  const result=f.unit(); result._records[0]._create.value='';
  const anticipated=result._records.map(op=>({_entity:op._entity,_record:{...op._create,...(op._entity==='user'?{password:'h'.repeat(60)}:{}),_created_at:new Date(1000).toISOString(),_updated_at:new Date(1000).toISOString()}}));
  result._records[0]._create.value='x'.repeat(65537-Buffer.byteLength(JSON.stringify(anticipated)));
  assert.ok(Buffer.byteLength(JSON.stringify(result))<65536);
  failed(await f.bound.commit(result)); await f.absent(result);
  for(const profile of ['standard-v1','expanded-v1']) {
    const bound=await bindEntityLocalUnit({...f.options,_capacity_profile:profile});
    const u=f.unit(); if(profile==='expanded-v1') {const id=randomUUID();u._records.push({_entity:'account',_id:id,_expect:null,_create:{_id:id,value:randomUUID()}});}
    failed(await bound.commit(u));
  }
});

for(const point of ['after_write_1','after_write_2','after_write_3','after_write_4','after_write_5','before_commit']) test(`Hash five-write native failure at ${point} rolls back all rows`,async t=>{
  const f=await fixture(t,{_fault:p=>{if(p===point)throw Error('synthetic native failure');}}),u=f.unit();
  failed(await f.bound.commit(u)); await f.absent(u);
});

test('Hash uniqueness conflicts, full CAS conflicts and concurrent creates have no partial financial rows',async t=>{
  const f=await fixture(t),u=f.unit();
  const results=await Promise.all([f.bound.commit(u),f.bound.commit(u)]); assert.equal(results.filter(r=>r._ok).length,1);
  const collision=f.unit();collision._records[4]._create.value=u._records[4]._create.value;
  failed(await f.bound.commit(collision),'E_ENTITY_LOCAL_UNIT_CONSTRAINT');await f.absent(collision);
  const stale=f.unit();stale._records.push({_entity:'user',_id:u._records[1]._id,_expect:{...await f.read(u._records[1]),value:'stale'}});
  failed(await f.bound.commit(stale),'E_ENTITY_LOCAL_UNIT_CONFLICT');await f.absent({_records:stale._records.slice(0,5)});
});

// Pause the real bcrypt preparation, then change state before the native writer opens.
for(const change of ['cas','lease','expiry','registration','schema']) test(`Hash preparation revalidates ${change} inside the transaction`,async t=>{
  let now=1000;const f=await fixture(t,{_clock:()=>now}),u=f.unit();
  const seed=(await f.command('add',{_entity:'operation',_data:{value:randomUUID(),_state:'claimed',_owner_id:randomUUID(),_owner_epoch:1,_version:1,_lease_expires_at:2000}}))._result._record;
  u._records.push({_entity:'operation',_id:seed._id,...(change==='lease'?{}:{_expect:seed})});
  if(change==='lease')u._lease={_entity:'operation',_id:seed._id,_owner_id:seed._owner_id,_owner_epoch:1,_version:1};
  if(change==='expiry')u._valid_until=1500;
  let started,release;const pending=new Promise(r=>started=r), gate=new Promise(r=>release=r),original=bcrypt.genSalt;
  bcrypt.genSalt=async(...args)=>{started();await gate;return original(...args);};
  const committing=f.bound.commit(u);await pending;
  try{
    if(['cas','lease'].includes(change))assert.equal((await f.command('update',{_entity:'operation',_filter:{_id:seed._id},_updates:{_version:2}}))._ok,true);
    if(change==='expiry')now=1600;
    if(change==='registration'){await f.command('unregister',{_entity:'account'});await f.command('register',{_entity:f.definitions[0]});}
    if(change==='schema'){const def=structuredClone(f.definitions[0]);def._schema.extra={_type:'String'};await f.command('register',{_entity:def});}
  }finally{bcrypt.genSalt=original;release();}
  failed(await committing);await f.absent({_records:u._records.slice(0,5)});
});

test('no plaintext or fast proposal digest in SQLite/WAL, receipts, logs, errors or events',async t=>{
  const f=await fixture(t),password=secret(),u=f.unit(password),output=[];
  for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>output.push(JSON.stringify(args)));
  const listener=_xem.on('xdb:create',v=>output.push(JSON.stringify(v)));t.after(()=>_xem.remove(listener));
  output.push(JSON.stringify(await f.bound.commit(u)));
  const original=bcrypt.hash;bcrypt.hash=async()=>{throw Error(password);};
  try{output.push(JSON.stringify(await f.bound.commit(f.unit(password))));}finally{bcrypt.hash=original;}
  const raw=JSON.stringify(u);
  const forbidden=[password,...['sha256','sha1','md5'].flatMap(algorithm=>[password,raw].map(v=>createHash(algorithm).update(v).digest('hex')))];
  for(const file of readdirSync(path.join(f.work,'xdb'))) {
    const bytes=readFileSync(path.join(f.work,'xdb',file));
    for(const value of forbidden)assert.equal(bytes.includes(Buffer.from(value)),false,'durable leakage');
  }
  const text=output.join('\n');for(const value of forbidden)assert.equal(text.includes(value),false,'output leakage');
  for(const op of u._records.filter(r=>['audit','operation','ledger'].includes(r._entity)))for(const value of forbidden)assert.equal(JSON.stringify(await f.read(op)).includes(value),false,'receipt leakage');
});

test('explicit standard Hash creation retains the four-write limit and independent acknowledgements',async t=>{
  const f=await fixture(t,{_capacity_profile:'standard-v1'}),u=f.unit();u._records.pop();
  const result=await f.bound.commit(u);assert.equal(result._ok,true);assert.deepEqual(result._result._hash,ack);
  assert.deepEqual(result._result._capacity._limits,{_records:8,_writes:4,_entities:8,_bytes:65536});
  const implicit=await bindEntityLocalUnit({...f.options,_capacity_profile:undefined}),single=f.unit();single._records=single._records.slice(1,2);
  assert.deepEqual(implicit._hash,ack);assert.equal(Object.hasOwn(implicit,'_capacity'),false);
  const r=await implicit.commit(single);assert.equal(r._ok,true);assert.deepEqual(r._result._hash,ack);assert.equal(Object.hasOwn(r._result,'_capacity'),false);
});

// The same native cases can be run against the prior immutable artifact. That
// explicit baseline mode skips only the new API assertions, never native cases.
const legacyPreflightBaseline = process.env.XNODE_HASH_PREFLIGHT_LEGACY === '1';
const preflight = XNode.assertEntityLocalUnitHashCreateInput;
if (legacyPreflightBaseline) {
  assert.equal(preflight, undefined);
  assert.equal(XNode.ENTITY_LOCAL_UNIT_HASH_INPUT_CAPABILITIES, undefined);
}
const inputCapabilities = { _version: 1, _policies: { [policy]: { _create: 'strict-plaintext-v1' } } };
const onlyPreflight = { skip: legacyPreflightBaseline ? 'Prior immutable runtime has no preflight API' : false };
const storageBytes = directory => Object.fromEntries(readdirSync(directory).sort().map(name =>
  [name, createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')]));

test('separate frozen input contract negotiates exact support without changing old descriptors or acknowledgements', onlyPreflight, async t => {
  const negotiate = runtime => {
    const value = runtime.ENTITY_LOCAL_UNIT_HASH_INPUT_CAPABILITIES;
    assert.deepEqual(value, inputCapabilities);
    for (const layer of [value, value._policies, value._policies[policy]]) assert.equal(Object.isFrozen(layer), true);
    assert.equal(typeof runtime.assertEntityLocalUnitHashCreateInput, 'function');
    return runtime.assertEntityLocalUnitHashCreateInput;
  };
  assert.equal(negotiate(XNode), preflight);
  const frozen = XNode.ENTITY_LOCAL_UNIT_HASH_INPUT_CAPABILITIES;
  assert.throws(() => { frozen._version = 9; }, TypeError);
  assert.throws(() => { frozen._policies[policy]._create = 'caller-hash'; }, TypeError);
  for (const value of [undefined, null, {}, {...frozen, _version: 0}, {...frozen, _version: 2},
    {...frozen, _policies: {}}, structuredClone(frozen), Object.freeze({...frozen, _policies: Object.freeze({[policy]: {...frozen._policies[policy]}})})]) {
    assert.throws(() => negotiate({...XNode, ENTITY_LOCAL_UNIT_HASH_INPUT_CAPABILITIES: value}));
  }
  assert.throws(() => negotiate({...XNode, assertEntityLocalUnitHashCreateInput: undefined}));
  const f = await fixture(t), result = await f.bound.commit(f.unit());
  assert.deepEqual(f.bound._hash, ack); assert.deepEqual(result._result._hash, ack);
  assert.deepEqual(Object.keys(f.bound).sort(), ['_app_id','_capacity','_env','_hash','commit']);
  assert.deepEqual(Object.keys(result._result).sort(), ['_capacity','_durability','_hash','_records']);
});

const inputCases = [
  ['ordinary-plaintext', 'synthetic:ordinary', true],
  ['single-character', 'x', true],
  ['whitespace-is-not-normalized', ' '.repeat(72), true],
  ['embedded-NUL', 'synthetic\0value', true],
  ['OPS1-48-character-bare-hex', 'ab'.repeat(24), false],
  ['MD5-shaped', 'a'.repeat(32), false],
  ['SHA1-shaped', 'a'.repeat(40), false],
  ['SHA256-shaped', 'a'.repeat(64), false],
  ['uppercase-hex', 'AB'.repeat(24), false],
  ['31-character-hex-is-plaintext', 'a'.repeat(31), true],
  ['72-character-bare-hex', 'a'.repeat(72), false],
  ['128-character-bare-hex', 'a'.repeat(128), false],
  ['bcrypt-2a-looking', '$2a$10$synthetic', false],
  ['bcrypt-2b-looking', '$2b$10$synthetic', false],
  ['bcrypt-2y-looking', '$2y$10$synthetic', false],
  ['argon2id-looking', '$argon2id$v=19$synthetic', false],
  ['unsupported-numeric-modular-looking', '$9$synthetic', false],
  ['unsupported-named-modular-looking', '$unknown$synthetic', false],
  ['uppercase-modular-looking', '$ARGON2ID$synthetic', false],
  ['unterminated-modular-prefix-is-plaintext', '$2b', true],
  ['hyphenated-prefix-is-plaintext-under-current-policy', '$not-a-format$synthetic', true],
  ['SHA-wrapper', '{SHA}synthetic', false],
  ['SSHA-wrapper', '{SSHA}synthetic', false],
  ['SHA256-wrapper', '{SHA256}synthetic', false],
  ['MD5-wrapper', '{MD5}synthetic', false],
  ['SMD5-wrapper', '{sMd5}synthetic', false],
  ['unknown-wrapper-is-plaintext-under-current-policy', '{UNKNOWN}synthetic', true],
  ['leading-space-hex-is-not-trimmed', ' ' + 'a'.repeat(64), true],
  ['empty', '', false], ['null', null, false], ['number', 12, false],
  ['boolean', false, false], ['object', {}, false], ['array', [], false],
  ['explicit-undefined', undefined, false, true],
  ['boxed-string', new String('synthetic'), false, true],
  ['symbol', Symbol('synthetic'), false, true], ['bigint', 1n, false, true],
  ['71-ASCII-bytes', 'x'.repeat(71), true], ['72-ASCII-bytes', 'x'.repeat(72), true],
  ['73-ASCII-bytes', 'x'.repeat(73), false],
  ['72-two-byte-UTF8', 'é'.repeat(36), true], ['74-two-byte-UTF8', 'é'.repeat(37), false],
  ['72-three-byte-UTF8', '€'.repeat(24), true], ['73-mixed-UTF8', '€'.repeat(24) + 'x', false],
  ['72-four-byte-UTF8', '😀'.repeat(18), true], ['76-four-byte-UTF8', '😀'.repeat(19), false],
];
for (const [label, value, accepted, nonJSON] of inputCases) test(`Hash create input ${label} agrees with preserved native preparation`, async t => {
  const f = await fixture(t), directory = path.join(f.work, 'xdb'), before = storageBytes(directory);
  if (!legacyPreflightBaseline) {
    if (accepted) assert.equal(preflight(policy, value), undefined);
    else assert.throws(() => preflight(policy, value), error => error._code === 'E_ENTITY_LOCAL_UNIT_HASH_INPUT');
    assert.deepEqual(storageBytes(directory), before, 'Preflight must not change or create storage files');
  }
  const unit = f.unit(); unit._records[1]._create.password = value;
  const result = await f.bound.commit(unit);
  assert.equal(result._ok, accepted, 'Native and preflight admissibility must match the preserved expectation');
  if (accepted) {
    const user = await f.read(unit._records[1]);
    assert.equal(bcrypt.getRounds(user.password), 10); assert.equal(await bcrypt.compare(value, user.password), true);
  } else {
    failed(result, nonJSON ? undefined : 'E_ENTITY_LOCAL_UNIT_HASH_INPUT');
    await f.absent(unit);
  }
});

test('preflight rejects unknown policy without coercion, hashing, output leaks or storage effects', onlyPreflight, async t => {
  const f = await fixture(t), password = secret(), output = [], before = storageBytes(path.join(f.work, 'xdb'));
  for (const method of ['log','warn','error','debug']) t.mock.method(console, method, (...args) => output.push(JSON.stringify(args)));
  const salt = t.mock.method(bcrypt, 'genSalt', () => { throw Error('Hashing is forbidden in preflight'); });
  const hash = t.mock.method(bcrypt, 'hash', () => { throw Error('Hashing is forbidden in preflight'); });
  let coercions = 0; const coercible = {toString() {coercions++; return password;}, [Symbol.toPrimitive]() {coercions++; return password;}};
  for (const invalidPolicy of [undefined, null, '', 'create-and-preserve-v2', {}, coercible]) {
    assert.throws(() => preflight(invalidPolicy, password), error => {
      assert.equal(JSON.stringify(error).includes(password), false); return error._code === 'E_ENTITY_LOCAL_UNIT_HASH_POLICY';
    });
  }
  assert.throws(() => preflight(policy, coercible), error => error._code === 'E_ENTITY_LOCAL_UNIT_HASH_INPUT');
  assert.equal(preflight(policy, password), undefined); assert.equal(coercions, 0);
  assert.equal(salt.mock.callCount(), 0); assert.equal(hash.mock.callCount(), 0); assert.deepEqual(output, []);
  assert.deepEqual(storageBytes(path.join(f.work, 'xdb')), before);
});

test('preflight grants no commit ticket: native input, concurrency and full CAS are checked again', onlyPreflight, async t => {
  const f = await fixture(t), value = secret(); assert.equal(preflight(policy, value), undefined);
  const changed = f.unit(value); changed._records[1]._create.password = 'ab'.repeat(24);
  failed(await f.bound.commit(changed), 'E_ENTITY_LOCAL_UNIT_HASH_INPUT'); await f.absent(changed);
  const unit = f.unit(value), results = await Promise.all([f.bound.commit(unit), f.bound.commit(unit)]);
  assert.equal(results.filter(r => r._ok).length, 1);
  const stale = f.unit(value), stored = await f.read(unit._records[1]);
  stale._records.push({_entity:'user',_id:stored._id,_expect:{...stored,value:'stale'}});
  failed(await f.bound.commit(stale), 'E_ENTITY_LOCAL_UNIT_CONFLICT'); await f.absent({_records:stale._records.slice(0,5)});
});

test('supplied-input preflight does not change optional omission or profile-only preservation', onlyPreflight, async t => {
  const f = await fixture(t), definition = structuredClone(f.definitions[1]); delete definition._schema.password._required;
  assert.equal((await f.command('register', {_entity:definition}))._ok, true);
  const bound = await bindEntityLocalUnit(f.options), omitted = f.unit(); delete omitted._records[1]._create.password;
  assert.throws(() => preflight(policy, undefined), error => error._code === 'E_ENTITY_LOCAL_UNIT_HASH_INPUT');
  assert.equal((await bound.commit(omitted))._ok, true); assert.equal((await f.read(omitted._records[1])).password, undefined);
  const plaintext = secret(), unit = f.unit(plaintext); preflight(policy, plaintext); assert.equal((await bound.commit(unit))._ok, true);
  const before = await f.read(unit._records[1]);
  const updated = await bound.commit({_unit_id:randomUUID(),_records:[{_entity:'user',_id:before._id,_expect:before,_update:{value:randomUUID()}}]});
  assert.equal(updated._ok,true); assert.equal((await f.read(unit._records[1])).password,before.password);
});
