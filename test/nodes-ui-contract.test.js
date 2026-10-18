import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise actual frontend contract helpers; this isolated import stub does not
// stand in for browser/DOM acceptance, which is recorded separately.
const previousDocument=globalThis.document,hadDocument=Object.hasOwn(globalThis,'document');
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let nodeCreationState,nodeFormPayload,nodeSSHAddress,nodeSSHFields,nodeProvisionModel,serverNodeAddress,serverNodeUnavailable,mergeNodeServers,nodesMarkup,plainUI;
try{({nodeCreationState,nodeFormPayload,nodeSSHAddress,nodeSSHFields,nodeProvisionModel,serverNodeAddress,serverNodeUnavailable,mergeNodeServers,nodesMarkup}=await import('../public/nodes-workspace.js'));({plainUI}=await import('../public/i18n.js'));}
finally{if(hadDocument)globalThis.document=previousDocument;else delete globalThis.document;}

test('node creation fails closed for unknown/offline/maintenance nodes and uses only the chosen capability',()=>{
 const local={id:'local',online:true,capabilities:{resourceControl:{fixedSupported:true,cpu:{maxCores:8}}}},remote={id:'remote',online:true,capabilities:{resourceControl:{fixedSupported:false}},nextPort:19132,nextPortV6:19133};
 assert.equal(nodeCreationState(local).allowed,true);assert.strictEqual(nodeCreationState(remote).capability,remote.capabilities.resourceControl);assert.equal(nodeCreationState(remote).capability.fixedSupported,false);
 for(const node of[null,{...remote,online:undefined},{...remote,online:false},{...remote,maintenance:true}])assert.equal(nodeCreationState(node).allowed,false);
 assert.equal(nodeCreationState({id:'uncertain',online:true}).capability.fixedSupported,false);
 assert.equal(nodeCreationState(remote).nextPort,19132);assert.equal(nodeCreationState({online:true}).nextPort,null);
});

test('edit node serialization preserves saved secrets and TLS pin when their fields are blank',()=>{
 const input={name:'  Singapore  ',endpoint:'https://agent.example.com:8443/',location:' SG ',publicAddress:'play.example.com',token:' ',fingerprint:'',untrustedRole:'admin'};
 const original=structuredClone(input),payload=nodeFormPayload(input);
 assert.deepEqual(payload,{name:'Singapore',endpoint:'https://agent.example.com:8443',location:'SG',publicAddress:'play.example.com'});assert.deepEqual(input,original);assert.equal(Object.hasOwn(payload,'token'),false);assert.equal(Object.hasOwn(payload,'fingerprint'),false);assert.equal(Object.hasOwn(payload,'untrustedRole'),false);
 assert.equal(nodeFormPayload({...input,clearFingerprint:true}).fingerprint,null);assert.throws(()=>nodeFormPayload({...input,clearFingerprint:'on',fingerprint:'ab'.repeat(32)}));
 assert.deepEqual(nodeFormPayload({name:'Local',publicAddress:'203.0.113.10',location:'Room1'}),{name:'Local',publicAddress:'203.0.113.10',location:'Room1'});
});

test('add node requires a token and canonicalizes an installer SHA256 fingerprint without exposing extra fields',()=>{
 assert.throws(()=>nodeFormPayload({name:'VPS',endpoint:'https://203.0.113.10:8443'},{creating:true}));
 const payload=nodeFormPayload({name:'VPS',endpoint:'https://203.0.113.10:8443',token:' random-private-token ',fingerprint:'SHA256: '+Array(32).fill('AB').join(':')},{creating:true});
 assert.equal(payload.token,'random-private-token');assert.equal(payload.fingerprint,'ab'.repeat(32));assert.equal(payload.endpoint,'https://203.0.113.10:8443');assert.throws(()=>nodeFormPayload({name:'VPS',fingerprint:'AB:CD'}));
});

test('node form rejects endpoints that would confuse agent origin/auth routing',()=>{
 for(const endpoint of['http://agent.example.com','https://user:secret@agent.example.com','https://agent.example.com/api','https://agent.example.com?token=x','https://agent.example.com/#fragment','not a URL'])assert.throws(()=>nodeFormPayload({name:'VPS',endpoint}));
 for(const publicAddress of['host/path','play.example.com?token=x','<img src=x>','bad host'])assert.throws(()=>nodeFormPayload({name:'VPS',publicAddress}));
});

test('offline inventory merge keeps opaque remote identity and reports unknown runtime instead of stopped/zero',()=>{
 const remote={id:'central-node:raw-server',nodeId:'central-node',status:'running',players:8,nodeOnline:true},local={id:'local-server',status:'stopped'};
 const merged=mergeNodeServers([remote,local],[local],[{id:'central-node',online:false,lastSeen:'2026-10-15T00:00:00.000Z'}]);
 assert.equal(merged[1].id,remote.id);assert.equal(merged[1].status,'unknown');assert.equal(merged[1].lastKnownStatus,'running');assert.equal(serverNodeUnavailable(merged[1]),true);assert.equal(serverNodeUnavailable(local),false);assert.equal(serverNodeUnavailable({...remote,nodeOnline:undefined}),true);
 assert.equal(mergeNodeServers([remote],[],[{id:'central-node',online:true}]).length,0);assert.equal(remote.status,'running');assert.equal(remote.nodeOnline,true);
});

test('game connection address follows node public host and formats IPv6 without borrowing the agent URL',()=>{
 assert.equal(serverNodeAddress({nodeAddress:'play.example.com',endpoint:'https://agent.example.com',port:19132}),'play.example.com:19132');assert.equal(serverNodeAddress({nodeAddress:'2001:db8::10',port:19132}),'[2001:db8::10]:19132');assert.equal(serverNodeAddress({nodeAddress:'[2001:db8::10]',port:19132}),'[2001:db8::10]:19132');assert.equal(serverNodeAddress({endpoint:'https://agent.example.com',port:19132}),'');
});

test('unknown node cards keep missing metrics/counts unknown and escape operator-controlled text',()=>{
 const markup=plainUI(nodesMarkup({nodes:[{id:'remote',name:'<script>unsafe</script>',endpoint:'https://agent.example.com',online:false,stale:true,host:null,serverCount:null}],limits:{maxNodes:32}},{icon:()=>'<svg></svg>'}));
 assert.ok(markup.includes('&lt;script&gt;unsafe&lt;/script&gt;'));assert.equal(markup.includes('<script>unsafe</script>'),false);assert.ok(markup.includes('Last known sample'));assert.ok(markup.includes('Some node inventories are unknown'));assert.equal(markup.includes('0 GiB / 0 GiB'),false);assert.ok(markup.includes('<strong>—</strong>'));assert.equal(markup.includes('private-token'),false);
});

test('SSH authentication serializes one chosen mechanism and never forwards hidden credentials or unrelated fields',()=>{
 const input={host:' 203.0.113.20 ',port:'22',username:' root ',authMode:'password',password:' exact secret ',privateKey:'hidden-key',passphrase:'hidden-passphrase',nodeId:'untrusted',hostFingerprint:'untrusted'};
 assert.deepEqual(nodeSSHFields(input),{host:'203.0.113.20',port:22,username:'root',password:' exact secret '});assert.equal(input.password,' exact secret ');
 assert.deepEqual(nodeSSHFields({...input,authMode:'key',privateKey:'  -----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----  ',passphrase:' exact passphrase '}),{host:'203.0.113.20',port:22,username:'root',privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',passphrase:' exact passphrase '});
 for(const invalid of[{host:'https://host'}, {host:'bad host'}, {port:'22.5'}, {port:0}, {port:65536}, {username:'bad user'}, {password:''}, {authMode:'key',privateKey:''}])assert.throws(()=>nodeSSHFields({...input,...invalid}));
});

test('SSH host-key discovery excludes all authentication material even when credentials are already typed',()=>{
 assert.deepEqual(nodeSSHAddress({host:' 203.0.113.21 ',port:'2222',username:'root',password:'secret',privateKey:'private-key',passphrase:'secret',hostFingerprint:'unknown'}),{host:'203.0.113.21',port:2222});
 assert.deepEqual(nodeSSHAddress({host:'vps.example.com'}),{host:'vps.example.com',port:22});
});

test('node setup separates measured transfer bytes from estimated workflow and reserves100 for completed',()=>{
 assert.deepEqual(nodeProvisionModel({status:'running',progress:100,transfer:{loadedBytes:1024,totalBytes:4096}}),{completed:false,failed:false,active:true,stagePercent:99,loaded:1024,total:4096,transferring:true});
 const unknown=nodeProvisionModel({status:'running',progress:15,transfer:{loadedBytes:65536,totalBytes:null}});assert.equal(unknown.total,null);assert.equal(unknown.loaded,65536);assert.equal(unknown.stagePercent,15);
 const failed=nodeProvisionModel({status:'failed',progress:100});assert.equal(failed.stagePercent,99);assert.equal(failed.active,false);assert.equal(failed.completed,false);
 const done=nodeProvisionModel({status:'completed',progress:12,transfer:{loadedBytes:20,totalBytes:20}});assert.equal(done.stagePercent,100);assert.equal(done.transferring,false);
});
