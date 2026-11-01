#!/usr/bin/env node
/**
 * Validate research-loop/model-policy.json against Pi's registered models.
 * Read-only. Exits non-zero when a referenced model is not callable, or when a
 * role's tier disagrees with the model it is bound to.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const policyPath = path.resolve(here, '..', 'model-policy.json');
const modelsPath = process.env.PI_MODELS_JSON ?? path.join(os.homedir(), '.pi', 'agent', 'models.json');

const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const registry = JSON.parse(fs.readFileSync(modelsPath, 'utf8')).providers ?? {};
const available = new Set();
for (const [provider, value] of Object.entries(registry)) {
  for (const model of value?.models ?? []) available.add(`${provider}/${model.id}`);
}

const errors = [];
const tierModels = (tier) => new Set([
  ...(policy.tiers[tier]?.models ?? []),
  ...(policy.tiers[tier]?.fallbackChain ?? []),
]);

for (const [name, tier] of Object.entries(policy.tiers ?? {})) {
  for (const model of [...(tier.models ?? []), ...(tier.fallbackChain ?? [])]) {
    if (!available.has(model)) errors.push(`tier ${name}: unregistered model ${model}`);
  }
}

for (const [role, config] of Object.entries(policy.roles ?? {})) {
  if (config.model && !available.has(config.model)) {
    errors.push(`role ${role}: unregistered model ${config.model}`);
  }
  if (config.model && config.tier) {
    const allowed = tierModels(config.tier);
    if (allowed.size && !allowed.has(config.model)) {
      errors.push(`role ${role}: model ${config.model} is not in tier ${config.tier}`);
    }
  }
}

const result = {
  schema: 'pi-research-loop.model-policy-check.v1',
  policyPath,
  modelsPath,
  availableCount: available.size,
  heavy: policy.tiers?.heavy?.models ?? [],
  light: policy.tiers?.light?.models ?? [],
  ok: errors.length === 0,
  errors,
};
console.log(JSON.stringify(result, null, 2));
process.exit(errors.length ? 1 : 0);
