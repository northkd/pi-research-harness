import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function makeSettings(template, repo, options = {}) {
  const settings = structuredClone(template);
  settings.packages = [...settings.packages, repo];
  // The adapter owns configured MCP tools; avoid duplicate builtin discovery.
  settings.extensions = ['-builtin:mcp'];
  if (options.dashboard) settings.packages.push(path.join(repo, '.runtime/dashboard-source/packages/extension'));
  if (options.dashboardPlugins) {
    if (!options.dashboard) throw new Error('Dashboard plugin bridges require dashboard mode');
    const base = path.join(repo, '.runtime/dashboard-source/packages');
    const bridges = {
      'dashboard-automation': path.join(base, 'automation-plugin/src/bridge/index.ts'),
      'dashboard-flows': path.join(base, 'flows-plugin/src/bridge/index.ts'),
      'dashboard-goal': path.join(base, 'goal-plugin/src/bridge/index.ts'),
      'dashboard-flows-anthropic-bridge': path.join(base, 'flows-anthropic-bridge-plugin/src/bridge/index.ts'),
    };
    settings.dashboardPluginBridges = bridges;
    settings._dashboardManagedPackages = Object.fromEntries(Object.entries(bridges).map(([name, source]) => [source, name]));
    settings.packages.push(...Object.values(bridges));
  }
  if (options.bundledSkills) settings.skills = [
    path.join(repo, 'vendor/skills/aris'),
    path.join(repo, 'vendor/skills/licensed'),
    '-' + path.join(repo, 'vendor/skills/aris/paper-writing/SKILL.md'),
    '-' + path.join(repo, 'vendor/skills/aris/research-review/SKILL.md'),
  ];
  if (options.image) settings.extensions.push(path.join(repo, 'extensions/image-generation.ts'));
  return settings;
}

export function makeMcp(repo, _agentDir, options = {}) {
  const mcpServers = {};
  if (options.dashboard) mcpServers['pi-dashboard'] = {url:'http://127.0.0.1:8000/mcp'};
  if (options.browser) mcpServers['research-browser'] = {
    command:process.execPath,
    args:[path.join(repo,'.runtime/browser-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),'--browserUrl=http://127.0.0.1:9222','--no-usage-statistics','--no-performance-crux'],
  };
  return {mcpServers};
}

export async function configure(repo, agentDir, options = {}) {
  if (!path.isAbsolute(repo) || !path.isAbsolute(agentDir)) throw new Error('Use absolute repo and agent-directory paths');
  let template;
  try {
    template = JSON.parse(await fs.readFile(path.join(repo,'config/settings.example.json'),'utf8'));
  } catch (error) {
    throw new Error('Cannot read valid released settings template', {cause: error});
  }
  const settings = makeSettings(template,repo,options);
  if (options.dryRun) return {repo,agentDir,settings,mcp:makeMcp(repo,agentDir,options)};
  try {
    const entries = await fs.readdir(agentDir);
    if (entries.length) throw Object.assign(new Error('Refuse non-empty agent directory'), {code:'EEXIST'});
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(agentDir,{recursive:true,mode:0o700});
  // Never replace existing personal configuration, sessions, or auth.
  await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify(settings,null,2)+'\n',{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(agentDir,'mcp.json'),JSON.stringify(makeMcp(repo,agentDir,options),null,2)+'\n',{flag:'wx',mode:0o600});
  await fs.copyFile(path.join(repo,'config/models.example.json'),path.join(agentDir,'models.example.json'),fs.constants.COPYFILE_EXCL);
  await fs.copyFile(path.join(repo,'config/AGENTS.md'),path.join(agentDir,'AGENTS.md'),fs.constants.COPYFILE_EXCL);
  await fs.mkdir(path.join(agentDir,'agents'),{recursive:true});
  for (const name of await fs.readdir(path.join(repo,'agents'))) {
    if (name.endsWith('.md')) await fs.copyFile(path.join(repo,'agents',name),path.join(agentDir,'agents',name),fs.constants.COPYFILE_EXCL);
  }
  return {repo,agentDir,configured:true};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  const agentDir=path.resolve(process.env.PI_RESEARCH_AGENT_DIR || path.join(os.homedir(),'.local/share/pi-research-harness/agent'));
  const result=await configure(repositoryRoot,agentDir,{dashboard:flags.has('--with-dashboard') || flags.has('--with-dashboard-plugins'),dashboardPlugins:flags.has('--with-dashboard-plugins'),bundledSkills:flags.has('--with-bundled-skills'),browser:flags.has('--with-browser'),image:flags.has('--enable-image-generation'),dryRun:flags.has('--dry-run')});
  console.log(JSON.stringify(result,null,2));
}
