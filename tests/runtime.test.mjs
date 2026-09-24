import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimeConfig, clientIp} from '../src/runtime.mjs';

const memory = {aqPath: ':memory:'};
const encryption = '11'.repeat(32), audit = '22'.repeat(32);
const production = {NODE_ENV: 'production', COOKIE_SECURE: 'true', PUBLIC_ORIGIN: 'https://quest.example.test', DATA_ENCRYPTION_KEY: encryption, AUDIT_HMAC_KEY: audit};

test('idle timeout rejects non-finite and out-of-range configuration in every environment', () => {
  assert.equal(runtimeConfig(memory, {env: {}}).idleMs, 1800000);
  for (const [minutes, ms] of [['1', 60000], ['1.5', 90000], ['1440', 86400000]]) {
    assert.equal(runtimeConfig(memory, {env: {SESSION_IDLE_MINUTES: minutes}}).idleMs, ms);
  }
  for (const invalid of ['', ' ', 'NaN', 'Infinity', '-Infinity', 'abc', '0', '-1', '0.5', '1440.1']) {
    for (const env of [{}, production]) assert.throws(() => runtimeConfig(memory, {env: {...env, SESSION_IDLE_MINUTES: invalid}}), /SESSION_IDLE_MINUTES/);
  }
});

test('explicit development keys must be valid and supplied as a pair even for memory databases', () => {
  for (const env of [{DATA_ENCRYPTION_KEY: encryption}, {AUDIT_HMAC_KEY: audit}, {DATA_ENCRYPTION_KEY: '', AUDIT_HMAC_KEY: audit}]) {
    assert.throws(() => runtimeConfig(memory, {env}), /supplied together/);
  }
  for (const env of [{DATA_ENCRYPTION_KEY: 'bad', AUDIT_HMAC_KEY: audit}, {DATA_ENCRYPTION_KEY: encryption, AUDIT_HMAC_KEY: 'bad'}]) {
    assert.throws(() => runtimeConfig(memory, {env}), /64 hexadecimal/);
  }
  const configured = runtimeConfig(memory, {env: {DATA_ENCRYPTION_KEY: encryption, AUDIT_HMAC_KEY: audit}});
  assert.equal(configured.keys.encryptionKey.toString('hex'), encryption);
  assert.equal(configured.keys.auditKey.toString('hex'), audit);
});

test('invalid explicit keys never silently fall back to persisted development keys', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cq-runtime-'));
  try {
    const keyPath = join(folder, 'keys.json'), db = {aqPath: join(folder, 'db.sqlite')}, base = {SECURITY_KEYS_PATH: keyPath};
    assert.throws(() => runtimeConfig(db, {env: {...base, DATA_ENCRYPTION_KEY: encryption}}), /supplied together/);
    assert.equal(existsSync(keyPath), false);
    const first = runtimeConfig(db, {env: base}), bytes = readFileSync(keyPath);
    const second = runtimeConfig(db, {env: base});
    assert.deepEqual(second.keys, first.keys);
    assert.throws(() => runtimeConfig(db, {env: {...base, DATA_ENCRYPTION_KEY: 'invalid', AUDIT_HMAC_KEY: audit}}), /64 hexadecimal/);
    assert.deepEqual(readFileSync(keyPath), bytes);
    writeFileSync(keyPath, JSON.stringify({DATA_ENCRYPTION_KEY: encryption}));
    assert.throws(() => runtimeConfig(db, {env: base}), /must contain both/);
  } finally {rmSync(folder, {recursive: true, force: true});}
});

test('proxy trust configuration is validated consistently and only trusts the direct loopback peer', () => {
  for (const env of [{}, production]) {
    for (const invalid of ['', 'true', 'all', '*', '1', 'LOOPBACK']) assert.throws(() => runtimeConfig(memory, {env: {...env, TRUST_PROXY: invalid}}), /TRUST_PROXY/);
    for (const valid of ['none', 'loopback']) assert.equal(runtimeConfig(memory, {env: {...env, TRUST_PROXY: valid}}).trustProxy, valid);
  }
  const request = (remote, forwarded) => ({socket: {remoteAddress: remote}, headers: {'x-forwarded-for': forwarded}});
  assert.equal(clientIp(request('127.0.0.1', '198.51.100.10, 203.0.113.7'), 'loopback'), '203.0.113.7');
  assert.equal(clientIp(request('198.51.100.10', '203.0.113.7'), 'loopback'), '198.51.100.10');
  assert.equal(clientIp(request('127.0.0.1', 'invalid'), 'loopback'), '127.0.0.1');
  assert.equal(clientIp(request('127.0.0.1', '203.0.113.7'), 'none'), '127.0.0.1');
});

test('operator transport limits, map sources and public contacts are validated without exposing secrets',()=>{
 const cfg=runtimeConfig(memory,{env:{MAP_STYLE:'https://maps.operator.kz/styles/dark.json',MAP_RESOURCE_ORIGINS:'https://tiles.operator.kz, https://fonts.operator.kz',SUPPORT_EMAIL:'help@operator.kz',PRIVACY_URL:'https://operator.kz/privacy',TERMS_URL:'https://operator.kz/terms',HTTP_BODY_TIMEOUT_MS:'60000'}});
 assert.equal(cfg.http.bodyTimeoutMs,60000);assert.deepEqual(cfg.mapOrigins,['https://tiles.openfreemap.org','https://maps.operator.kz','https://tiles.operator.kz','https://fonts.operator.kz']);assert.equal(cfg.contacts.supportEmail,'help@operator.kz');assert(!('keys' in cfg.contacts));
 assert.equal(runtimeConfig(memory,{env:{MAP_RESOURCE_ORIGINS:'  '}}).mapOrigins.length,1);
 for(const [name,value] of [['HTTP_MAX_INFLIGHT','0'],['HTTP_JSON_LIMIT_KB','257'],['HTTP_BODY_TIMEOUT_MS','NaN'],['HTTP_RESPONSE_TIMEOUT_MS','0'],['HTTP_UPLOAD_CONCURRENCY','9'],['PASSWORD_KDF_CONCURRENCY','0'],['RATE_LIMIT_MAX_KEYS','0'],['MAP_STYLE','javascript:alert(1)'],['MAP_RESOURCE_ORIGINS','https://x.test/path'],['COOKIE_SECURE','yes'],['SUPPORT_EMAIL','bad'],['TERMS_URL','http://site.test']])assert.throws(()=>runtimeConfig(memory,{env:{[name]:value}}),new RegExp(name));
});

test('request admission stays occupied until handler and response have both finished',async()=>{
 const {EventEmitter}=await import('node:events'),{createAdmission,holdResponseSlot}=await import('../src/http-policy.mjs');
 for(const responseFirst of [true,false]){
  const slots=createAdmission({maxInflight:1,uploadConcurrency:1}),res=new EventEmitter(),done=holdResponseSlot(res,slots.enter({upload:true}));
  if(responseFirst)res.emit('close');else done();
  assert.equal(slots.snapshot().active,1);assert.throws(()=>slots.enter(),{status:503});
  if(responseFirst)done();else res.emit('finish');res.emit('close');done();
  assert.equal(slots.snapshot().active,0);assert.equal(slots.snapshot().uploads,0);
 }
});
