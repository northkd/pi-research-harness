function findOption(options, category) {
  for (const o of options) if (o.category === category) return o;
  return void 0;
}
function modelInfos(options, agentId) {
  const opt = findOption(options, "model");
  if (!opt) return [];
  const provider = `acp:${agentId}`;
  const values = opt.options ?? [];
  const infos = values.map((v) => ({ provider, id: v.value, name: v.name }));
  const current = typeof opt.currentValue === "string" ? opt.currentValue : void 0;
  if (current && !infos.some((m) => m.id === current)) infos.unshift({ provider, id: current, name: current });
  return infos;
}
function currentModel(options, agentId) {
  const opt = findOption(options, "model");
  return typeof opt?.currentValue === "string" ? `acp:${agentId}/${opt.currentValue}` : void 0;
}
export {
  currentModel,
  findOption,
  modelInfos
};
