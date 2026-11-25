/** Display only facts supplied by the current project's execution records. */
export interface RecordedExecution {
  id: string;
  kind?: string;
  prompt?: string;
  summary?: string;
  evidence?: string[];
}
export interface RecordedStep {
  key: string;
  agent: string;
  label?: string;
  status: string;
  summary?: string;
}
export interface RecordedRun { runId: string; steps: RecordedStep[] }

export function getMultiAgentTitle(row: RecordedExecution): string {
  const [head = '', instruction = ''] = (row.prompt ?? '').trim().split(/\n+\[首条指令\]\s*/);
  const cleaned = head.replace(/^\/goal\s+/i, '').replace(/^\/skill:\S+\s*/i, '')
    .replace(/【阶段独立启动任务】/g, '').replace(/\s+/g, ' ').trim();
  const title = cleaned || instruction.replace(/\s+/g, ' ').trim();
  if (!title) return `Pi 协同会话 (${row.id.slice(-6)})`;
  return title.length > 32 ? `${title.slice(0, 30)}…` : title;
}

export function getAgentMission(_roleName: string, _isCaptain: boolean, _kind?: string, row?: RecordedExecution, _cwd?: string): string {
  const mission = (row?.prompt || row?.summary || '').replace(/\n+\[首条指令\]\s*/g, ' · ').replace(/\s+/g, ' ').trim();
  return mission ? (mission.length > 160 ? `${mission.slice(0, 158)}…` : mission) : '暂无已记录的任务职责';
}

export function getResearchProjectCharter(roleName: string, isCaptain: boolean, kind?: string, execution?: RecordedExecution, _cwd?: string) {
  return {
    projectTitle: roleName || '智能体',
    dutySummary: getAgentMission(roleName, isCaptain, kind, execution),
    deliverables: (execution?.evidence ?? []).filter(p => typeof p === 'string'),
    scientificScope: '当前项目',
  };
}

export function projectRecordedSteps(run: RecordedRun | null) {
  return (run?.steps ?? []).map((step, index) => ({
    displayId: `#${index + 1}`,
    id: `${run!.runId}:${step.key}`,
    runId: run!.runId,
    key: step.key,
    subject: step.label || step.key,
    assignee: step.agent || '未报告角色',
    status: step.status,
    duty: step.summary || '暂无已记录的阶段说明',
  }));
}
