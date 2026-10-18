import test from 'node:test';
import assert from 'node:assert/strict';
const previous=globalThis.document;
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];},dispatchEvent(){}};
const {playerActionResultMarkup}=await import('../public/gameplay-workspace.js'),{memoryDetailsMarkup,memoryFacts}=await import('../public/system-memory.js'),{plainUI}=await import('../public/i18n.js');
if(previous)globalThis.document=previous;else delete globalThis.document;

test('explicit Bedrock rejection is failure with exact escaped native reason, rather than a generic pending acknowledgement',()=>{
 const html=plainUI(playerActionResultMarkup({status:'rejected',confirmedApplied:false,message:'No player matched ExamplePlayer at command execution.',nativeFeedback:'No targets matched selector'}));
 assert.match(html,/data-player-outcome="rejected"/);assert.match(html,/role="alert"/);assert.match(html,/Bedrock rejected the action/);assert.match(html,/No targets matched selector/);assert.doesNotMatch(html,/Action confirmed by Bedrock/);
 const unsafe=plainUI(playerActionResultMarkup({status:'rejected',message:'<img src=x>',nativeFeedback:'<script>bad</script>'}));assert.ok(unsafe.includes('&lt;script&gt;'));assert.doesNotMatch(unsafe,/<script>/);
});
test('native confirmation and unconfirmed receipt have distinct outcomes without promoting accepted stdin to success',()=>{
 const confirmed=plainUI(playerActionResultMarkup({status:'confirmed',confirmedApplied:true,nativeFeedback:'De-opped: ExamplePlayer'}));assert.match(confirmed,/data-player-outcome="confirmed"/);assert.match(confirmed,/De-opped: ExamplePlayer/);
 for(const result of [{status:'unconfirmed',acceptedToConsole:true,confirmedApplied:false},{status:'unconfirmed',confirmedApplied:true},{status:'confirmed',confirmedApplied:false}]){
  const html=plainUI(playerActionResultMarkup(result));assert.match(html,/data-player-outcome="unconfirmed"/);assert.match(html,/does not retry/);assert.doesNotMatch(html,/Action confirmed by Bedrock/);
 }
});
test('zram facts keep original, compressed payload, allocator use, logical occupancy and capacity separate',()=>{
 const value={physicalMemoryBytes:2013073408,observedAt:'2026-10-17T10:00:00.000Z',effective:{originalDataBytes:983040,compressedDataBytes:40178,residentBytes:516096,swapUsedBytes:1048576,logicalSizeBytes:1005584384,residentLimitBytes:502267904,algorithm:'lz4'},swapSummary:{complete:true,other:{usedBytes:0,totalBytes:0}}};
 const html=plainUI(memoryFacts(value)+memoryDetailsMarkup(value));assert.match(html,/RAM occupied by zram, including overhead/);assert.match(html,/504 KiB/);assert.match(html,/Data before compression/);assert.match(html,/960 KiB/);assert.match(html,/39.2 KiB/);assert.match(html,/Logical swap occupied in zram/);assert.match(html,/1 MiB/);assert.match(html,/959 MiB/);assert.match(html,/allocator overhead/);assert.match(html,/datetime="2026-10-17T10:00:00.000Z"/);assert.doesNotMatch(html,/Compressed swap in use|Disk swap/);
 const unknown=plainUI(memoryDetailsMarkup({effective:{}}));assert.match(unknown,/—/);assert.doesNotMatch(unknown,/undefined|NaN/);
 const unlimited=plainUI(memoryDetailsMarkup({effective:{residentLimitBytes:0}}));assert.match(unlimited,/No configured limit/);assert.doesNotMatch(unlimited,/Physical RAM limit for zram<\/dt><dd>0 B/);
});
