/** Do not start a research prompt before its trusted membership is on disk. */
export function createResearchRegistrationBarrier() {
  const pending = new Map();
  return {
    register(sessionId, associate) {
      const record = { ready: false, cancelled: false, promise: null };
      pending.set(sessionId, record);
      record.promise = Promise.resolve().then(associate).then(() => { record.ready = true; });
      // Keep a rejected association closed until a new trusted association.
      record.promise.catch(() => {});
      return record.promise;
    },
    deliver(sessionId, callback, { deferred = false } = {}) {
      if (deferred) return Promise.resolve(false);
      const record = pending.get(sessionId);
      if (!record) { callback(); return Promise.resolve(true); }
      return record.promise.then(() => {
        if (record.cancelled || pending.get(sessionId) !== record || !record.ready) return false;
        callback();
        // Token consumption inside callback is idempotent. A duplicate register
        // queued on this barrier must not consume any legacy cwd prompt.
        pending.delete(sessionId);
        return true;
      }, () => false);
    },
    clear(sessionId) {
      const record = pending.get(sessionId);
      if (record) {
        record.cancelled = true;
        // The spawn reference was already consumed. Keep a closed tombstone
        // across unregister/re-register until a new trusted association starts;
        // otherwise the same token could fall through to ordinary delivery.
      }
    },
  };
}
