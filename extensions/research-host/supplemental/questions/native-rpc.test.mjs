import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSelectedPi } from '../../compat/provider-auth/runtime.mjs';

test('installed offline Pi persists native dialog answers, attachment acceptance and real ToolResult image content', { timeout: 20_000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-question-real-rpc-'));
  const piCli = process.env.PI_QUESTION_TEST_CLI ?? path.join(path.dirname((await loadSelectedPi()).entry), 'bundle/cli.js');
  const homeDir = path.join(temporary, 'home');
  const agentDir = path.join(temporary, 'agent');
  const extension = path.join(temporary, 'fixture.mjs');
  const sessionFile = path.join(temporary, 'synthetic.jsonl');
  await fs.mkdir(homeDir); await fs.mkdir(agentDir);
  const nativePath = fileURLToPath(new URL('./native.mjs', import.meta.url));
  await fs.writeFile(extension, `import { registerNativeQuestionTools } from ${JSON.stringify(nativePath)};
export default function(pi) {
  const native = registerNativeQuestionTools(pi, {remoteDialogs:false,getConfig:()=>({askUserPromptTimeoutSeconds:-1,stateDir:${JSON.stringify(temporary)}}),publishContext:data=>process.stderr.write(JSON.stringify({fixtureContext:data})+'\\n')});
  native.register();
  pi.registerCommand('__question_rpc_fixture', {description:'Offline local fixture', async handler(_args,ctx) {
    const result = await native.tool.execute('synthetic-tool', {method:'select',title:'Synthetic offline choice',options:['First','Second'],allowOther:false}, undefined, undefined, ctx);
    pi.appendEntry('synthetic-question-result', result);
  }});
  pi.registerCommand('__question_image_fixture', {description:'Offline image fixture', async handler(_args,ctx) {
    const result = await native.tool.execute('synthetic-image-tool', {method:'input',title:'Synthetic offline image'}, undefined, undefined, ctx);
    pi.appendEntry('synthetic-question-image-result', result);
  }});
  pi.registerCommand('__question_image_answer', {description:'Offline receipt fixture', async handler(args,ctx) {
    const data=JSON.parse(Buffer.from(args,'base64url').toString('utf8'));
    const result=await native.consumeEvent({eventId:'synthetic-offline-image-answer',eventType:'research-host:question-response',data},ctx);
    if(result.status!=='accepted') throw new Error('offline-image-receipt-rejected');
  }});
}
`);
  const now = new Date().toISOString();
  await fs.writeFile(sessionFile, [
    { type: 'session', version: 3, id: randomUUID(), timestamp: now, cwd: temporary },
    { type: 'message', id: randomUUID().replaceAll('-', '').slice(0, 8), parentId: null, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'Synthetic offline seed' }], timestamp: Date.now() } },
  ].map(JSON.stringify).join('\n') + '\n');
  try {
    const driver = fileURLToPath(new URL('./native-rpc-driver.py', import.meta.url));
    const output = execFileSync('python3', [driver, piCli, temporary, sessionFile, extension], { cwd: temporary, encoding: 'utf8', timeout: 18_000, env: { PATH: process.env.PATH, PI_QUESTION_NODE: process.execPath } });
    assert.deepEqual(JSON.parse(output), { nativeSelect: true, modelImage: true, persistedReceipt: true, imageBytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64').length });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
