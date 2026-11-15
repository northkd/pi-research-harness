import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTenureHierarchy } from '../patches/dashboard-v0.20/overlay/packages/client/src/components/research/research-agent-canvas-layout.ts';

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('a lead stays left of parallel collaborators and each native child keeps its real parent', () => {
  const items = [{ id:'lead', kind:'session' }, ...Array.from({length:4}, (_, i) => ({ id:`multi-${i}`, kind:'session', parentId:'lead' })),
    { id:'s1', kind:'subagent', parentId:'multi-1' }, { id:'s2', kind:'subagent', parentId:'multi-1' }, { id:'s3', kind:'subagent', parentId:'multi-2' }];
  const scene = layoutTenureHierarchy('lead', items), byId = new Map(scene.nodes.map(node => [node.id, node]));
  const multi = scene.nodes.filter(node => node.id.startsWith('multi-'));
  assert.equal(new Set(multi.map(node => node.y)).size, 1);
  assert.ok(multi.every(node => node.x > byId.get('lead').x + byId.get('lead').width));
  assert.ok(multi.every(node => node.parentId === 'lead'));
  assert.equal(byId.get('s2').parentId, 'multi-1');
  assert.ok(byId.get('s2').y > byId.get('multi-1').y + byId.get('multi-1').height);
  for (let i = 0; i < scene.nodes.length; i++) for (let j = i + 1; j < scene.nodes.length; j++) assert.equal(overlap(scene.nodes[i], scene.nodes[j]), false);
});

test('more than four collaborators keep separate readable lanes with arbitrary nested executions', () => {
  const items = [{ id:'lead', kind:'session' }];
  for (let i = 0; i < 12; i++) {
    items.push({ id:`m-${i}`, kind:'session', parentId:'lead' });
    for (let j = 0; j < 7; j++) items.push({ id:`s-${i}-${j}`, kind:'subagent', parentId:`m-${i}` });
  }
  items.push({ id:'nested-multi', kind:'session', parentId:'m-3' }, { id:'nested-sub', kind:'subagent', parentId:'nested-multi' });
  const scene = layoutTenureHierarchy('lead', items);
  assert.equal(scene.nodes.length, items.length);
  assert.equal(scene.nodes.find(node => node.id === 'nested-sub').parentId, 'nested-multi');
  for (let i = 0; i < scene.nodes.length; i++) for (let j = i + 1; j < scene.nodes.length; j++) assert.equal(overlap(scene.nodes[i], scene.nodes[j]), false);
  assert.ok(scene.nodes.every(node => node.x >= 0 && node.y >= 0 && node.x + node.width <= scene.width && node.y + node.height <= scene.height));
});

test('unloaded ancestry is separate and a former child promoted to main is never reparented to its old parent', () => {
  const scene = layoutTenureHierarchy('new-main', [
    { id:'new-main', kind:'session', parentId:'old-main' }, { id:'old-main', kind:'session' },
    { id:'worker', kind:'session', parentId:'new-main' }, { id:'unknown', kind:'session', parentId:'missing' },
  ]);
  assert.equal(scene.nodes.find(node => node.id === 'new-main').parentId, null);
  assert.equal(scene.nodes.find(node => node.id === 'worker').parentId, 'new-main');
  assert.deepEqual(scene.orphanIds, ['old-main', 'unknown']);
  assert.ok(scene.nodes.filter(node => scene.orphanIds.includes(node.id)).every(node => node.y >= scene.orphanTop));
});

test('a missing lead is a truthful placeholder and corrupt cycles cannot invent dispatch edges', () => {
  const scene = layoutTenureHierarchy('missing-lead', [
    { id:'a', kind:'session', parentId:'b' }, { id:'b', kind:'session', parentId:'a' },
  ]);
  assert.equal(scene.nodes.length, 3);
  assert.equal(scene.main.id, 'missing-lead');
  assert.ok(scene.nodes.every(node => node.parentId === null));
});
