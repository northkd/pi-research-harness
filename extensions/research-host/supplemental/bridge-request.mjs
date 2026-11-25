let requester;

export function configurePluginRequester(value) {
  if (typeof value !== 'function') throw new Error('plugin-requester-required');
  requester = value;
}

export async function requestPluginServer(pluginId, name, payload) {
  if (!requester) return { ok: false, error: 'unavailable' };
  try { return { ok: true, data: await requester(pluginId, name, payload) }; }
  catch (error) { return { ok: false, error: error?.code || 'disconnected' }; }
}
