import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf("$('.skip-link').addEventListener('click',"),end=source.indexOf('\nsetInterval(',start);
test('skip link focuses current content without routing or changing dirty drafts',()=>{
 for(const authenticated of [true,false]){let handler,prevented=false;const workspace={scrollTop:700,focus(){this.focused=true;}},auth={scrollTop:50,focus(){this.focused=true;}};
  const context={state:{auth:{authenticated}},$:selector=>selector==='.skip-link'?{addEventListener:(_type,fn)=>{handler=fn;}}:selector==='#workspace'?workspace:auth};vm.runInNewContext(source.slice(start,end),context);handler({preventDefault(){prevented=true;}});assert.equal(prevented,true);const content=authenticated?workspace:auth;assert.equal(content.focused,true);assert.equal(content.scrollTop,0);assert.equal(content.tabIndex,-1);}
});
