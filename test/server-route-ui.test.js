import test from 'node:test';import assert from 'node:assert/strict';
import {resolveServerRouteId} from '../public/server-route.js';
const local='b125c34d-2a62-4f57-805f-60d4af2ba1ec',remote='c46db704-ce91-43e4-b665-a98026caa630:'+local,servers=[{id:local},{id:remote},{id:'demo-survival'}];
test('server deep links accept raw and once-encoded local/composite IDs from authorized inventory',()=>{
 for(const id of [local,remote,'demo-survival']){assert.equal(resolveServerRouteId(id,servers),id);assert.equal(resolveServerRouteId(encodeURIComponent(id),servers),id);}
 assert.equal(resolveServerRouteId(remote.replace(':','%3a'),servers),remote);
});
test('deep links reject malformed escapes, encoded separators and unauthorized IDs',()=>{
 for(const id of ['%','%3','%zz',remote.replace(':','%253A'),remote.replace(':','%2F'),remote+'%5C',local+'%3Fdownload',local+'%23files','missing',null])assert.equal(resolveServerRouteId(id,servers),null);
 assert.equal(resolveServerRouteId('allowed%2Fpath',[{id:'allowed/path'}]),null);assert.equal(resolveServerRouteId('allowed%5Cpath',[{id:'allowed\\path'}]),null);
});
