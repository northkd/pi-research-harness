function renderSessionFlowActions(input) {
  const { flows, commands } = input;
  const hasNew = commands.some((c) => c.name === "flows:new");
  if (flows.length === 0 && !hasNew) return null;
  const actions = [];
  for (const flow of flows) {
    actions.push({
      label: flow.name,
      tooltip: flow.description,
      dataAction: {
        pluginId: "flows",
        action: "flow.run",
        payload: { flow: flow.name }
      }
    });
  }
  if (hasNew) {
    actions.push({
      label: "+ New Flow",
      dataAction: {
        pluginId: "flows",
        action: "flow.new"
      }
    });
  }
  return {
    primitive: "ui:action-list",
    props: { actions }
  };
}
export {
  renderSessionFlowActions
};
