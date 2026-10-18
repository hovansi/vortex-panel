import test from 'node:test';
import assert from 'node:assert/strict';
const previous=globalThis.document;globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let view,plainUI;try{view=await import('../public/telemetry-view.js');({plainUI}=await import('../public/i18n.js'));}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
const icon=name=>`<svg class="icon" data-icon="${name}" aria-hidden="true"></svg>`;
const host=(at,used=1)=>({sampledAt:new Date(at).toISOString(),cpu:{usedCores:used,totalCores:4},memory:{usedBytes:1024**3,totalBytes:4*1024**3},disk:{usedBytes:2*1024**3,totalBytes:10*1024**3},network:{supported:true,scope:'host-network-namespace',sampledAt:new Date(at).toISOString(),rxBytes:1000,txBytes:2000,rxBytesPerSecond:100,txBytesPerSecond:20,countersSince:'interface-initialization'}});
test('four real charts keep numeric used/total and dual RX/TX values while descriptions live only inside collapsed details',()=>{
 view.clearTelemetryHistory();view.ingestTelemetrySnapshot({host:host(1000)});view.ingestTelemetrySnapshot({host:host(6000,2)});const html=plainUI(view.telemetryMarkup(host(6000,2),icon,{entityId:'local'}));
 assert.equal((html.match(/class="metric-spark"/g)||[]).length,4);assert.match(html,/data-metric-value>2</);assert.match(html,/data-metric-total>4</);assert.match(html,/data-metric-rx>100 B\/s/);assert.match(html,/data-metric-tx>20 B\/s/);assert.match(html,/data-metric-rx-total>1,000 B/);assert.equal((html.match(/<details class="metric-details">/g)||[]).length,4);assert.doesNotMatch(html,/<details[^>]* open/);assert.doesNotMatch(html,/class="usage-meter"|<small>Actual host usage/);assert.match(html,/data-chart-line="1"/);
});
test('a legacy rich explicit disk unknown stays unknown and a server cannot display host traffic as its own',()=>{
 const unknown=view.telemetryModel({...host(1000),diskUsed:0,disk:{usedBytes:null,totalBytes:null}});assert.equal(unknown.storage.used,null);assert.equal(unknown.storage.total,null);
 const foreign=view.telemetryModel({id:'s',telemetry:host(1000)},'server');assert.equal(foreign.network.available,false);assert.equal(foreign.network.rxBytes,null);assert.equal(foreign.network.rxRate,null);
});
test('missing source timestamps do not grow history and identities are explicit for hosts',()=>{
 view.clearTelemetryHistory();const value={cpu:{usedCores:1,totalCores:4}};view.telemetryMarkup(value,icon,{entityId:'a'});assert.equal(view.telemetryHistorySeries('host','a','cpu').length,0);const html=view.telemetryMarkup(host(1000),icon);assert.doesNotMatch(html,/data-telemetry-key=/);
});
test('server storage and network use independent source timestamps; stale observations are a gap rather than zero',()=>{
 view.clearTelemetryHistory();const server={id:'node:raw',telemetry:{...host(1000),storage:{sampledAt:new Date(500).toISOString(),usedBytes:100,totalBytes:1000},network:{scope:'server-game-ports',available:true,sampledAt:new Date(900).toISOString(),rxBytesPerSecond:20,txBytesPerSecond:10}}};
 view.ingestTelemetrySnapshot({servers:[server]});assert.equal(view.telemetryHistorySeries('server','node:raw','storage')[0].time,500);assert.equal(view.telemetryHistorySeries('server','node:raw','network')[0].time,900);
 view.ingestTelemetrySnapshot({servers:[{...server,nodeOnline:false}]});assert.deepEqual(view.telemetryHistorySeries('server','node:raw','cpu').at(-1).values,[null]);
});
test('untrusted reasons and identity strings are escaped rather than injected into metric markup',()=>{
 view.clearTelemetryHistory();const value={...host(1000),network:{supported:false,scope:'host-network-namespace',reason:'<img src=x onerror=alert(1)>'}};const html=view.telemetryMarkup(value,icon,{entityId:'node" onmouseover="bad'});assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/data-telemetry-key="host:node&quot;/);
});
