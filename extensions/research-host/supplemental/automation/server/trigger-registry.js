class TriggerRegistry {
  types = /* @__PURE__ */ new Map();
  register(type) {
    this.types.set(type.kind, type);
  }
  get(kind) {
    return this.types.get(kind);
  }
  has(kind) {
    return this.types.has(kind);
  }
  kinds() {
    return new Set(this.types.keys());
  }
}
function onKindForCategory(category) {
  return category === "scheduled" ? "schedule" : category;
}
function categoryForOnKind(kind) {
  return kind === "schedule" ? "scheduled" : kind;
}
const TRIGGER_TAXONOMY = [
  { category: "scheduled", label: "Scheduled", multiType: false, events: [] },
  {
    category: "openspec",
    label: "OpenSpec",
    multiType: true,
    events: [
      { event: "change.created", label: "Change created" },
      { event: "change.archived", label: "Change archived" },
      { event: "change.validated", label: "Change validated" },
      { event: "tasks.completed", label: "Tasks completed" },
      { event: "spec.updated", label: "Spec updated" },
      { event: "proposal.added", label: "Proposal added" }
    ]
  },
  {
    category: "git",
    label: "Git",
    multiType: true,
    events: [
      { event: "commit", label: "Commit" },
      { event: "push", label: "Push" },
      { event: "branch.created", label: "Branch created" }
    ]
  },
  {
    category: "file",
    label: "File",
    multiType: true,
    events: [
      { event: "created", label: "File created", baseStatus: "enabled" },
      { event: "changed", label: "File changed", baseStatus: "enabled" },
      { event: "deleted", label: "File deleted", baseStatus: "enabled" }
    ]
  },
  {
    category: "webhook",
    label: "Webhook",
    multiType: false,
    events: []
  }
];
function deriveTriggerTaxonomy(registry, taxonomy = TRIGGER_TAXONOMY) {
  return taxonomy.map((cat) => {
    const enabled = registry.has(onKindForCategory(cat.category));
    const events = cat.events.map((ev) => ({
      event: ev.event,
      label: ev.label,
      // An event cannot be enabled under a planned category.
      status: enabled && ev.baseStatus === "enabled" ? "enabled" : "planned"
    }));
    return {
      category: cat.category,
      label: cat.label,
      status: enabled ? "enabled" : "planned",
      events
    };
  });
}
export {
  TRIGGER_TAXONOMY,
  TriggerRegistry,
  categoryForOnKind,
  deriveTriggerTaxonomy,
  onKindForCategory
};
