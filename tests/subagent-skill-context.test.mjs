import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareForkSkillContext} from '../patches/subagents/support/research-skill-context.mjs';

const forkedAt = 100;
const tool = {name: 'read', description: 'Read an assigned file', parameters: {type: 'object'}};
const catalog = name => `<skills>\n<available_skills>\n<skill><name>${name}</name><description>Method metadata</description><location>/skills/${name}/SKILL.md</location></skill>\n</available_skills>\n</skills>`;
const parentSystem = (skills = catalog('parent-global')) => ({role: 'system', content: '',
  sections: {preamble: 'Parent role', skills, project_context: 'Project constraints', cwd: '/project'},
  toolsAdded: [tool], timestamp: 10});
const history = {role: 'user', content: 'Retain the original derivation assumptions.', timestamp: 20};
const task = {role: 'user', content: 'Derive the assigned bound.', timestamp: forkedAt};
const childSystem = {role: 'system', content: '', sections: {preamble: 'Child derivation role'}, timestamp: forkedAt};
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('a 100-skill inherited catalog is removed without editing saved messages or unrelated prompt sections', () => {
  const skills = `<skills>\n<available_skills>\n${Array.from({length: 100}, (_, index) => `<skill><name>ambient-${index}</name><description>Method metadata</description><location>/skills/ambient-${index}/SKILL.md</location></skill>`).join('\n')}\n</available_skills>\n</skills>`;
  const parent = parentSystem(skills);
  const inherited = freeze([parent]);
  const messages = freeze([parent, history, childSystem, task]);
  const before = JSON.stringify({messages, inherited});
  const result = prepareForkSkillContext(messages, inherited, forkedAt, false);
  assert.equal(result.inheritedSkillsFiltered, true);
  assert.equal(JSON.stringify({messages, inherited}), before);
  assert.doesNotMatch(JSON.stringify(result), /ambient-/);
  assert.deepEqual(result.inherited[0], {role: 'system', content: '',
    sections: {preamble: 'Parent role', project_context: 'Project constraints', cwd: '/project'}, toolsAdded: [tool], timestamp: 10});
  assert.deepEqual(result.messages[0], result.inherited[0]);
  assert.equal(result.messages[0].toolsAdded, parent.toolsAdded);
  assert.equal(result.messages[1], history);
  assert.equal(result.messages[2], childSystem);
  assert.equal(result.messages[3], task);
});

test('only explicit inheritSkills:false changes the native projection input', () => {
  const parent = parentSystem();
  const inherited = [parent], messages = [parent, history, childSystem, task];
  for (const policy of [true, undefined, null, 0, 'false']) {
    const result = prepareForkSkillContext(messages, inherited, forkedAt, policy);
    assert.equal(result.messages, messages);
    assert.equal(result.inherited, inherited);
    assert.equal(result.inheritedSkillsFiltered, false);
  }
});

test('every inherited system delta loses its skills section, including replaced and deleted catalogs', () => {
  const first = parentSystem(catalog('ambient-first'));
  const replacement = {role: 'system', content: 'Retain this later parent rule.',
    sections: {skills: catalog('ambient-replacement'), project_context: 'Updated project constraints'},
    toolsRemoved: [{name: 'write'}], timestamp: 30};
  const deletion = {role: 'system', content: '', sections: {skills: null}, timestamp: 40};
  const inherited = freeze([first, replacement, deletion]);
  const messages = freeze([first, history, replacement, deletion, childSystem, task]);
  const result = prepareForkSkillContext(messages, inherited, forkedAt, false);
  assert.doesNotMatch(JSON.stringify(result), /ambient-/);
  assert.deepEqual(result.inherited.map(message => message.sections), [
    {preamble: 'Parent role', project_context: 'Project constraints', cwd: '/project'},
    {project_context: 'Updated project constraints'}, {},
  ]);
  assert.equal(result.inherited[1].content, replacement.content);
  assert.equal(result.inherited[1].toolsRemoved, replacement.toolsRemoved);
  assert.equal(result.inherited[1].timestamp, replacement.timestamp);
});

test('the child retains explicitly configured skill metadata in its role or addendum', () => {
  const parent = parentSystem();
  const selected = {role: 'system', content: '', timestamp: forkedAt,
    sections: {preamble: `Derivation role\n${catalog('selected-proof')}`,
      addendum: `Read only the selected method when needed.\n${catalog('selected-method')}`}};
  const inherited = [parent], messages = [parent, history, selected, task];
  const result = prepareForkSkillContext(messages, inherited, forkedAt, false);
  assert.equal(result.messages[2], selected);
  assert.match(JSON.stringify(result.messages), /selected-proof/);
  assert.match(JSON.stringify(result.messages), /selected-method/);
  assert.doesNotMatch(JSON.stringify(result.messages), /parent-global/);
});

test('child-owned sections.skills stays intact even if the selected catalog equals the parent catalog', () => {
  const parent = parentSystem();
  const selected = {role: 'system', content: '', sections: {skills: parent.sections.skills}, timestamp: forkedAt};
  const result = prepareForkSkillContext([parent, history, selected, task], [parent], forkedAt, false);
  assert.equal(result.messages[2], selected);
  assert.equal(result.messages[2].sections.skills, parent.sections.skills);
  assert.equal(Object.hasOwn(result.messages[0].sections, 'skills'), false);
});

test('a collapsed system head uses the first timestamp and still drops its known parent catalog', () => {
  const first = parentSystem(catalog('ambient-original'));
  const latest = {role: 'system', content: '', sections: {skills: catalog('ambient-latest')}, timestamp: 30};
  const collapsed = {role: 'system', content: '', sections: {...first.sections,
    skills: latest.sections.skills, preamble: 'Own derivation role', addendum: catalog('selected-method')},
    toolsAdded: [tool], timestamp: first.timestamp};
  const messages = freeze([collapsed, history, task]), inherited = freeze([first, latest]);
  const result = prepareForkSkillContext(messages, inherited, forkedAt, false);
  assert.doesNotMatch(JSON.stringify(result), /ambient-/);
  assert.equal(result.messages[0].sections.preamble, 'Own derivation role');
  assert.equal(result.messages[0].sections.addendum, collapsed.sections.addendum);
  assert.equal(result.messages[0].toolsAdded, collapsed.toolsAdded);
  assert.equal(result.messages[0].timestamp, first.timestamp);
  assert.equal(result.messages[1], history);
});

test('a collapsed head with a distinct child skill section is preserved despite its inherited timestamp', () => {
  const parent = parentSystem();
  const collapsed = {...parent, sections: {...parent.sections, skills: catalog('selected-proof')}};
  const result = prepareForkSkillContext([collapsed, history, task], [parent], forkedAt, false);
  assert.equal(result.messages[0], collapsed);
  assert.equal(result.messages[0].sections.skills, catalog('selected-proof'));
  assert.equal(Object.hasOwn(result.inherited[0].sections, 'skills'), false);
  assert.equal(result.inheritedSkillsFiltered, true);
});

test('the catalog is filtered even when a prior handler modified another inherited system field', () => {
  const parent = parentSystem();
  const altered = {...parent, sections: {...parent.sections, rules: 'Keep an extension rule.'}};
  const result = prepareForkSkillContext([altered, history, task], [parent], forkedAt, false);
  assert.equal(Object.hasOwn(result.messages[0].sections, 'skills'), false);
  assert.equal(result.messages[0].sections.rules, 'Keep an extension rule.');
});

test('opaque prompt text and skill-like text outside the dedicated section are not truncated', () => {
  const opaque = {role: 'system', content: [{type: 'text', text: `Legacy prompt\n${catalog('opaque-example')}\nKeep this trailing policy.`}],
    sections: {preamble: 'Discuss <available_skills> as a literal.', rules: 'Skills are optional.'}, timestamp: 10};
  const inherited = [opaque], messages = [opaque, history, task];
  const result = prepareForkSkillContext(messages, inherited, forkedAt, false);
  assert.equal(result.messages, messages);
  assert.equal(result.inherited, inherited);
  assert.equal(result.inheritedSkillsFiltered, false);
});

test('conversation messages, including tool outputs and quotations of skills, preserve their identity', () => {
  const parent = parentSystem();
  const quoted = {role: 'user', content: catalog('quoted-example'), sections: {skills: 'untrusted text'}, timestamp: 40};
  const read = {role: 'toolResult', toolName: 'read', content: [{type: 'text', text: 'Already-read method body'}], timestamp: 50};
  const result = prepareForkSkillContext([parent, quoted, read, task], [parent], forkedAt, false);
  assert.equal(result.messages[1], quoted);
  assert.equal(result.messages[2], read);
  assert.equal(result.messages[3], task);
});

test('timestamps at and after the fork belong to the child and are not filtered', () => {
  const parent = parentSystem();
  const own = [forkedAt, forkedAt + 1].map(timestamp => ({...parent, timestamp}));
  const result = prepareForkSkillContext([parent, ...own], [parent], forkedAt, false);
  assert.equal(result.messages[1], own[0]);
  assert.equal(result.messages[2], own[1]);
});

test('requests without inherited catalogs do not allocate changed message arrays', () => {
  const parent = {role: 'system', content: '', sections: {preamble: 'Parent'}, timestamp: 10};
  const inherited = [parent], messages = [parent, history, task];
  const result = prepareForkSkillContext(messages, inherited, forkedAt, false);
  assert.equal(result.messages, messages);
  assert.equal(result.inherited, inherited);
  assert.equal(result.inheritedSkillsFiltered, false);
});

test('unknown provenance and invalid fork times do not authorize stripping a catalog', () => {
  const parent = parentSystem(), messages = [parent, history, task], inherited = [];
  const result = prepareForkSkillContext(messages, inherited, forkedAt, false);
  assert.equal(result.messages, messages);
  for (const time of [NaN, Infinity, undefined]) {
    const invalid = prepareForkSkillContext(messages, [parent], time, false);
    assert.equal(invalid.messages, messages);
    assert.equal(invalid.inheritedSkillsFiltered, false);
  }
});

test('projection is idempotent and does not remove the child catalog on a repeated request', () => {
  const parent = parentSystem();
  const selected = {...childSystem, sections: {preamble: 'Own role', skills: catalog('selected-proof')}};
  const first = prepareForkSkillContext([parent, history, selected, task], [parent], forkedAt, false);
  const second = prepareForkSkillContext(first.messages, first.inherited, forkedAt, false);
  assert.equal(second.messages, first.messages);
  assert.equal(second.inherited, first.inherited);
  assert.equal(second.inheritedSkillsFiltered, false);
  assert.equal(second.messages[2], selected);
});
