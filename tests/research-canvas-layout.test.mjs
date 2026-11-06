import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutOverview, layoutSessionHierarchy, resolveSessionParents, layoutFocusedSession, fitGraph, zoomGraphAt } from '../patches/dashboard-v0.20/overlay/packages/client/src/components/research/research-agent-canvas-layout.ts';
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

test('real session ancestry lays out parent, child, grandchild without turning handoffs into parentage',()=>{
 const ids=['child','unrelated','grandchild','root'];
 const relations=[{fromExecutionId:'root',toExecutionId:'child',kind:'dispatch'}, {fromExecutionId:'child',toExecutionId:'grandchild',kind:'dispatch'}, {fromExecutionId:'unrelated',toExecutionId:'root',kind:'handoff'}];
 const parents=resolveSessionParents(ids,relations);
 assert.equal(parents.get('child'),'root');assert.equal(parents.get('grandchild'),'child');assert.equal(parents.has('root'),false);
 for(const viewport of [320,1200]) {
  const scene=layoutSessionHierarchy(ids,parents,viewport), byId=new Map(scene.nodes.map(n=>[n.id,n]));
  assert.equal(byId.get('root').depth,0);assert.equal(byId.get('child').depth,1);assert.equal(byId.get('grandchild').depth,2);
  assert.ok(byId.get('root').y<byId.get('child').y&&byId.get('child').y<byId.get('grandchild').y);
  for(let i=0;i<scene.nodes.length;i++)for(let j=i+1;j<scene.nodes.length;j++)assert.equal(overlap(scene.nodes[i],scene.nodes[j]),false);
  assert.ok(scene.nodes.every(n=>n.x+n.width<=scene.width&&n.y+n.height<=scene.height));
 }
});
test('missing, conflicting and cyclic session ancestry never invents a parent',()=>{
 const parents=resolveSessionParents(['a','b','c','d'],[
  {fromExecutionId:'missing',toExecutionId:'a',kind:'dispatch'},
  {fromExecutionId:'a',toExecutionId:'b',kind:'dispatch'},
  {fromExecutionId:'b',toExecutionId:'a',kind:'dispatch'},
  {fromExecutionId:'a',toExecutionId:'c',kind:'dispatch'},
  {fromExecutionId:'d',toExecutionId:'c',kind:'dispatch'},
 ]);
 assert.equal(parents.size,0);
});
test('expanded execution rounds have their own collision-free in-canvas positions on desktop and mobile',()=>{
 for(const viewport of [320,800,1440]) {
  const scene=layoutFocusedSession('parent',['a','b','c'],viewport,{roleId:'b',executionIds:['run-1','run-2','run-3','run-4']});
  assert.equal(scene.executions.length,4);
  const all=[scene.parent,...scene.children,...scene.executions];
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.equal(overlap(all[i],all[j]),false);
  assert.ok(all.every(n=>n.x+n.width<=scene.width&&n.y+n.height<=scene.height));
 }
});
