import test from 'node:test';
import assert from 'node:assert/strict';
const previous=globalThis.document,hadDocument=Object.hasOwn(globalThis,'document');
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let hostnameCandidate,validateNodeDisplayName,nodeDetailFacts,nodeNameMarkup,versionChannelBadge,resourceAllocationNotice,resourceAllocationBudget,plainUI;
try{
 ({hostnameCandidate,validateNodeDisplayName,nodeDetailFacts,nodeNameMarkup}=await import('../public/nodes-workspace.js'));
 ({versionChannelBadge}=await import('../public/version-picker.js'));
 ({resourceAllocationNotice,resourceAllocationBudget}=await import('../public/resource-fields.js'));
 ({plainUI}=await import('../public/i18n.js'));
}finally{if(hadDocument)globalThis.document=previous;else delete globalThis.document;}
test('Hostname preview canonicalizes only safe ASCII uppercase and preserves the entered value for review',()=>{
 assert.deepEqual(hostnameCandidate('VortexPanel'),{requested:'VortexPanel',canonical:'vortexpanel',normalized:true});
 assert.equal(hostnameCandidate('Node01.Example.NET').canonical,'node01.example.net');
 assert.equal(hostnameCandidate('node-001').normalized,false);
 for(const value of[' VortexPanel','VortexPanel ','Vortex Panel','Nöde','NODE;id','NODE\n','LOCALHOST','LOCALHOST.LOCALDOMAIN','A'.repeat(65)])assert.throws(()=>hostnameCandidate(value));
});
test('Display names retain case and human spacing while obeying existing80-character/control rules',()=>{
 assert.equal(validateNodeDisplayName(' VortexPanel '),'VortexPanel');
 assert.equal(validateNodeDisplayName('VPS của tôi'),'VPS của tôi');
 assert.equal(validateNodeDisplayName('A'.repeat(80)).length,80);
 for(const value of['','  ','A'.repeat(81),'Node\nName','Node\u0000Name','Node\u007f'])assert.throws(()=>validateNodeDisplayName(value));
});
test('Node details preserve zero and distinguish local panel metadata from nonexistent remote-agent TLS',()=>{
 const facts=Object.fromEntries(nodeDetailFacts({local:true,serverCount:0,version:null,controlPlane:{kind:'local-panel',version:'0.10.1',agentId:null,tls:{mode:'in-process'}},host:{hostname:'main',release:'Ubuntu24.04.5LTS'}}).map(item=>[item.key,plainUI(item.value)]));
 assert.equal(facts.serverCount,'0');assert.equal(facts.panelVersion,'0.10.1');assert.match(facts.agent,/Not applicable/);assert.match(facts.tls,/local panel process/);assert.notEqual(facts.agent,'0.10.1');assert.equal(facts.system,'Ubuntu24.04.5LTS');assert.equal(Object.values(facts).includes('—'),false);
});
test('Remote details use real version and identity, including zero latency and explicit non-TLS loopback',()=>{
 const facts=node=>Object.fromEntries(nodeDetailFacts(node).map(item=>[item.key,plainUI(item.value)]));
 const value=facts({local:false,serverCount:0,latencyMs:0,endpoint:'https://node.example:8443',controlPlane:{kind:'remote-agent',version:'0.10.1',agentId:'real-agent-id',tls:{mode:'pinned'}}});
 assert.equal(value.serverCount,'0');assert.equal(value.latency,'0 ms');assert.equal(value.agent,'Vortex Node 0.10.1');assert.equal(value.panelVersion,'real-agent-id');assert.equal(value.tls,'Pinned certificate');
 assert.equal(facts({local:false,controlPlane:{tls:{mode:'loopback-http'}}}).tls,'Loopback HTTP · no TLS');
 assert.equal(facts({local:false}).agent,'Not reported');assert.equal(facts({local:false}).tls,'Not reported');
});
test('Inline name editors escape labels and have distinct accessible input IDs across card and modal',()=>{
 const node={id:'local',name:'Main <unsafe> & "name"'},card=nodeNameMarkup(node),detail=nodeNameMarkup(node,{detail:true});
 assert.match(card,/data-action="node-rename"/);assert.match(card,/Main &lt;unsafe&gt; &amp; &quot;name&quot;/);assert.doesNotMatch(card,/<unsafe>/);assert.match(card,/name="nodeDisplayName" required maxlength="80"/);
 const id=html=>html.match(/<input id="([^"]+)" name="nodeDisplayName"/)[1];assert.notEqual(id(card),id(detail));assert.ok(card.includes(`for="${id(card)}"`));assert.ok(detail.includes(`for="${id(detail)}"`));
});
test('Version badges expose stable/preview semantics without using availability as channel color',()=>{
 assert.match(versionChannelBadge({channel:'preview',cached:true}),/data-version-channel="preview">Preview/);
 assert.match(versionChannelBadge({channel:'stable',availability:'unavailable'}),/data-version-channel="stable">Stable/);
 assert.match(versionChannelBadge({}),/channel-badge/);assert.doesNotMatch(versionChannelBadge({channel:'preview" onclick="bad'}),/onclick=/);
});
test('RAM helper separates decimalGB, binaryGiB, and logical allocation from current pressure',()=>{
 const total=2013073408,allocatable=Math.floor(total*.9),capacity={reserveRatio:.1,memory:{totalBytes:total,allocatableBytes:allocatable,allocatedBytes:0,availableBytes:allocatable,pressureSafeAvailableBytes:600*1024**2,pressureWarning:true}};
 const notice=resourceAllocationNotice(capacity,{memoryMiB:1024});assert.equal(notice.percent,90);assert.equal(notice.ramBudgetBytes,allocatable);assert.match(plainUI(notice.ramBudget),/1\.81 GB \(1\.69 GiB\)/);assert.equal(notice.pressure,true);assert.equal(resourceAllocationNotice(capacity,{memoryMiB:512}).pressure,false);
 const budget=resourceAllocationBudget({fixedSupported:true},{capacity});assert.equal(budget.memoryMiB,Math.floor(allocatable/1024**2));assert.ok(budget.memoryMiB>600);assert.equal(resourceAllocationNotice(null).percent,null);assert.equal(resourceAllocationNotice({}).pressure,false);
});
