import {BlockList,isIP} from 'node:net';
import {loadSecurityKeys} from '../security.mjs';
import {runtimeConfig} from '../runtime.mjs';

export function enterpriseConfig({env=process.env,keys,secure,origin}={}){
 if(!keys&&(!env.DATA_ENCRYPTION_KEY||!env.AUDIT_HMAC_KEY))throw new Error('All PostgreSQL replicas require the same DATA_ENCRYPTION_KEY and AUDIT_HMAC_KEY');
 const trustProxy=env.TRUST_PROXY||'none';
 if(!['none','loopback','cidr'].includes(trustProxy))throw new Error('TRUST_PROXY must be none, loopback or cidr');
 const proxyBlocks=new BlockList();
 if(trustProxy==='cidr'){
  const cidrs=String(env.TRUST_PROXY_CIDRS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!cidrs.length)throw new Error('TRUST_PROXY=cidr requires explicit TRUST_PROXY_CIDRS');
  for(const cidr of cidrs){
   const [address,prefix,...rest]=cidr.split('/'),family=isIP(address),bits=Number(prefix);
   if(rest.length||!family||prefix===undefined||!/^\d+$/.test(prefix)||!Number.isInteger(bits)||bits<1||bits>(family===4?32:128))throw new Error('Invalid trusted proxy CIDR');
   proxyBlocks.addSubnet(address,bits,family===4?'ipv4':'ipv6');
  }
 }
 const cfg=runtimeConfig({aqPath:':memory:'},{env:{...env,TRUST_PROXY:trustProxy==='cidr'?'none':trustProxy},keys:keys||loadSecurityKeys({env}),secure,origin});
 const nativeOrigins=String(env.MOBILE_ORIGINS||'capacitor://localhost,https://localhost').split(',').map(x=>x.trim()).filter(Boolean);
 for(const item of nativeOrigins){if(!['capacitor://localhost','https://localhost','http://localhost'].includes(item))throw new Error('MOBILE_ORIGINS must contain known localhost native origins');}
 if(env.NODE_ENV==='production'&&nativeOrigins.includes('http://localhost'))throw new Error('Production Android must use the HTTPS localhost origin');
 if(env.METRICS_TOKEN&&env.METRICS_TOKEN.length<32)throw new Error('METRICS_TOKEN must have at least 32 characters');
 return {...cfg,env,trustProxy,proxyBlocks,nativeOrigins,metricsToken:env.METRICS_TOKEN||null,instanceId:env.INSTANCE_ID||env.HOSTNAME||'local'};
}
const normalizeIp=value=>value?.startsWith('::ffff:')&&isIP(value.slice(7))===4?value.slice(7):value;
export function enterpriseClientIp(req,cfg){
 const peer=normalizeIp(req.socket.remoteAddress||'unknown');
 const trusted=ip=>cfg.trustProxy==='loopback'?['127.0.0.1','::1'].includes(ip):cfg.trustProxy==='cidr'&&isIP(ip)&&cfg.proxyBlocks.check(ip,isIP(ip)===4?'ipv4':'ipv6');
 if(!trusted(peer))return peer;
 const entries=String(req.headers['x-forwarded-for']||'').split(',').map(x=>normalizeIp(x.trim()));
 if(entries.length>20||entries.some(x=>!isIP(x)))return peer;
 let current=peer;
 for(let i=entries.length-1;i>=0&&trusted(current);i--)current=entries[i];
 return current;
}
