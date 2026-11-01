import test from 'node:test';
import assert from 'node:assert/strict';
import { getMultiAgentTitle, getAgentMission, projectRecordedSteps, getResearchProjectCharter } from '../patches/dashboard-v0.20/overlay/packages/client/src/components/research/research-presentation.ts';

test('session title and mission come from observed input, never an invented project narrative', () => {
  const row={id:'synthetic-01',kind:'pi-session',prompt:'测试合成材料\n[首条指令] 请核对数据',evidence:[]};
  assert.equal(getMultiAgentTitle(row),'测试合成材料');
  assert.match(getAgentMission('synthetic',false,row.kind,row),/请核对数据/);
  assert.equal(getAgentMission('researcher',false,'native-subagent'), '暂无已记录的任务职责');
});
test('workflow cards contain only recorded steps and do not invent dependencies or completion', () => {
  const run={runId:'demo',steps:[{key:'a',agent:'analyst',label:'检查',status:'failed',evidence:[]},{key:'b',agent:'critic',status:'running',summary:'复核',evidence:[]}]};
  const cards=projectRecordedSteps(run);
  assert.deepEqual(cards.map(x=>x.status),['failed','running']);
  assert.equal(cards[0].subject,'检查');
  assert.equal(cards[1].duty,'复核');
  assert.ok(cards.every(x=>!('dependencies' in x) && !('unlocks' in x)));
  assert.deepEqual(projectRecordedSteps(null),[]);
});
test('charter reports observed prompt and evidence rather than claiming fixed deliverables',()=>{
  const c=getResearchProjectCharter('analyst',false,'native-subagent',{prompt:'核对样本',evidence:['evidence/a.md']});
  assert.equal(c.dutySummary,'核对样本');
  assert.deepEqual(c.deliverables,['evidence/a.md']);
  assert.deepEqual(getResearchProjectCharter('analyst',false,'native-subagent').deliverables,[]);
});
