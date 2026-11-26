import { describe, expect, it } from "vitest";
import {
  buildTopologyGraph,
  layoutTopologyTree,
  normalizeWorkState,
  summarizePlan,
  summarizePlansForScope,
  type TopologySessionCluster,
} from "../research-plan-topology.js";
import type { CollaborationPlan } from "../use-research-collaboration.js";

function cluster(id: string, isCaptain = false, parentId?: string): TopologySessionCluster {
  const sessionId = `s-${id}`;
  return {
    sessionExec: {
      id: `session-${sessionId}`,
      sessionId,
      kind: "pi-session",
      status: id === "ended" ? "ended" : "idle",
      source: "workflow-record",
      evidence: [],
      parentExecutionId: parentId ? `session-s-${parentId}` : undefined,
    },
    title: `会话 ${id}`,
    roleObj: { name: id, skills: [] },
    isCaptain,
    childSubs: [
      { id: `sub-${id}-1`, kind: "native-subagent", parentExecutionId: `session-${sessionId}`, role: "worker", status: "completed", source: "observation", evidence: [] },
    ],
    childRoleGroups: [
      {
        roleName: "worker",
        roleObj: { name: "worker", skills: [] },
        executions: [
          { id: `sub-${id}-1`, kind: "native-subagent", parentExecutionId: `session-${sessionId}`, role: "worker", status: "completed", source: "observation", evidence: [] },
          { id: `sub-${id}-2`, kind: "native-subagent", parentExecutionId: `session-${sessionId}`, role: "worker", status: "running", source: "observation", evidence: [] },
        ],
        latest: { id: `sub-${id}-2`, kind: "native-subagent", parentExecutionId: `session-${sessionId}`, role: "worker", status: "running", source: "observation", evidence: [] },
      },
    ],
  };
}

describe("research-plan-topology", () => {
  it("normalizes 3-state statuses and summarizes 1:N plans and tasks", () => {
    expect(normalizeWorkState("running")).toBe("in_progress");
    expect(normalizeWorkState("queued")).toBe("queued");
    expect(normalizeWorkState("completed")).toBe("ended");
    expect(normalizeWorkState("failed")).toBe("ended");

    const plans: CollaborationPlan[] = [
      {
        id: "plan-1",
        clientPlanId: "explore",
        tenureId: "t1",
        parentSessionId: "s-main",
        tasks: [
          { id: "a", role: "lit", task: "t1", status: "completed", sessionId: "s-a" },
          { id: "b", role: "experiment", task: "t2", status: "running", sessionId: "s-b" },
          { id: "c", role: "audit", task: "t3", status: "queued", waitingReason: "capacity" },
        ],
      },
      {
        id: "plan-2",
        clientPlanId: "writeup",
        tenureId: "t1",
        parentSessionId: "s-main",
        tasks: [{ id: "d", role: "writer", task: "t4", status: "completed", sessionId: "s-d" }],
      },
    ];

    expect(summarizePlan(plans[0]!).state).toBe("in_progress");
    expect(summarizePlan(plans[1]!).state).toBe("ended");

    const agg = summarizePlansForScope(plans, { tenureId: "t1", mainSessionId: "s-main" });
    expect(agg.phase).toBe("working");
    expect(agg.totalPlans).toBe(2);
    expect(agg.endedPlans).toBe(1);
    expect(agg.totalTasks).toBe(4);
    expect(agg.endedTasks).toBe(2);
    expect(agg.inProgressTasks).toBe(1);
    expect(agg.queuedTasks).toBe(1);
    expect(agg.progressPercent).toBe(50);
  });

  it("builds collision-free 4-layer coordinates across L0 Captain -> L1 Plan -> L2 Multi-Agent -> L3 Subagent -> L4 Runs", () => {
    const clusters = [cluster("main", true), cluster("ma1", false, "main"), cluster("ma2", false, "main")];
    const plans: CollaborationPlan[] = [
      {
        id: "plan-1",
        clientPlanId: "main-plan",
        parentSessionId: "s-main",
        tasks: [
          { id: "t1", role: "experiment", task: "Run 1", status: "running", sessionId: "s-ma1" },
          { id: "t2", role: "theory", task: "Run 2", status: "completed", sessionId: "s-ma2", dependsOn: ["t1"] },
          { id: "t3", role: "review", task: "Queued 3", status: "queued", dependsOn: ["t2"] },
        ],
      },
    ];
    const { items, dependencyEdges } = buildTopologyGraph({
      clusters,
      relations: [],
      plans,
      mainSessionId: "s-main",
      collapsedPlanIds: new Set(),
      expandedSessionIds: new Set(["session-s-ma1"]),
      expandedRoleKeys: new Set(["session-s-ma1\0worker"]),
    });
    const scene = layoutTopologyTree(items, dependencyEdges, 900, 900);
    const byId = new Map(scene.nodes.map(n => [n.id, n]));

    expect(byId.get("session-s-main")!.depth).toBe(0);
    expect(byId.get("plan:plan-1")!.depth).toBe(1);
    expect(byId.get("session-s-ma1")!.depth).toBe(2);
    expect(byId.get("session-s-ma2")!.depth).toBe(2);
    expect(byId.get("plan-task:plan-1:t3")!.depth).toBe(2);
    expect(byId.get("subagent:session-s-ma1:worker")!.depth).toBe(3);
    expect(byId.get("subagent-run:session-s-ma1:worker:sub-ma1-1")!.depth).toBe(4);
    expect(scene.edges).toHaveLength(2);

    // Zero overlaps invariant across every rendered node
    for (let i = 0; i < scene.nodes.length; i++) {
      for (let j = i + 1; j < scene.nodes.length; j++) {
        const a = scene.nodes[i]!, b = scene.nodes[j]!;
        const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlaps).toBe(false);
      }
      expect(scene.nodes[i]!.x).toBeGreaterThanOrEqual(0);
      expect(scene.nodes[i]!.y).toBeGreaterThanOrEqual(0);
      expect(scene.nodes[i]!.x + scene.nodes[i]!.width).toBeLessThanOrEqual(scene.width);
      expect(scene.nodes[i]!.y + scene.nodes[i]!.height).toBeLessThanOrEqual(scene.height);
    }
  });
});
