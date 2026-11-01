import leadArt from "../../assets/agent-teams/team-lead-v2.png";
import researcherArt from "../../assets/agent-teams/member-researcher-v2.png";
import engineerArt from "../../assets/agent-teams/member-engineer-v2.png";
import dataArt from "../../assets/agent-teams/member-data-v2.png";
import qaArt from "../../assets/agent-teams/member-qa-v2.png";
import securityArt from "../../assets/agent-teams/member-security-v2.png";
import docsArt from "../../assets/agent-teams/member-docs-v2.png";
import designerArt from "../../assets/agent-teams/member-designer-v2.png";
import operatorArt from "../../assets/agent-teams/member-operator-v2.png";

import actionWorking from "../../assets/agent-teams/action-working-v2.png";
import actionThinking from "../../assets/agent-teams/action-thinking-v2.png";
import actionSleeping from "../../assets/agent-teams/action-sleeping-v2.png";
import actionCelebrating from "../../assets/agent-teams/action-celebrating-v2.png";

export {
  leadArt,
  researcherArt,
  engineerArt,
  dataArt,
  qaArt,
  securityArt,
  docsArt,
  designerArt,
  operatorArt,
  actionWorking,
  actionThinking,
  actionSleeping,
  actionCelebrating,
};

export function getMemberArt(roleName: string, isCaptain: boolean = false): string {
  if (isCaptain) return leadArt;
  const r = (roleName || "").toLowerCase();
  if (r.includes("data") || r.includes("calc") || r.includes("numeric") || r.includes("metric") || r.includes("数值")) {
    return dataArt;
  }
  if (r.includes("critic") || r.includes("review") || r.includes("audit") || r.includes("security") || r.includes("审查") || r.includes("对抗")) {
    return securityArt;
  }
  if (r.includes("mainline") || r.includes("supervis") || r.includes("ssh") || r.includes("queue") || r.includes("engineer") || r.includes("收敛")) {
    return engineerArt;
  }
  if (r.includes("writ") || r.includes("paper") || r.includes("doc") || r.includes("写作") || r.includes("论文")) {
    return docsArt;
  }
  if (r.includes("qa") || r.includes("test") || r.includes("verif")) {
    return qaArt;
  }
  return researcherArt;
}

export function getActionArt(status: string): string {
  const s = (status || "").toLowerCase();
  if (s.includes("stream") || s.includes("run") || s.includes("start") || s.includes("work")) {
    return actionWorking;
  }
  if (s.includes("think") || s.includes("wait") || s.includes("queue") || s.includes("plan")) {
    return actionThinking;
  }
  if (s.includes("complete") || s.includes("converge") || s.includes("done")) {
    return actionCelebrating;
  }
  return actionSleeping;
}
