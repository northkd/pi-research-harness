// Keep address and process-environment rules independent of Electron for testing.
export function normalizeDashboardUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('请输入有效的 Dashboard 地址。');
  const url = new URL(raw.trim());
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('远程地址需要 HTTPS；本机服务可使用 http://127.0.0.1:端口。');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error('请输入服务的基础地址，账号、密码和令牌请在登录页面填写。');
  }
  return url.href;
}

export function navigationAction(baseUrl, targetUrl) {
  try {
    const base = new URL(baseUrl);
    const target = new URL(targetUrl);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) return 'deny';
    return base.origin === target.origin ? 'allow' : 'external';
  } catch { return 'deny'; }
}

export function withRuntimePath(environment, directories, platform = process.platform) {
  const copy = { ...environment };
  const key = Object.keys(copy).find((name) => name.toLowerCase() === 'path') || 'PATH';
  const separator = platform === 'win32' ? ';' : ':';
  copy[key] = [...directories.filter(Boolean), copy[key] || ''].join(separator);
  return copy;
}

export function validateHealth(body, childPid) {
  return body && body.ok === true && body.pid === childPid &&
    body.mode !== 'recovery' && !body.recovery;
}
