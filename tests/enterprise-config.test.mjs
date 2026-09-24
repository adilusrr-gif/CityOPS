import test from 'node:test';
import assert from 'node:assert/strict';
import {enterpriseConfig,enterpriseClientIp} from '../src/enterprise/config.mjs';
const keys={encryptionKey:Buffer.alloc(32,41),auditKey:Buffer.alloc(32,42)};
const req=(remote,forwarded)=>({socket:{remoteAddress:remote},headers:{'x-forwarded-for':forwarded}});
test('enterprise requires shared keys and bounded explicit native origins',()=>{
 assert.throws(()=>enterpriseConfig({env:{NODE_ENV:'development'}}),/same/);
 assert.throws(()=>enterpriseConfig({env:{NODE_ENV:'test',MOBILE_ORIGINS:'https://attacker.example'},keys}),/known/);
 assert.throws(()=>enterpriseConfig({env:{NODE_ENV:'production',COOKIE_SECURE:'true',PUBLIC_ORIGIN:'https://quest.example',MOBILE_ORIGINS:'http://localhost'},keys}),/HTTPS localhost/);
 assert.throws(()=>enterpriseConfig({env:{NODE_ENV:'test',METRICS_TOKEN:'short'},keys}),/32/);
 const cfg=enterpriseConfig({env:{NODE_ENV:'test'},keys});assert.deepEqual(cfg.nativeOrigins,['capacitor://localhost','https://localhost']);
});
test('proxy CIDR trust walks right-to-left and ignores injected untrusted hops',()=>{
 const cfg=enterpriseConfig({env:{NODE_ENV:'test',TRUST_PROXY:'cidr',TRUST_PROXY_CIDRS:'10.42.0.0/16,fd12:3456::/48'},keys});
 assert.equal(enterpriseClientIp(req('10.42.1.4','192.0.2.123, 198.51.100.7'),cfg),'198.51.100.7');
 assert.equal(enterpriseClientIp(req('10.42.1.4','198.51.100.7, 10.42.2.3'),cfg),'198.51.100.7');
 assert.equal(enterpriseClientIp(req('203.0.113.8','198.51.100.7'),cfg),'203.0.113.8');
 assert.equal(enterpriseClientIp(req('::ffff:10.42.1.4','198.51.100.7'),cfg),'198.51.100.7');
 assert.equal(enterpriseClientIp(req('fd12:3456::4','2001:db8::1, fd12:3456::3'),cfg),'2001:db8::1');
 assert.equal(enterpriseClientIp(req('10.42.1.4','malformed'),cfg),'10.42.1.4');
 for(const range of ['', '0.0.0.0/0','10.0.0.0/99','invalid/8','10.0.0.0','::/0'])assert.throws(()=>enterpriseConfig({env:{NODE_ENV:'test',TRUST_PROXY:'cidr',TRUST_PROXY_CIDRS:range},keys}),/CIDR/);
});
