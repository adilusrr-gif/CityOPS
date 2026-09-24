import {Capacitor} from '@capacitor/core';
import {Geolocation} from '@capacitor/geolocation';
import {App} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
globalThis.CityQuestNative={isNative:Capacitor.isNativePlatform(),apiBase:__CITYQUEST_API_BASE__,geolocation:Geolocation,app:App,browser:Browser};
await import('../../public/app.js');
