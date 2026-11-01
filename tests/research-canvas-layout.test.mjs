import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutOverview, layoutFocusedSession, fitGraph, zoomGraphAt } from '../patches/dashboard-v0.20/overlay/packages/client/src/components/research/research-agent-canvas-layout.ts';
const overlap=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
test('large overviews retain every unique session and do not overlap',()=>{
 const ids=Array.from({length:32},(_,i)=>`session-${i}`),scene=layoutOverview(ids);
 assert.equal(scene.nodes.length,32);assert.deepEqual(scene.nodes.map(n=>n.id),ids);
 for(let i=0;i<scene.nodes.length;i++)for(let j=i+1;j<scene.nodes.length;j++)assert.equal(overlap(scene.nodes[i],scene.nodes[j]),false);
 assert.ok(scene.width>0&&scene.height>0&&scene.nodes.every(n=>n.x>=0&&n.y>=0&&n.x+n.width<=scene.width&&n.y+n.height<=scene.height));
});
test('focused view arranges all role groups without collisions and handles no children',()=>{
 const ids=Array.from({length:12},(_,i)=>`role-${i}`),scene=layoutFocusedSession('parent',ids);
 assert.equal(scene.parent.id,'parent');assert.deepEqual(scene.children.map(n=>n.id),ids);
 const all=[scene.parent,...scene.children];for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.equal(overlap(all[i],all[j]),false);
 assert.deepEqual(layoutFocusedSession('parent',[]).children,[]);
});
test('fit and anchored zoom stay finite and keep the pointer on the same world point',()=>{
 const scene=layoutOverview(Array.from({length:16},(_,i)=>String(i)));const fit=fitGraph(scene,{width:500,height:520});
 assert.ok(fit.scale>0&&Number.isFinite(fit.x)&&Number.isFinite(fit.y));
 const point={x:230,y:170},zoom=zoomGraphAt(fit,point,1.5);
 assert.ok(Math.abs((point.x-fit.x)/fit.scale-(point.x-zoom.x)/zoom.scale)<1e-8);
 assert.ok(Math.abs((point.y-fit.y)/fit.scale-(point.y-zoom.y)/zoom.scale)<1e-8);
 assert.ok(zoomGraphAt(fit,point,100).scale<=2&&zoomGraphAt(fit,point,0.001).scale>=0.08);
});
test('narrow split panes use a readable single-column overview',()=>{
 const ids=Array.from({length:16},(_,i)=>`session-${i}`);
 const narrow=layoutOverview(ids,320),wide=layoutOverview(ids,1200);
 assert.equal(new Set(narrow.nodes.map(n=>n.x)).size,1);
 assert.ok(new Set(wide.nodes.map(n=>n.x)).size>1);
 assert.ok(narrow.width<=400);
});
test('focused branches stack vertically in narrow split panes',()=>{
 const scene=layoutFocusedSession('parent',['role-a','role-b'],320);
 assert.ok(scene.width<=350);
 assert.ok(scene.children.every(node=>node.y>=scene.parent.y+scene.parent.height));
 assert.equal(overlap(scene.children[0],scene.children[1]),false);
});
