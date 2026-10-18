import test from 'node:test';
import assert from 'node:assert/strict';
const original=globalThis.document,had=Object.hasOwn(globalThis,'document');
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let nodeLocation,plainUI;
try { ({nodeLocation}=await import('../public/nodes-workspace.js'));({plainUI}=await import('../public/i18n.js')); }
finally { if(had)globalThis.document=original;else delete globalThis.document; }

test('manual location overrides the automatic observation without an approximate or stale label',()=>{
 assert.equal(plainUI(nodeLocation({location:'My rack',locationSource:'manual',host:{location:{status:'known',label:'Other city',stale:true}}})),'My rack');
 assert.equal(plainUI(nodeLocation({location:'Los Angeles',locationSource:'ip-geolocation',host:{location:{status:'known',stale:true}}})),'≈ Los Angeles · Last known estimate');
});
test('automatic pending, disabled and failed lookup states never pretend the admin omitted a location',()=>{
 assert.equal(plainUI(nodeLocation({host:{location:{status:'pending'}}})),'Detecting location…');
 assert.equal(plainUI(nodeLocation({host:{location:{status:'disabled'}}})),'Automatic location disabled');
 assert.equal(plainUI(nodeLocation({host:{location:{status:'unavailable'}}})),'Location lookup will retry');
 assert.equal(plainUI(nodeLocation(undefined)),'Location not reported');
});
