import path from 'node:path';

const PRIVATE_PATHS = ['/internal', '/internal/*', '/mcp', '/mcp/*', '/api/internal', '/api/internal/*'];
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) fail('proxy-path-invalid');
  return value;
}

function address(value, fixture) {
  let url;
  try { url = new URL(value); } catch { fail('proxy-address-invalid'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname || !url.port) fail('proxy-address-invalid');
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('proxy-port-invalid');
  if (fixture ? url.protocol !== 'http:' || url.hostname !== '127.0.0.1' : url.protocol !== 'https:') fail('proxy-address-scope-invalid');
  return url.origin;
}

export function createCaddyCutoverTemplate({ publicAddress, upstreamPort = 18768, frontendRoot, accessLog, fixture = false } = {}) {
  const site = address(publicAddress, fixture);
  if (frontendRoot !== undefined && frontendRoot !== null) absolute(frontendRoot);
  absolute(accessLog);
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) fail('proxy-port-invalid');
  const commonProxy = `reverse_proxy 127.0.0.1:${upstreamPort} {
                header_up -Authorization
                header_up -Cookie
                header_up X-Pi-Local-Token {$PI_RESEARCH_HOST_TOKEN}
            }`;
  const template = `{
    admin ${fixture ? 'off' : '127.0.0.1:2019'}
    auto_https disable_redirects
    skip_install_trust
${fixture ? '' : '    default_sni ' + new URL(site).hostname + '\n'}    log {
        format filter {
            wrap json
            fields {
                request>headers delete
                request>uri delete
            }
        }
    }
    servers {
        protocols h1
    }
}

${site} {
${fixture ? '' : '    tls internal\n'}    log {
        output file ${JSON.stringify(accessLog)} {
            mode 0600
        }
        format filter {
            wrap json
            fields {
                request>headers delete
                request>uri delete
            }
        }
    }
    header {
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
    }
    route {
        basic_auth {
            {$PI_RESEARCH_UI_USER} {$PI_RESEARCH_UI_PASSWORD_HASH}
        }
        @private path ${PRIVATE_PATHS.join(' ')}
        respond @private 404
        @traversal path_regexp traversal (?i)(^|/)(\\.\\.?)(/|$)|%2e|%2f|%5c|\\\\
        respond @traversal 404
        @api path /api /api/*
        handle @api {
            request_header -X-Pi-Local-Token
            request_header -X-Pi-Local-Proof
            request_header -X-Pi-Caller-Local
            ${commonProxy}
        }
        handle /ws {
            request_header -X-Pi-Local-Token
            request_header -X-Pi-Local-Proof
            request_header -X-Pi-Caller-Local
            ${commonProxy}
        }
${frontendRoot ? `        handle {
            root * ${JSON.stringify(frontendRoot)}
            try_files {path} /index.html
            header Cache-Control no-store
            file_server
        }` : `        handle / {
            request_header -X-Pi-Local-Token
            request_header -X-Pi-Local-Proof
            request_header -X-Pi-Caller-Local
            rewrite * /api/health
            ${commonProxy}
        }
        handle {
            respond 404
        }`}
    }
}
`;
  return { template, site, upstream: `127.0.0.1:${upstreamPort}`, accessLog, frontendRoot: frontendRoot ?? null, headless: !frontendRoot,
    credentialEnvironment: ['PI_RESEARCH_UI_USER', 'PI_RESEARCH_UI_PASSWORD_HASH', 'PI_RESEARCH_HOST_TOKEN'],
    blockedPaths: [...PRIVATE_PATHS],
  };
}

export function validateProxyEnvironment(env) {
  if (!env || typeof env.PI_RESEARCH_UI_USER !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(env.PI_RESEARCH_UI_USER) ||
    typeof env.PI_RESEARCH_UI_PASSWORD_HASH !== 'string' || !/^\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}$/.test(env.PI_RESEARCH_UI_PASSWORD_HASH) ||
    typeof env.PI_RESEARCH_HOST_TOKEN !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(env.PI_RESEARCH_HOST_TOKEN)) fail('proxy-credential-environment-invalid');
  return true;
}
