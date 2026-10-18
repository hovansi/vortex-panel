import test from 'node:test';
import assert from 'node:assert/strict';
import {createMetricHistory,metricChart} from '../public/metric-history.js';

const cpu=(time,value,total=4)=>({cpu:{sampledAt:time,values:[value],ceiling:total,context:'host'}});
test('history has no seeded values and deduplicates or rejects older source timestamps',()=>{
 const history=createMetricHistory();assert.deepEqual(history.series('host:a','cpu'),[]);
 assert.equal(history.record('host:a',cpu(5000,1)),true);assert.equal(history.record('host:a',cpu(5000,3)),false);assert.equal(history.record('host:a',cpu(4000,2)),false);
 assert.deepEqual(history.series('host:a','cpu').map(point=>point.values[0]),[1]);assert.equal(history.record('host:a',cpu(null,2)),false);
});
test('CPU RAM storage and traffic retain separate source clocks without duplicating slow storage samples',()=>{
 const history=createMetricHistory();history.record('server:a',{...cpu(1000,.2),storage:{sampledAt:500,values:[100],ceiling:1000}});
 history.record('server:a',{...cpu(2000,.3),storage:{sampledAt:500,values:[100],ceiling:1000}});
 assert.equal(history.series('server:a','cpu').length,2);assert.equal(history.series('server:a','storage').length,1);
});
test('one hundred twenty frames per entity and bounded LRU entries prevent session growth; removed grants can be pruned',()=>{
 const history=createMetricHistory({maxPoints:120,maxEntities:2});for(let i=0;i<500;i++)history.record('a',cpu(i,1));
 assert.equal(history.series('a','cpu').length,120);assert.equal(history.series('a','cpu')[0].time,380);
 history.record('b',cpu(1,2));history.record('a',cpu(500,1));history.record('c',cpu(1,3));assert.equal(history.inspect().entities,2);assert.deepEqual(history.series('b','cpu'),[]);
 history.prune(['c']);assert.equal(history.inspect().entities,1);assert.deepEqual(history.series('a','cpu'),[]);
});
test('stale transitions insert a null gap once anchored to the source clock, never a zero or client-clock measurement',()=>{
 const history=createMetricHistory();history.record('a',cpu(1000,2));history.record('a',{cpu:{...cpu(1000,2).cpu,stale:true}},{observedAt:999999});history.record('a',{cpu:{...cpu(1000,2).cpu,stale:true}},{observedAt:1999999});history.record('a',cpu(2000,3));
 const rows=history.series('a','cpu');assert.equal(rows.length,3);assert.deepEqual(rows.map(row=>row.time),[1000,1000,2000]);assert.deepEqual(rows[1].values,[null]);assert.equal(rows[1].observation,true);assert.equal(rows[2].breakBefore,true);
 const chart=metricChart(rows,{capacity:true});assert.equal(chart.lines[0].path,'');assert.equal(chart.lines[0].points,2);
});
test('partial missing traffic breaks only its own series and protocol counter resets break continuity',()=>{
 const history=createMetricHistory();const network=(time,rx,tx,context='ports:one')=>({network:{sampledAt:time,values:[rx,tx],available:true,context}});
 history.record('a',network(1000,100,20));history.record('a',network(2000,200,null));history.record('a',network(3000,300,30));
 const chart=metricChart(history.series('a','network'),{seriesCount:2});assert.ok(chart.lines[0].path);assert.equal(chart.lines[1].path,'');
 history.record('a',network(4000,100,10,'ports:two'));assert.equal(history.series('a','network').at(-1).breakBefore,true);
});
test('capacity charts retain unused capacity and never clip actual historical use after a lower ceiling',()=>{
 const points=[{time:1000,values:[1],ceiling:8},{time:2000,values:[2],ceiling:8}],chart=metricChart(points,{capacity:true});assert.equal(chart.scale,8);assert.equal(chart.lines[0].dot.y,34);
 const changed=metricChart([{time:1000,values:[2],ceiling:4},{time:2000,values:[.1],ceiling:1}],{capacity:true});assert.equal(changed.scale,2);assert.ok(changed.lines[0].path);assert.match(changed.lines[0].path,/^M /);
});
test('network RX and TX share a rate axis, actual zero is retained, and first sample never becomes an invented line',()=>{
 const chart=metricChart([{time:1000,values:[0,20]},{time:2000,values:[10,100]}],{seriesCount:2});assert.ok(chart.scale>100&&chart.scale<120);assert.equal(chart.lines[0].points,2);assert.equal(chart.lines[1].points,2);assert.ok(chart.lines[0].dot.y>chart.lines[1].dot.y);
 const first=metricChart([{time:1000,values:[1],ceiling:4}],{capacity:true});assert.equal(first.lines[0].path,'');assert.deepEqual(first.lines[0].dot,{x:236,y:34});assert.equal(metricChart([]).empty,true);assert.equal(metricChart([{time:1000,values:[null]}]).empty,true);
});
test('long missing intervals and invalid values form gaps and no NaN or Infinity can reach an SVG coordinate',()=>{
 const history=createMetricHistory();history.record('a',cpu(1000,1));history.record('a',cpu(2000,NaN));history.record('a',cpu(70000,2));const points=history.series('a','cpu');assert.deepEqual(points[1].values,[null]);assert.equal(points[2].breakBefore,true);
 const chart=metricChart(points,{capacity:true});assert.doesNotMatch(JSON.stringify(chart),/NaN|Infinity/);assert.equal(chart.lines[0].path,'');
});
test('same raw UUID on different nodes never shares measured history',()=>{
 const history=createMetricHistory();history.record('server:node-a:raw',cpu(1000,1));history.record('server:node-b:raw',cpu(1000,3));assert.equal(history.series('server:node-a:raw','cpu')[0].values[0],1);assert.equal(history.series('server:node-b:raw','cpu')[0].values[0],3);
});
