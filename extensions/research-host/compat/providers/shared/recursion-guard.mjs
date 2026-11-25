import os from "node:os";
function collectDashboardOrigins(port, opts) {
  const origins = [
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`
  ];
  try {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.internal) continue;
        const addr = entry.family === "IPv6" ? `[${entry.address}]` : entry.address;
        origins.push(`${addr}:${port}`);
      }
    }
  } catch {
  }
  if (opts?.tunnelHostname) origins.push(opts.tunnelHostname);
  if (opts?.mdnsHostname) origins.push(`${opts.mdnsHostname}:${port}`);
  return origins;
}
function isSelfPointing(baseUrl, dashboardOrigins) {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const normalized = `${host}:${port}`;
    const normalizedHostOnly = host;
    for (const origin of dashboardOrigins) {
      const originLower = origin.toLowerCase();
      if (originLower === normalized) return true;
      if (originLower === normalizedHostOnly) return true;
      if (originLower.includes(":")) {
        if (originLower === normalized) return true;
      } else {
        if (originLower === normalizedHostOnly) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
export {
  collectDashboardOrigins,
  isSelfPointing
};
