class WorkSourceRegistry {
  sources = /* @__PURE__ */ new Map();
  providers = [];
  register(id, source) {
    this.sources.set(id, source);
  }
  /** Add a cross-plugin provider (see {@link WorkSourceProvider}). */
  addProvider(provider) {
    this.providers.push(provider);
  }
  get(id) {
    const own = this.sources.get(id);
    if (own) return own;
    for (const p of this.providers) {
      try {
        const hit = p.get(id);
        if (hit) return hit;
      } catch {
      }
    }
    return void 0;
  }
  has(id) {
    return this.get(id) !== void 0;
  }
  ids() {
    const all = new Set(this.sources.keys());
    for (const p of this.providers) {
      try {
        for (const id of p.ids()) all.add(id);
      } catch {
      }
    }
    return all;
  }
}
export {
  WorkSourceRegistry
};
