// <stdin>
import crypto from "node:crypto";
function createOAuthFlowStore(options = {}) {
  const FLOW_TTL_MS = 10 * 60 * 1e3;
  const DEVICE_CODE_TTL_SLACK_MS = 60 * 1e3;
  const FLOW_START_TIMEOUT_MS = options.startTimeoutMs ?? 15e3;
  const PRUNE_INTERVAL_MS = 6e4;
  const SUPERSEDE_SETTLE_TIMEOUT_MS = 2e3;
  const flows = /* @__PURE__ */ new Map();
  function getFlow(flowId) {
    return flows.get(flowId);
  }
  function flowStoreSize() {
    return flows.size;
  }
  function deleteFlow(flowId) {
    flows.delete(flowId);
  }
  function pendingFlowsFor(provider) {
    return [...flows.values()].filter(
      (flow) => flow.provider === provider && flow.status === "pending"
    );
  }
  function toFlowStatus(flow) {
    const status = {
      flowId: flow.id,
      provider: flow.provider,
      status: flow.status
    };
    if (flow.authUrl !== void 0) status.authUrl = flow.authUrl;
    if (flow.message !== void 0) status.message = flow.message;
    if (flow.status === "pending" && flow.pending !== void 0) {
      status.pending = flow.pending;
    }
    if (flow.error !== void 0) status.error = flow.error;
    return status;
  }
  function cancelFlow(flow) {
    flow.cancelled = true;
    flow.abort.abort();
  }
  function pruneFlows(now = Date.now()) {
    for (const [id, flow] of [...flows]) {
      if (now < flow.expiresAt) continue;
      if (flow.status === "pending") cancelFlow(flow);
      flows.delete(id);
    }
  }
  function abortAllFlows() {
    for (const flow of flows.values()) cancelFlow(flow);
    flows.clear();
  }
  function startFlowPruneTimer() {
    const timer = setInterval(() => pruneFlows(), PRUNE_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  function clearPending(flow) {
    flow.pending = void 0;
    flow.resolveInput = void 0;
    flow.rejectInput = void 0;
  }
  function toPending(prompt) {
    switch (prompt.type) {
      case "secret":
        return { kind: "secret", message: prompt.message, ...prompt.placeholder !== void 0 ? { placeholder: prompt.placeholder } : {} };
      case "manual_code":
        return prompt.placeholder === void 0 ? { kind: "manual_code", message: prompt.message } : {
          kind: "manual_code",
          message: prompt.message,
          placeholder: prompt.placeholder
        };
      case "text":
        return prompt.placeholder === void 0 ? { kind: "text", message: prompt.message } : { kind: "text", message: prompt.message, placeholder: prompt.placeholder };
      case "select":
        return {
          kind: "select",
          message: prompt.message,
          options: prompt.options.map(
            (o) => o.description === void 0 ? { id: o.id, label: o.label } : { id: o.id, label: o.label, description: o.description }
          )
        };
      default:
        return { kind: "text", message: prompt.message };
    }
  }
  function applyDeviceCode(flow, event) {
    flow.pending = {
      kind: "device_code",
      userCode: event.userCode,
      verificationUri: event.verificationUri,
      ...typeof event.intervalSeconds === "number" ? { intervalSeconds: event.intervalSeconds } : {},
      ...typeof event.expiresInSeconds === "number" ? { expiresInSeconds: event.expiresInSeconds } : {}
    };
    if (typeof event.expiresInSeconds === "number" && Number.isFinite(event.expiresInSeconds) && event.expiresInSeconds > 0) {
      const deadline = Date.now() + event.expiresInSeconds * 1e3;
      flow.deviceCodeDeadline = deadline;
      flow.expiresAt = Math.max(flow.expiresAt, deadline + DEVICE_CODE_TTL_SLACK_MS);
    }
  }
  function createFlowInteraction(flow, hooks) {
    flow.abort.signal.addEventListener(
      "abort",
      () => {
        flow.rejectInput?.(new Error("Cancelled"));
      },
      { once: true }
    );
    const notify = (event) => {
      if (event.type === "auth_url") {
        const first = flow.authUrl === void 0;
        flow.authUrl = event.url;
        if (first && !flow.cancelled) hooks.openInBrowser?.(event.url);
        hooks.onFirstStep();
        return;
      }
      if (event.type === "device_code") {
        applyDeviceCode(flow, event);
        hooks.onFirstStep();
        return;
      }
      flow.message = event.message;
    };
    const prompt = (p) => {
      if (!["secret", "manual_code", "select", "text"].includes(p.type)) {
        return Promise.reject(new Error(`unsupported prompt: ${p.type}`));
      }
      flow.promptCount += 1;
      const isFirst = flow.promptCount === 1;
      if (isFirst) {
        const preAnswers = flow.preAnswers;
        flow.preAnswers = [];
        if (p.type === "text" && preAnswers.length > 0) {
          return Promise.resolve(preAnswers[0]);
        }
      }
      const pending = toPending(p);
      const promptSignal = p.signal;
      return new Promise((resolve, reject) => {
        let done = false;
        const settleResolve = (value) => {
          if (done) return;
          done = true;
          recordSubmitted(flow, value);
          cleanup();
          resolve(value);
        };
        const settleReject = (error) => {
          if (done) return;
          done = true;
          cleanup();
          reject(error);
        };
        const onPromptAbort = () => {
          settleReject(new Error("Cancelled"));
        };
        function cleanup() {
          if (flow.resolveInput === settleResolve) flow.resolveInput = void 0;
          if (flow.rejectInput === settleReject) flow.rejectInput = void 0;
          if (flow.pending === pending) flow.pending = void 0;
          promptSignal?.removeEventListener("abort", onPromptAbort);
        }
        flow.pending = pending;
        flow.resolveInput = settleResolve;
        flow.rejectInput = settleReject;
        if (promptSignal) {
          if (promptSignal.aborted) {
            settleReject(new Error("Cancelled"));
            return;
          }
          promptSignal.addEventListener("abort", onPromptAbort, { once: true });
        }
        hooks.onFirstStep();
      });
    };
    return { signal: flow.abort.signal, notify, prompt };
  }
  const WITHHELD_ERROR_MESSAGE = "Sign-in failed (details withheld: the error echoed submitted input)";
  function recordSubmitted(flow, value) {
    const fragments = [value.trim()];
    try {
      const url = new URL(value.trim());
      for (const v of url.searchParams.values()) fragments.push(v);
      if (url.hash.length > 1) {
        for (const v of new URLSearchParams(url.hash.slice(1)).values()) fragments.push(v);
      }
    } catch {
    }
    for (const f of fragments) if (f.length > 0) flow.submitted.push(f);
  }
  function withholdEchoedInput(error, submitted) {
    return submitted.some((f) => quotes(error, f)) ? WITHHELD_ERROR_MESSAGE : error;
  }
  const SUBSTRING_MATCH_MIN = 4;
  function quotes(error, fragment) {
    if (fragment.length >= SUBSTRING_MATCH_MIN) return error.includes(fragment);
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(error);
  }
  const piDeviceIdReader = options.getDeviceId;
  async function loadPiDeviceId() {
  }
  function startFlow(params) {
    let resolveSettled = () => {
    };
    const settled = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    const createdAt = Date.now();
    const flow = {
      id: crypto.randomUUID(),
      provider: params.provider,
      status: "pending",
      createdAt,
      expiresAt: createdAt + FLOW_TTL_MS,
      cancelled: false,
      preAnswers: [...params.preAnswers],
      submitted: [],
      promptCount: 0,
      abort: new AbortController(),
      settled
    };
    flows.set(flow.id, flow);
    let resolveFirstEvent = () => {
    };
    let firstEventSeen = false;
    const firstEvent = new Promise((resolve) => {
      resolveFirstEvent = resolve;
    });
    const onFirstStep = () => {
      if (firstEventSeen) return;
      firstEventSeen = true;
      resolveFirstEvent();
    };
    const finish = (status, error) => {
      flow.status = status;
      if (error !== void 0) flow.error = withholdEchoedInput(error, flow.submitted);
      flow.submitted = [];
      clearPending(flow);
    };
    const loginCall = (() => {
      try {
        return Promise.resolve(
          params.loginFlow.login(
            createFlowInteraction(flow, {
              onFirstStep,
              openInBrowser: params.openInBrowser
            }),
            { getDeviceId: params.getDeviceId ?? piDeviceIdReader }
          )
        );
      } catch (err) {
        return Promise.reject(err);
      }
    })();
    loginCall.then(async (credential) => {
      if (flow.cancelled) {
        finish("error", "Cancelled");
        return;
      }
      try {
        await params.writeCredential(flow.provider, credential);
      } catch (err) {
        finish("error", err instanceof Error ? err.message : String(err));
        return;
      }
      params.notifyBridges();
      finish("complete");
    }).catch((err) => {
      finish(
        deriveFailureState(flow),
        flow.cancelled ? "Cancelled" : err instanceof Error ? err.message : String(err)
      );
    }).finally(() => {
      resolveSettled();
    });
    return { flow, firstEvent, settled };
  }
  function deriveFailureState(flow) {
    if (flow.cancelled) return "error";
    if (flow.deviceCodeDeadline !== void 0 && Date.now() >= flow.deviceCodeDeadline) {
      return "expired";
    }
    return "error";
  }
  return { startFlow, getFlow, toFlowStatus, cancelFlow, pruneFlows, abortAllFlows, startFlowPruneTimer, pendingFlowsFor, deleteFlow, FLOW_START_TIMEOUT_MS, SUPERSEDE_SETTLE_TIMEOUT_MS };
}
function oauthIdsFrom(entries, authData) {
  const ids = new Set(entries.map((e) => e.id));
  for (const [id, cred] of Object.entries(authData)) {
    if (cred?.type === "oauth") ids.add(id);
  }
  return ids;
}
function oauthRowExpires(cred) {
  return cred.refresh ? cred.expires : null;
}
function _buildAuthStatus(catalogue, authData, oauthEntries) {
  const statuses = [];
  const oauthIds = oauthIdsFrom(oauthEntries, authData);
  const pushOAuthRow = (id, name, flowType, subscription) => {
    const cred = authData[id];
    const sub = subscription === void 0 ? {} : { subscription };
    if (cred?.type === "oauth") {
      statuses.push({
        id,
        name,
        flowType,
        authenticated: true,
        expires: oauthRowExpires(cred),
        configured: true,
        source: "stored",
        ...sub
      });
    } else {
      statuses.push({ id, name, flowType, authenticated: false, configured: false, ...sub });
    }
  };
  const registryIds = /* @__PURE__ */ new Set();
  for (const entry of oauthEntries) {
    registryIds.add(entry.id);
    pushOAuthRow(entry.id, entry.name, entry.flowType, entry.subscription);
  }
  for (const [id, cred] of Object.entries(authData)) {
    if (cred?.type !== "oauth" || registryIds.has(id)) continue;
    pushOAuthRow(id, id, "device_code");
  }
  for (const entry of catalogue) {
    if (entry.custom) continue;
    const hasOAuthCollision = oauthIds.has(entry.id);
    const uiId = hasOAuthCollision ? `${entry.id}-api` : entry.id;
    const displayName = hasOAuthCollision ? `${entry.displayName} (API Key)` : entry.displayName;
    const authJsonKey = entry.id;
    const cred = authData[authJsonKey];
    const hasStoredKey = !!(cred && cred.type === "api_key" && cred.key);
    const rowConfigured = hasStoredKey || !!entry.ambient || entry.configured && entry.source != null && entry.source !== "stored";
    const envLabelAuth = !hasStoredKey && entry.configured && entry.source === "environment" && !!entry.authLabel && !entry.envVar && !entry.ambient;
    const row = {
      id: uiId,
      name: displayName,
      flowType: "api_key",
      authenticated: hasStoredKey || !!entry.ambient || envLabelAuth,
      configured: rowConfigured
    };
    if (hasStoredKey) row.source = "stored";
    else if (rowConfigured && entry.source != null) row.source = entry.source;
    if (hasStoredKey) {
      const key = cred.key;
      row.maskedKey = key.length >= 12 ? `${key.slice(0, 5)}...${key.slice(-3)}` : "****";
    } else if (entry.ambient) {
      row.maskedKey = "(ambient)";
    }
    if (entry.envVar) row.envVar = entry.envVar;
    if (entry.ambient) row.ambient = true;
    if (rowConfigured && entry.source === "environment" && entry.authLabel) row.authLabel = entry.authLabel;
    statuses.push(row);
  }
  return statuses;
}
var ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
function deriveEnvVar(label, env) {
  if (!label) return void 0;
  return label.split(",").map((n) => n.trim()).find((n) => ENV_NAME.test(n) && !!env[n]);
}
function isRuntimeCatalogueSource(rt) {
  const r = rt;
  return typeof r?.getProviders === "function" && typeof r?.checkAuth === "function";
}
async function buildRuntimeCatalogue(source, opts) {
  try {
    if (!isRuntimeCatalogueSource(source)) return [];
    if (opts.authData === null) return [];
    const authData = opts.authData;
    const customIds = new Set(opts.customIds);
    const providers = source.getProviders();
    return await Promise.all(
      providers.map(async (p) => {
        const info = {
          id: p.id,
          displayName: p.name || p.id,
          hasOAuth: !!p.auth?.oauth,
          configured: false
        };
        if (customIds.has(p.id)) info.custom = true;
        let check;
        try {
          check = await source.checkAuth(p.id);
        } catch {
          check = void 0;
        }
        if (!check || check.type === "oauth") return info;
        info.configured = true;
        if (authData[p.id]) {
          info.source = "stored";
          return info;
        }
        info.source = "environment";
        if (check.source) info.authLabel = check.source;
        const envVar = deriveEnvVar(check.source, opts.env);
        if (envVar) info.envVar = envVar;
        return info;
      })
    );
  } catch {
    return [];
  }
}
export {
  _buildAuthStatus,
  buildRuntimeCatalogue,
  createOAuthFlowStore,
  isRuntimeCatalogueSource,
  oauthIdsFrom
};
