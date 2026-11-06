import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('Provide a new absolute demo project path.');
const requestedProject = path.resolve(destination);
if (!/(demo|演示)/i.test(path.basename(requestedProject))) throw new Error('Demo directory name must contain demo or 演示.');
if (fs.existsSync(requestedProject)) throw new Error('The demo destination already exists; refusing to overwrite it.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledger = await import(pathToFileURL(path.join(repo, 'extensions/research-loop/src/ledger.mjs')).href);

fs.mkdirSync(requestedProject, { recursive: false, mode: 0o700 });
const project = fs.realpathSync(requestedProject);
const materials = path.join(project, 'demo-materials');
fs.mkdirSync(materials, { mode: 0o700 });
const documents = {
  '01-目标与范围.md': `# 【演示】研究目标与范围\n\n本项目完全由虚构数据组成，用于体验 Pi Dashboard，不是科研结果。\n\n目标：用一组人工构造的钠离子导体样本演示文献、实验、评审和证据管理。\n\n- 材料名称、数值、模型记录均为示例。\n- 不代表计算、审查、模型调用或论文发表真实发生。\n- 点击真实“启动”按钮后，实际行为由本机配置决定。\n`,
  '02-文献线索.md': `# 【演示】文献线索\n\n以下为虚构的参考线索，不对应真实论文。\n\n1. DEMO-REF-01：描述瓶颈窗口与离子迁移的示例方法。\n2. DEMO-REF-02：说明温度、缺陷和采样时间可能影响比较。\n\n下一步：在真实项目中用 DOI 与原文替换这些条目。\n`,
  '03-合成实验.csv': `# 演示数据：全部数值为虚构，不可作为实验结果\n样本,条件,示例指标,重复编号\nDEMO-A,基线,0.42,1\nDEMO-A,基线,0.45,2\nDEMO-B,对照,0.58,1\nDEMO-B,对照,0.61,2\nDEMO-C,扰动,0.50,1\nDEMO-C,扰动,0.47,2\n`,
  '04-反例与评审.md': `# 【演示】反例与评审\n\n- 模拟评审甲：示例数据中的趋势可展示，但不能外推。\n- 模拟评审乙：样本量、温度范围和真实结构均未验证。\n- 模拟反例：当样本 C 的标签交换时，简单排序不再稳定。\n\n这些是人为编写的演示意见，没有调用任何评审模型。\n`,
  '05-总结草稿.md': `# 【演示】总结草稿\n\n本文件展示从尝试记录到主张的证据链。样例表格中的数值、结论与评审均为虚构。\n\n真实研究应保留原始输入、运行日志与独立核验，再决定能否支持相应主张。\n`,
  '06-用量示意.md': `# 【演示】用量示意\n\n- 初始样例包含 7 条人工构造的尝试记录。\n- 响应次数和 token 数只用于展示，不是已消费费用。\n- 当前代理未提供可核实的价格信息。\n\n研究总览只读展示用量，不需要配置研究预算。访问权限由工作流顶部的默认权限／完全访问选择控制；本文件不会改变权限或启动任务。\n`,
};
for (const [name, content] of Object.entries(documents)) fs.writeFileSync(path.join(materials, name), content, { mode: 0o600 });
const linkedArtifacts = {
  'AIMD_计算完成情况.md': '# 【演示】AIMD 计算完成情况\n\n这是供界面预览的虚构示例，没有运行 AIMD 或 DFT。请查看 demo-materials/03-合成实验.csv 中的人造样例。\n',
  'O_F关系对迁移的影响.md': '# 【演示】O/F 比例与迁移\n\n这是虚构的占位说明，没有真实材料比较或能垒结论。\n',
  'scripts/机器学习框架_三个版本/README.md': '# 【演示】三个机器学习框架\n\n此处仅展示角色详情中的文件链接，没有训练或评估任何模型。\n',
};
for (const [name, content] of Object.entries(linkedArtifacts)) {
  const file = path.join(project, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
}
fs.writeFileSync(path.join(project, 'README-演示.md'), `# 【虚构演示】科研工作台\n\n这是用于试用 Dashboard 的独立示例项目。所有任务、评审、模型名称和数据均为模拟记录，不代表真实执行或科研结论。\n\n## 推荐浏览顺序\n\n1. 在顶部打开“研究工作台”，查看课题目标与阶段记录。\n2. 打开“智能体”，切换画布、列表与角色矩阵，并点击会话或角色查看详情。\n3. 在“工作流进度”指定主 Agent、选择访问权限，并从五个阶段卡片各自启动任务。\n4. 在“研究总览”核对尝试次数和观测用量，无需填写预算或长任务授权表单。\n5. 在“主张与评审”打开演示证据；在“历史与审计”查看尝试。\n6. 在“布局”菜单尝试分屏，在“文件”中打开文件树，并查看独立的 Science 入口。\n\n带“本地模拟演示”横幅的页面仅在内存中模拟任务和权限；普通页面中的“新建会话”“独立启动阶段”按本机真实配置执行。本项目的静态样例不会自动启动任务。Science 服务和部分并行内存检查在本机仍未配置。\n`, { mode: 0o600 });

const charter = ledger.charterFrom({
  objective: '【演示】用虚构钠离子导体数据体验从调研、实验到主张评审的完整科研工作台。',
  domain: '虚构演示',
  successCriteria: ['【演示】展示五个工作流阶段。', '【演示】每条主张可打开项目内证据。', '【演示】区分已支持、待验证与受阻结果。'],
  nonGoals: ['【演示】不代表任何真实材料的性能、实验结果或论文结论。'],
  constraints: ['【演示】所有数值、任务记录及评审意见均为模拟数据。'],
});
const state = ledger.newState(charter);
state.budget = { staleAfter: 3, repeatLimit: 2 };
ledger.saveState(project, state);

const attempts = [
  ['literature','positive','【演示】梳理虚构课题边界','【演示】明确研究目标和非目标。','demo-materials/01-目标与范围.md'],
  ['literature','positive','【演示】整理模拟文献线索','【演示】生成两条不对应真实论文的线索。','demo-materials/02-文献线索.md'],
  ['hypothesis','inconclusive','【演示】提出对照假设','【演示】需要用独立样本验证，暂不作真实判断。','demo-materials/01-目标与范围.md'],
  ['experiment','positive','【演示】制作基线与对照合成数据','【演示】样例 B 的演示指标高于 A。','demo-materials/03-合成实验.csv'],
  ['analysis','positive','【演示】检查重复样例与误差范围','【演示】示例趋势只适用于虚构表格。','demo-materials/03-合成实验.csv'],
  ['dead_end','negative','【演示】尝试只按单一指标排序','【演示】交换标签后排序不稳定。','demo-materials/04-反例与评审.md'],
  ['decision','blocked','【演示】等待补充真实数据与独立复核','【演示】保留未解决义务，不把示例当作已验证结论。','demo-materials/04-反例与评审.md'],
];
for (let i = 0; i < attempts.length; i++) {
  const [kind, signal, action, observed, evidence] = attempts[i];
  const record = ledger.normalizeAttempt({ kind, signal, action, observed, expected: '【演示】展示该阶段的输入与输出。', lesson: '【演示】不构成真实研究证据。', evidence: [evidence], fingerprint: `demo-attempt-${i + 1}` });
  ledger.appendAttempt(project, state, record);
  ledger.saveState(project, state);
}

ledger.upsertClaim(state, { id: 'DEMO-C1', statement: '【演示】在虚构样例表中，B 组示例指标高于 A 组。', status: 'supported', evidence: ['demo-materials/03-合成实验.csv'], limitations: ['仅针对人工样例，不代表真实材料。'] });
ledger.gateClaim(state, { claimId: 'DEMO-C1', jury: [{ modelId: 'DEMO/模拟评审甲', family: 'demo-family-a' }, { modelId: 'DEMO/模拟评审乙', family: 'demo-family-b' }], counterexample: { status: 'completed' }, unresolvedObligations: [] });
ledger.upsertClaim(state, { id: 'DEMO-C2', statement: '【演示】这种排序在新的虚构扰动条件下仍然稳定。', status: 'partially_supported', evidence: ['demo-materials/04-反例与评审.md'], limitations: ['仍需额外反例。'] });
ledger.gateClaim(state, { claimId: 'DEMO-C2', jury: [{ modelId: 'DEMO/模拟评审甲', family: 'demo-family-a' }], counterexample: { status: 'pending' }, unresolvedObligations: ['【演示】需要第二个独立模型族与反例检查。'] });
ledger.upsertClaim(state, { id: 'DEMO-C3', statement: '【演示】示例方法可以推广到真实材料。', status: 'undetermined', evidence: ['demo-materials/05-总结草稿.md'], limitations: ['没有真实材料实验。'] });
ledger.saveState(project, state);

const runId = 'DEMO-workflow-001', launchId = 'DEMO-launch-001';
const stages = {
  '1-idea': { roles: [{ role: 'research-literature', skills: ['research-lit'], purpose: '【演示】整理示例线索' }] },
  '2-experiment': { roles: [{ role: 'research-numerics', skills: ['analyze-results'], purpose: '【演示】检查合成表格' }] },
  '3-review': { roles: [
    { role: 'research-mainline-supervisor', skills: ['research-review'], purpose: '【演示】核对目标与证据边界' },
    { role: 'research-literature', skills: ['research-lit'], purpose: '【演示】检查示例文献线索' },
    { role: 'research-numerics', skills: ['analyze-results'], purpose: '【演示】检查合成数据' },
    { role: 'research-theory', skills: ['formula-derivation'], purpose: '【演示】列出适用条件' },
    { role: 'research-critic', skills: ['research-review'], purpose: '【演示】寻找反例' },
  ] },
  '4-summary': { roles: [{ role: 'research-critic', skills: ['result-to-claim'], purpose: '【演示】对应主张与证据' }] },
  '5-writing': { roles: [{ role: 'research-writer', skills: ['paper-writing'], purpose: '【演示】整理总结' }] },
};
ledger.appendEvent(project, 'auto-run', { launchId, simulation: true, note: '【演示】没有发起真实工作流。' });
ledger.appendEvent(project, 'run-registered', { runId, launchId, charterRevision: charter.revision, configuration: { stages }, taskDir: 'demo-materials', simulation: true });
let seq = 0;
for (const stage of ['1-idea','2-experiment','3-review']) {
  ledger.appendEvent(project, 'stage-enter', { runId, stage, sourceSeq: ++seq, simulation: true });
  for (const role of stages[stage].roles) {
    const blocked = stage === '3-review' && role.role === 'research-critic';
    ledger.appendEvent(project, 'run-step', { runId, key: `DEMO-${stage}-${role.role}`, eventId: `DEMO-event-${seq}`, sourceSeq: ++seq, stage, agent: role.role, status: blocked ? 'blocked' : 'completed', label: `【演示】${role.purpose}`, observedModel: 'DEMO/模拟模型（未调用）', summary: blocked ? '【演示】反例检查尚待完成。' : '【演示】该步骤为人工构造的完成记录。', evidence: [stage === '1-idea' ? 'demo-materials/02-文献线索.md' : stage === '2-experiment' ? 'demo-materials/03-合成实验.csv' : 'demo-materials/04-反例与评审.md'], simulation: true });
  }
}
for (const stage of ['4-summary','5-writing']) {
  const role = stages[stage].roles[0];
  ledger.appendEvent(project, 'run-step', { runId, key: `DEMO-${stage}-${role.role}`, eventId: `DEMO-event-${seq}`, sourceSeq: ++seq, stage, agent: role.role, status: 'blocked', label: `【演示】${role.purpose}`, observedModel: 'DEMO/模拟模型（未调用）', summary: '【演示】该后续阶段尚未执行。', evidence: ['demo-materials/05-总结草稿.md'], simulation: true });
}
ledger.appendEvent(project, 'review-round', { runId, round: 1, verdict: '【演示】需要补充反例', observedModel: 'DEMO/模拟评审甲', diagnostics: ['【演示】样例数据不能作为真实证据。'], simulation: true });
ledger.appendEvent(project, 'review-gate', { runId, round: 2, verdict: '【演示】部分通过、部分待验证', observedModel: 'DEMO/模拟评审乙', diagnostics: ['【演示】C2 尚缺独立复核。'], simulation: true });
ledger.appendEvent(project, 'run-outcome', { runId, sourceSeq: ++seq, status: 'blocked', reason: '【演示】等待虚构的后续验证；没有任务正在运行。', simulation: true });
console.log(`Created a clearly labelled demo project with ${attempts.length} synthetic attempts and ${state.claims.length} claims.`);
console.log('Local simulation: http://127.0.0.1:8000/res-workflow-demo.html?res-demo=1&demo-project='+encodeURIComponent(project));
