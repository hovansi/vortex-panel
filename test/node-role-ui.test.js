import test from 'node:test';import assert from 'node:assert/strict';
const previous=globalThis.document,had=Object.hasOwn(globalThis,'document');globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let nodeRoleMarkup,nodesMarkup,plainUI;try{({nodeRoleMarkup,nodesMarkup}=await import('../public/nodes-workspace.js'));({plainUI}=await import('../public/i18n.js'));}finally{if(had)globalThis.document=previous;else delete globalThis.document;}
test('main VPS role is an accessible compact icon adjacent to connection status and absent from location',()=>{
 const role=plainUI(nodeRoleMarkup({local:true}));assert.match(role,/role="img" aria-label="Main panel VPS"/);assert.match(role,/<use href="#i-host"/);assert.equal(nodeRoleMarkup({local:false}),'');
 const markup=plainUI(nodesMarkup({nodes:[{id:'local',local:true,name:'Vortex Main',online:true,location:'Singapore',serverCount:0}]},{icon:()=>'<svg></svg>'}));
 assert.match(markup,/<p data-node-location>Singapore<\/p>/);assert.doesNotMatch(markup,/Singapore · Main/);assert.match(markup,/Connected<\/span><span class="node-role-tag"/);assert.doesNotMatch(markup,/data-node-location>[^<]*Main panel/);
});
