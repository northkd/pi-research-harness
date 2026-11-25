import { createGiteaAdapter } from "./gitea.js";
import { createGithubAdapter } from "./github.js";
import { createGitlabAdapter } from "./gitlab.js";
function createAdapter(deps, forge, cfg) {
  const path = forge.segments.join("/");
  if (forge.forge === "github") return createGithubAdapter(deps, { host: forge.hostname, path });
  if (forge.forge === "gitlab") return createGitlabAdapter(deps, { host: forge.hostname, path });
  const hosts = cfg.forge.hosts;
  const allowlisted = hosts[forge.host] === "gitea" || hosts[forge.hostname] === "gitea";
  return createGiteaAdapter(deps, { host: forge.host, path }, { allowlisted, tokenEnv: cfg.forge.gitea.tokenEnv });
}
export {
  createAdapter
};
