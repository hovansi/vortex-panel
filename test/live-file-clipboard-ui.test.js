import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));

test('ordinary Bedrock files can be copied and cut live while application files require stopped state',()=>{
 const server={id:'fixture',kind:'bedrock',status:'running',name:'Fixture'},state={servers:[server]},fileWorkspace={operation:null};
 const context={state,fileWorkspace,isApplication:server=>['nodejs','python'].includes(server?.kind),canManage:server=>server?.permissions?.manage!==false,t:value=>value,voiceText:en=>en,ht:(chunks,...values)=>chunks.map((part,index)=>part+(values[index]??'')).join(''),syncFileWorkspace(){},toast(){}};
 vm.runInNewContext(section('function canWriteFiles(', '\nfunction fileWritable(')+'\n'+section('function setFileClipboard(', '\nasync function pasteFiles(')+'\nglobalThis.clip=setFileClipboard;',context);
 for(const mode of ['copy','cut']){context.clip(mode,['notes.txt'],'fixture');assert.equal(fileWorkspace.clipboard.mode,mode);}
 for(const kind of ['nodejs','python']){server.kind=kind;assert.throws(()=>context.clip('copy',['notes.txt'],'fixture'));server.status='stopped';context.clip('copy',['notes.txt'],'fixture');server.status='running';}
 server.kind='bedrock';for(const change of [{busy:true},{recoveryRequired:true},{permissions:{manage:false}},{status:'starting'}]){Object.assign(server,{busy:false,recoveryRequired:false,permissions:{manage:true},status:'running'},change);assert.throws(()=>context.clip('cut',['notes.txt'],'fixture'));}
});
