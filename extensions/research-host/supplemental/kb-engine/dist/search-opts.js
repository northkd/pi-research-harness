function searchOptsFromConfig(cfg, opts = {}) {
  const o = opts.overrides ?? {};
  const sources = opts.sources ?? cfg.resolvedSources ?? [];
  return {
    fieldWeights: cfg.ranking.fieldWeights,
    proximityBoost: cfg.ranking.proximityBoost,
    diversity: cfg.ranking.diversity,
    sourceDedup: o.sourceDedup ?? cfg.ranking.sourceDedup,
    laneQuota: o.laneQuota ?? cfg.ranking.laneQuota,
    // Config-only: no CLI flag and no call-site override departs from it, so
    // there is nothing to override. See change: fix-kb-search-lane-composition.
    laneLeadMargin: cfg.ranking.laneLeadMargin,
    coverageRerank: o.coverageRerank ?? cfg.ranking.coverageRerank,
    queryExpansion: o.queryExpansion ?? cfg.queryExpansion.mode,
    prf: cfg.queryExpansion.prf,
    expandParent: o.expandParent ?? cfg.expand.parent,
    expandGraph: o.expandGraph ?? cfg.expand.graph,
    rerank: o.rerank ?? cfg.rerank.enabled,
    rootPriority: Object.fromEntries(sources.map((s) => [s.id, s.priority]))
  };
}
export {
  searchOptsFromConfig
};
