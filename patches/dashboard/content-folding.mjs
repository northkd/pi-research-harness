// Optional full-content display on existing chat/Subagents DOM. Local UI only:
// no network, storage, session mutation, text replacement or React subtree wrapping.
export function installContentFolding(root = document) {
  const records = new Map();
  let frame, sequence = 0, stopped = false;
  const prefix = 'research-content-' + Math.random().toString(36).slice(2) + '-';
  const selector = '[data-testid="chat-scroll-container"] .markdown-content, button[aria-label^="任务节点"] > p:first-of-type';
  const schedule = () => { if (!frame && !stopped) frame = requestAnimationFrame(scan); };
  const sizes = new ResizeObserver(schedule);
  function forget(content, record) {
    sizes.unobserve(content); record.button.remove();
    content.removeAttribute('data-research-fold'); content.removeAttribute('data-research-fold-kind');
    if (record.assignedId) content.removeAttribute('id');
    records.delete(content);
  }
  function scan() {
    frame = undefined;
    for (const [content, record] of records) if (!content.isConnected) forget(content, record);
    for (const content of root.querySelectorAll(selector)) {
      if (!(content instanceof HTMLElement)) continue;
      // Never insert an interactive control inside an existing button/link.
      const task = content.closest('button[aria-label^="任务节点"]');
      if (!task && content.closest('button, a')) continue;
      let record = records.get(content);
      if (!record) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'research-content-toggle'; button.hidden = true;
        const assignedId = !content.id;
        if (assignedId) content.id = prefix + (++sequence);
        button.setAttribute('aria-controls', content.id);
        record = { button, expanded: false, assignedId, task };
        records.set(content, record); sizes.observe(content);
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          record.expanded = !record.expanded; schedule();
        });
        content.setAttribute('data-research-fold-kind', task ? 'task' : 'chat');
      }
      const anchor = record.task || content;
      if (record.button.previousElementSibling !== anchor) anchor.after(record.button);
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const limit = rem * (record.task ? 7.5 : 18);
      const long = content.scrollHeight > limit + 2;
      record.button.hidden = !long;
      if (!long) {
        if (content.hasAttribute('data-research-fold')) content.removeAttribute('data-research-fold');
        continue;
      }
      const state = record.expanded ? 'expanded' : 'collapsed';
      if (content.getAttribute('data-research-fold') !== state) content.setAttribute('data-research-fold', state);
      record.button.setAttribute('aria-expanded', String(record.expanded));
      const label = record.expanded ? '收起' : '展开全文';
      // CSS label + accessible name, not a text node inside the message-copy host.
      // ChatView's plain-text/selection serializer must never copy this UI label.
      if (record.button.getAttribute('data-label') !== label) record.button.setAttribute('data-label', label);
      record.button.setAttribute('aria-label', label);
    }
  }
  const changes = new MutationObserver(mutations => {
    if (mutations.some(m => !m.target.parentElement?.closest('.research-content-toggle') &&
        !(m.target instanceof Element && m.target.closest('.research-content-toggle')))) schedule();
  });
  changes.observe(root === document ? document.body : root, { childList: true, characterData: true, subtree: true });
  window.addEventListener('resize', schedule); schedule();
  return () => {
    stopped = true; cancelAnimationFrame(frame); changes.disconnect(); sizes.disconnect();
    window.removeEventListener('resize', schedule);
    for (const [content, record] of records) forget(content, record);
  };
}
if (typeof document !== 'undefined') {
  const key = Symbol.for('pi-research.content-folding');
  const start = () => { globalThis[key]?.(); globalThis[key] = installContentFolding(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
