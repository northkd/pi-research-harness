import { chunkAsciiDoc, extractXrefs, NEGATED } from "./adoc-chunker.js";
import { chunkMarkdown } from "./chunker.js";
import { DEFAULTS, frontmatterConfigHash, indexOptionsFromConfig, indexOptionsHash, loadConfig, validateConfig } from "./config.js";
import { agentsChain, doxInit, doxLint, fallbackManifest, parseRowPaths, resolveRowPath } from "./dox.js";
import { ackTargets, applyDecisions, buildWorkItems, parseRows, replaceRowPurpose } from "./dox-triage.js";
import { buildMeta, buildProperties, DEFAULT_FACET_KEYS, DEFAULT_SEARCHABLE_KEYS, parseFrontmatter, strictDate, strictNumber } from "./frontmatter.js";
import { createGitScope, GitScope } from "./git-scope/index.js";
import { beginForcedSource, runningEngine, sourceGateIsStale, stampPass, stampSource } from "./index-gate.js";
import { BUILDING_LINE, installIndex, isFirstIndexLive, makeHeartbeat, runIndexAtomic, sweepOrphanTemps } from "./index-run.js";
import { headingNodeName, indexSource } from "./indexer.js";
import { kbInit } from "./init.js";
import { renderHits } from "./render.js";
import { searchOptsFromConfig } from "./search-opts.js";
import { findMainCheckout, seedOptionsFromConfig } from "./seed.js";
import { classifyRef, KbUntrustedSourceError, resolveAll, resolverFor, sourceIdentity } from "./sources.js";
import { SCHEMA_VERSION, SqliteFtsStore } from "./sqlite-store.js";
import { readStaleness, STALENESS_VERSION, stalenessVersionOnDisk } from "./staleness.js";
import {
  canonicalSource,
  isTrusted,
  listTrustedSources,
  recordTrust,
  revokeTrust,
  revokeTrustByHash,
  sourceHash,
  sourceSubject
} from "./trust.js";
import { COVERAGE_CAP_BYTES, enrichHits, HASH_CAP_BYTES, SUBJECT_CAP } from "./verdict.js";
export {
  BUILDING_LINE,
  COVERAGE_CAP_BYTES,
  DEFAULTS,
  DEFAULT_FACET_KEYS,
  DEFAULT_SEARCHABLE_KEYS,
  GitScope,
  HASH_CAP_BYTES,
  KbUntrustedSourceError,
  NEGATED,
  SCHEMA_VERSION,
  STALENESS_VERSION,
  SUBJECT_CAP,
  SqliteFtsStore,
  ackTargets,
  agentsChain,
  applyDecisions,
  beginForcedSource,
  buildMeta,
  buildProperties,
  buildWorkItems,
  canonicalSource,
  chunkAsciiDoc,
  chunkMarkdown,
  classifyRef,
  createGitScope,
  doxInit,
  doxLint,
  enrichHits,
  extractXrefs,
  fallbackManifest,
  findMainCheckout,
  frontmatterConfigHash,
  headingNodeName,
  indexOptionsFromConfig,
  indexOptionsHash,
  indexSource,
  installIndex,
  isFirstIndexLive,
  isTrusted,
  kbInit,
  listTrustedSources,
  loadConfig,
  makeHeartbeat,
  parseFrontmatter,
  parseRowPaths,
  parseRows,
  readStaleness,
  recordTrust,
  renderHits,
  replaceRowPurpose,
  resolveAll,
  resolveRowPath,
  resolverFor,
  revokeTrust,
  revokeTrustByHash,
  runIndexAtomic,
  runningEngine,
  searchOptsFromConfig,
  seedOptionsFromConfig,
  sourceGateIsStale,
  sourceHash,
  sourceIdentity,
  sourceSubject,
  stalenessVersionOnDisk,
  stampPass,
  stampSource,
  strictDate,
  strictNumber,
  sweepOrphanTemps,
  validateConfig
};
