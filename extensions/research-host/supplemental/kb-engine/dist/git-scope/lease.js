import { randomUUID } from "node:crypto";
class LeaseLostError extends Error {
  constructor() {
    super("git-scope lease lost");
    this.name = "LeaseLostError";
  }
}
class GitLease {
  nonce = null;
  store;
  opts;
  constructor(store, opts) {
    this.store = store;
    this.opts = opts;
  }
  get held() {
    return this.nonce !== null;
  }
  /** Non-blocking: true iff this call took the lease (busy DB ⇒ not acquired). */
  tryAcquire() {
    const nonce = randomUUID();
    try {
      const won = this.store.immediate((db) => {
        const now = this.opts.now();
        const r = db.prepare("UPDATE git_lease SET owner=?, nonce=?, expires_at=? WHERE id=1 AND expires_at < ?").run(this.opts.owner, nonce, now + this.opts.leaseMs, now);
        return Number(r.changes) === 1;
      });
      this.nonce = won ? nonce : null;
      return won;
    } catch {
      return false;
    }
  }
  /** Heartbeat. Zero rows changed ⇒ lost. */
  extend() {
    if (!this.nonce) return false;
    const nonce = this.nonce;
    try {
      const ok = this.store.immediate((db) => Number(db.prepare("UPDATE git_lease SET expires_at=? WHERE id=1 AND nonce=?").run(this.opts.now() + this.opts.leaseMs, nonce).changes) === 1);
      if (!ok) this.nonce = null;
      return ok;
    } catch {
      return false;
    }
  }
  /** Fenced release: never touches another owner's lease. */
  release() {
    if (!this.nonce) return;
    const nonce = this.nonce;
    this.nonce = null;
    try {
      this.store.immediate((db) => void db.prepare("UPDATE git_lease SET expires_at=0 WHERE id=1 AND nonce=?").run(nonce));
    } catch {
    }
  }
  /** One write transaction, fenced by the nonce; also extends the lease. Throws
   *  {@link LeaseLostError} (rolling back) when this owner was deposed. */
  fenced(fn) {
    const nonce = this.nonce;
    if (!nonce) throw new LeaseLostError();
    return this.store.immediate((db) => {
      const row = db.prepare("SELECT nonce FROM git_lease WHERE id=1").get();
      if (!row || row.nonce !== nonce) throw new LeaseLostError();
      const out = fn(db);
      db.prepare("UPDATE git_lease SET expires_at=? WHERE id=1 AND nonce=?").run(this.opts.now() + this.opts.leaseMs, nonce);
      return out;
    });
  }
}
export {
  GitLease,
  LeaseLostError
};
