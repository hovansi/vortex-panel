import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buttonIntent,setButtonIntent} from '../public/button-intent.js';

test('lifecycle, destructive, caution and ordinary actions retain distinct meanings',()=>{
 for(const action of ['start'])assert.equal(buttonIntent(action,{primary:true}),'positive');
 for(const action of ['stop','kill','delete-server','delete-file','world-delete','delete-backup','restore-backup','node-remove','mfa-disable'])assert.equal(buttonIntent(action),'danger');
 for(const action of ['restart','update-server','vps-power','file-access-toggle','reset-user-mfa'])assert.equal(buttonIntent(action),'warning');
 assert.equal(buttonIntent('create-server',{primary:true}),'primary');
 for(const action of ['close-modal','navigate','download-file','job-details'])assert.equal(buttonIntent(action),'neutral');
 assert.equal(buttonIntent('run-schedule',{task:'restart'}),'warning');assert.equal(buttonIntent('run-schedule',{task:'backup'}),'primary');
 assert.equal(buttonIntent('toggle-schedule',{enabled:true}),'warning');assert.equal(buttonIntent('toggle-schedule',{enabled:false}),'positive');
});
test('switching intent removes conflicting brand styles without losing control identity',()=>{
 const classes=new Set(['btn','primary','soft','intent-primary']),button={dataset:{action:'start'},classList:{remove:v=>classes.delete(v),add:v=>classes.add(v)}};
 setButtonIntent(button,'positive');assert.equal(classes.has('primary'),false);assert.equal(classes.has('soft'),false);assert.equal(classes.has('intent-positive'),true);assert.equal(button.dataset.action,'start');
 setButtonIntent(button,'warning');assert.equal(classes.has('intent-positive'),false);assert.equal(button.dataset.intent,'warning');
});
test('action colours meet normal-text contrast in both themes',async()=>{
 const css=await readFile(new URL('../public/polish.css',import.meta.url),'utf8');
 const luminance=hex=>{const raw=hex.replace('#',''),rgb=raw.length===3?[...raw].map(v=>parseInt(v+v,16)/255):[0,2,4].map(i=>parseInt(raw.slice(i,i+2),16)/255);return rgb.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);};
 for(const block of [css.match(/:root\{--action-positive-bg:[^}]+\}/)[0],css.match(/:root\[data-theme=dark\]\{--action-positive-bg:[^}]+\}/)[0]])for(const intent of ['positive','danger','warning']){
  const fg=block.match(new RegExp(`--action-${intent}-fg:(#[a-f0-9]+)`))[1],bg=block.match(new RegExp(`--action-${intent}-bg:(#[a-f0-9]+)`))[1],hover=block.match(new RegExp(`--action-${intent}-hover:(#[a-f0-9]+)`))[1];
  for(const value of [bg,hover]){const a=luminance(fg),b=luminance(value);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${intent} ${fg}/${value}`);}
 }
 assert.doesNotMatch(css,/button\[data-busy=true\]\[data-busy-icon=none\]\{color:transparent\}/);
});
