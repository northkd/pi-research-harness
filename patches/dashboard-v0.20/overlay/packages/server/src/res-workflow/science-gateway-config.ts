import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, parseDocument, visit, type YAMLSeq } from "yaml";

const alias = "ark-sci-deepseek-v4.1-flash";
const model = "deepseek-v4.1-flash";

function isArkEndpoint(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^ark\.[a-z0-9-]+\.volces\.com$/.test(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}

export function prepareScienceGatewayConfig(source: unknown, newKey: unknown) {
  if (typeof newKey !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(newKey)) {
    throw new Error("Invalid Science credential");
  }
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 1024 * 1024) {
    throw new Error("Invalid gateway configuration");
  }
  let document;
  try { document = parseDocument(source, { uniqueKeys: true, keepSourceTokens: true, logLevel: "silent" }); }
  catch { throw new Error("Invalid gateway configuration"); }
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    throw new Error("Invalid gateway configuration");
  }
  let hasAliases = false;
  visit(document, { Alias: () => { hasAliases = true; } });
  if (hasAliases) throw new Error("YAML aliases are unsupported for this gateway update");

  const keys = document.get("api-keys");
  const providers = document.get("claude-api-key");
  if (!isSeq(keys) || !keys.items.length || keys.items.some((key) => !isScalar(key) || typeof key.value !== "string" || /^\p{White_Space}*$/u.test(key.value))) {
    throw new Error("Client API keys unavailable");
  }
  if (!isSeq(providers)) throw new Error("Ark route unavailable or ambiguous");
  const matches = providers.items.filter((provider) => {
    if (!isMap(provider) || !isArkEndpoint(provider.get("base-url"))) return false;
    const models = provider.get("models");
    return isSeq(models) && models.items.some((entry) => isMap(entry) && entry.get("name") === model);
  });
  if (matches.length !== 1 || !isMap(matches[0])) throw new Error("Ark route unavailable or ambiguous");
  const provider = matches[0];
  const models = provider.get("models");
  if (!isSeq(models)) throw new Error("Ark route unavailable or ambiguous");
  const ownAlias = models.items.filter((entry) => isMap(entry) && entry.get("alias") === alias);
  if (ownAlias.length > 1 || ownAlias.some((entry) => !isMap(entry) || entry.get("name") !== model)) {
    throw new Error("Science alias collision");
  }
  const original = document.toJS({ maxAliasCount: 0 });
  let aliasCount = 0;
  const countAliases = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("alias" in value && value.alias === alias) aliasCount++;
    for (const entry of Object.values(value)) countAliases(entry);
  };
  countAliases(original);
  if (aliasCount !== ownAlias.length) throw new Error("Science alias collision");

  const addedKey = !keys.items.some((entry) => isScalar(entry) && entry.value === newKey);
  const addedAlias = ownAlias.length === 0;
  const edits: Array<{ offset: number; text: string }> = [];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const append = (sequence: YAMLSeq, lines: readonly string[]) => {
    if (sequence.flow || !sequence.range || source[sequence.range[0]] !== "-") throw new Error("Unsupported YAML layout");
    const start = sequence.range[0];
    const indent = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
    if (!/^ *$/.test(indent)) throw new Error("Unsupported YAML layout");
    const offset = sequence.range[2];
    const prefix = offset > 0 && source[offset - 1] !== "\n" ? newline : "";
    edits.push({ offset, text: prefix + lines.map((line) => indent + line).join(newline) + newline });
  };
  if (addedKey) append(keys, [`- ${JSON.stringify(newKey)}`]);
  if (addedAlias) append(models, [`- name: ${model}`, `  alias: ${alias}`]);
  let updated = source;
  for (const edit of edits.sort((a, b) => b.offset - a.offset)) updated = updated.slice(0, edit.offset) + edit.text + updated.slice(edit.offset);

  const expected = structuredClone(original);
  if (addedKey) expected["api-keys"].push(newKey);
  if (addedAlias) expected["claude-api-key"][providers.items.indexOf(provider)].models.push({ name: model, alias });
  let checked;
  try {
    const next = parseDocument(updated, { uniqueKeys: true, logLevel: "silent" });
    if (next.errors.length || next.warnings.length) throw new Error();
    checked = next.toJS({ maxAliasCount: 0 });
  } catch { throw new Error("Unsafe gateway configuration patch"); }
  if (!isDeepStrictEqual(checked, expected)) throw new Error("Unsafe gateway configuration patch");
  return { source: updated, addedKey, addedAlias, oldKeyCount: keys.items.length, newKeyCount: keys.items.length + Number(addedKey) };
}
