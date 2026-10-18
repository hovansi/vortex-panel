import test from 'node:test';import assert from 'node:assert/strict';
const before=globalThis.document,had=Object.hasOwn(globalThis,'document');globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let resourceAllocationBudget,resourceFields,validateNodeHostname,versionPickerMarkup;
try{({resourceAllocationBudget,resourceFields}=await import('../public/resource-fields.js'));({validateNodeHostname}=await import('../public/nodes-workspace.js'));({versionPickerMarkup}=await import('../public/version-picker.js'));}finally{if(had)globalThis.document=before;else delete globalThis.document;}
const MiB=1024**2,capability={fixedSupported:true,cpu:{minCores:.1,maxCores:8},memory:{minMiB:256,maxMiB:16384}};
test('All uses remaining admission budget plus replaced allocation, never90 percent of total again',()=>{
 const budget={capacity:{reserveRatio:.1,cpu:{totalCores:8,allocatableCores:7.2,allocatedCores:6.856,availableCores:.344},memory:{totalBytes:16*1024**3,availableBytes:511.75*MiB}},credit:{cpuCores:.3,memoryMiB:768}};
 const value=resourceAllocationBudget(capability,budget);assert.equal(value.cpuCores,.64);assert.equal(value.memoryMiB,1279);assert.equal(value.cpuAllowed,true);assert.equal(value.memoryAllowed,true);assert.equal(budget.capacity.cpu.availableCores,.344);
});
test('All caps by the node capability and fails closed for insufficient or unknown budget',()=>{
 assert.equal(resourceAllocationBudget({...capability,cpu:{minCores:.1,maxCores:.9}},{capacity:{cpu:{availableCores:9},memory:{availableBytes:100000*MiB}}}).cpuCores,.9);
 for(const available of[null,undefined,-1,NaN]){const model=resourceAllocationBudget(capability,{capacity:{cpu:{availableCores:available},memory:{availableBytes:available}}});assert.equal(model.cpuAllowed,false);assert.equal(model.memoryAllowed,false);}
 const zero=resourceAllocationBudget({...capability,cpu:{maxCores:0},memory:{maxMiB:0}},{capacity:{cpu:{availableCores:1},memory:{availableBytes:1024*MiB}}});assert.equal(zero.cpuCores,0);assert.equal(zero.memoryMiB,0);assert.equal(zero.cpuAllowed,false);assert.equal(zero.memoryAllowed,false);
 const small=resourceAllocationBudget(capability,{capacity:{cpu:{availableCores:.0999},memory:{availableBytes:255.99*MiB}}});assert.equal(small.cpuCores,.09);assert.equal(small.cpuAllowed,false);assert.equal(small.memoryAllowed,false);
});
test('All does not turn a preserved overcommitted legacy input ceiling into available budget',()=>{
 const budget={capacity:{cpu:{availableCores:0},memory:{availableBytes:0}},credit:{cpuCores:.1,memoryMiB:512}};
 assert.equal(resourceAllocationBudget(capability,budget).cpuCores,.1);const html=resourceFields({mode:'fixed',cpuCores:1,memoryMiB:1024},capability,false,budget);assert.match(html,/max="1"/);assert.match(html,/data-resource-all="both"/);assert.equal((html.match(/data-resource-all=/g)||[]).length,1);
});
test('All subtracts an overcommitted deficit before crediting the allocation being replaced',()=>{
 const model=allocated=>resourceAllocationBudget(capability,{capacity:{cpu:{allocatableCores:.9,allocatedCores:allocated,availableCores:0},memory:{allocatableBytes:1024*MiB,allocatedBytes:1536*MiB,availableBytes:0}},credit:{cpuCores:1,memoryMiB:768}});
 assert.equal(model(1).cpuCores,.9);assert.equal(model(1.5).cpuCores,.4);assert.equal(model(1.5).memoryMiB,256);assert.equal(model(1.5).memoryAllowed,true);
 const exhausted=resourceAllocationBudget(capability,{capacity:{cpu:{allocatableCores:.9,allocatedCores:2,availableCores:0},memory:{allocatableBytes:1024*MiB,allocatedBytes:2048*MiB,availableBytes:0}},credit:{cpuCores:1,memoryMiB:768}});assert.equal(exhausted.cpuCores,0);assert.equal(exhausted.memoryMiB,0);assert.equal(exhausted.cpuAllowed,false);assert.equal(exhausted.memoryAllowed,false);
});
test('Hostname input mirrors strict lowercase DNS rules without silently trimming or converting',()=>{
 for(const valid of['vortex-main','vortex-node-001','node01.example.net','a','a'.repeat(63)])assert.equal(validateNodeHostname(valid),valid);
 for(const bad of['','localhost','localhost.localdomain','Host',' node','node ','-node','node-','a..b','a/b','node;id','x\nnode','a'.repeat(65),'a'.repeat(64)+'.b'])assert.throws(()=>validateNodeHostname(bad));
});
test('Create can request a permanently visible inline catalog while Update stays opt-in collapsed',()=>{
 const inline=versionPickerMarkup({id:'new-create',alwaysOpen:true}),update=versionPickerMarkup({id:'update'});assert.match(inline,/data-vp-always-open/);assert.match(inline,/data-vp-browser>/);assert.doesNotMatch(inline,/data-vp-browser hidden/);assert.match(update,/data-vp-browser hidden/);assert.doesNotMatch(update,/data-vp-always-open/);
});
