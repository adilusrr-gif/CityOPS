import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import {CITIES,DEFAULT_CITY} from './cities.mjs';
import {EXPLORATION_GRID} from './product-policy.mjs';
export const BOUNDS = CITIES[DEFAULT_CITY].bounds;
export function city(value=DEFAULT_CITY){if(typeof value!=='string'||!Object.hasOwn(CITIES,value))fail('Неизвестный город');return CITIES[value];}
export const id = () => randomBytes(12).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function passwordHash(password) { const salt=randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export function passwordOK(password,stored) { try { const [salt,key]=stored.split(':'); const a=Buffer.from(key,'hex'),b=scryptSync(password,salt,64); return a.length===b.length&&timingSafeEqual(a,b); } catch { return false; } }
export function fail(message,status=400) { throw Object.assign(new Error(message),{status}); }
export function text(value,label,max=160,min=1) { if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)fail(`${label}: от ${min} до ${max} символов`); return value.trim(); }
export function number(value,label,min,max) { if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(`${label}: от ${min} до ${max}`); return value; }
export function choice(value,choices,label) { if(!choices.includes(value))fail(`Некорректное значение: ${label}`);return value; }
export function point(lng,lat,cityId=DEFAULT_CITY) {const bounds=city(cityId).bounds;number(lng,'Долгота',bounds.west,bounds.east);number(lat,'Широта',bounds.south,bounds.north);return {lng,lat}; }
export function distance(a,b) { const r=Math.PI/180,dLat=(b.lat-a.lat)*r,dLon=(b.lng-a.lng)*r;const h=Math.sin(dLat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLon/2)**2;return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)); }
export function cell(lng,lat) { return `${Math.floor(lng/EXPLORATION_GRID.lngCellSize)}:${Math.floor(lat/EXPLORATION_GRID.latCellSize)}`; }
export function normalizeEmail(v) {const e=text(v,'Email',254,5).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))fail('Некорректный email');return e;}
export function normalizeCode(v) {if(v==null)return '';if(typeof v!=='string'||v.length>256)fail('Некорректный код');return v.trim().toUpperCase();}
