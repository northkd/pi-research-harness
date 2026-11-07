/**
 * Apply the child's skill-inheritance policy to the provider-facing fork projection.
 * Pi 1.3 stores generated catalogs in the independently replaceable `skills` section.
 * Copy only that section away; the saved parent transcript and all other context stay
 * intact. Opaque prompt content is deliberately not parsed or truncated here.
 */
export function prepareForkSkillContext(messages, inherited, forkedAt, inheritSkills) {
  const unchanged = {messages, inherited, inheritedSkillsFiltered: false};
  if (inheritSkills !== false || !Number.isFinite(forkedAt)) return unchanged;

  const isInherited = message => message.role === 'system'
    && typeof message.timestamp === 'number' && message.timestamp < forkedAt;
  const sentInherited = messages.filter(isInherited);
  const uncollapsed = sentInherited.length === inherited.length
    && sentInherited.every((message, index) => JSON.stringify(message) === JSON.stringify(inherited[index]));
  const parentCatalogs = new Set(inherited
    .filter(message => message.role === 'system' && Object.hasOwn(message.sections ?? {}, 'skills'))
    .map(message => message.sections.skills));

  const withoutSkills = message => {
    if (message.role !== 'system' || !Object.hasOwn(message.sections ?? {}, 'skills')) return message;
    const sections = {...message.sections};
    delete sections.skills;
    return {...message, sections};
  };
  const copyChanges = (source, transform) => {
    let result;
    for (let index = 0; index < source.length; index++) {
      const next = transform(source[index]);
      if (next !== source[index]) {
        result ??= source.slice();
        result[index] = next;
      }
    }
    return result ?? source;
  };

  const filteredInherited = copyChanges(inherited, withoutSkills);
  const filteredMessages = copyChanges(messages, message => {
    if (!isInherited(message)) return message;
    // getCurrentSystemMessage keeps the FIRST system timestamp when it collapses
    // deltas. The collapsed head can therefore contain a child's selected catalog
    // with a parent's timestamp. Only remove a known parent value in that case.
    if (!uncollapsed && !parentCatalogs.has(message.sections?.skills)) return message;
    return withoutSkills(message);
  });
  return {
    messages: filteredMessages,
    inherited: filteredInherited,
    inheritedSkillsFiltered: filteredMessages !== messages || filteredInherited !== inherited,
  };
}
