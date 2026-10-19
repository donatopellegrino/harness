const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const printable = value => value == null ? 'Not reported' : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function createMessageInfo({ load }) {
  const panel = element('div', null, 'message-info-panel');
  panel.hidden = true; panel.id = 'message-info'; panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Message metadata');
  const header = element('div', null, 'message-info-header');
  const heading = element('strong', 'Message info');
  const dismiss = element('button', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'Close message info');
  header.append(heading, dismiss);
  const content = element('div', null, 'message-info-content');
  panel.append(header, content); document.body.append(panel);
  const cache = new Map();
  let owner = null, pinned = false, version = 0, closeTimer, suppressFocus = false;

  function position() {
    if (!owner?.isConnected) { close(); return; }
    const anchor = owner.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
    const below = anchor.bottom + 8;
    const top = below + bounds.height <= window.innerHeight - 12 ? below : anchor.top - bounds.height - 8;
    panel.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
  }
  function close({ restoreFocus = false } = {}) {
    clearTimeout(closeTimer); version++;
    const previous = owner; owner = null; pinned = false; panel.hidden = true;
    content.replaceChildren(); heading.textContent = 'Message info';
    previous?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && previous?.isConnected) {
      suppressFocus = true; previous.focus({ preventScroll: true }); suppressFocus = false;
    }
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      const focused = document.activeElement;
      if (!pinned && !panel.matches(':hover') && !owner?.matches(':hover') && focused !== owner && !panel.contains(focused)) close();
    }, 200);
  }
  function details(title, value) {
    const section = element('details');
    section.open = true;
    section.append(element('summary', title), element('pre', JSON.stringify(value, null, 2)));
    content.append(section);
  }
  function render(data) {
    heading.textContent = `${data.message.role === 'user' ? 'You' : 'Assistant'} · Message ${data.message.position ?? 'in progress'}`;
    content.replaceChildren(element('p', data.source, 'message-info-source'));
    if (!data.available) content.append(element('p', data.pending ? 'Metadata becomes available after the reply is saved.' : 'No metadata was recorded for this message.'));
    const metadata = data.metadata ?? {}, request = metadata.request, response = metadata.response;
    const rows = [];
    const add = (label, value) => rows.push([label, printable(value)]);
    if (request) {
      add('Requested model', request.model);
      add('Requested effort', request.reasoning?.effort ?? 'Default (not specified)');
      add('Requested processing', request.service_tier);
    }
    if (response) {
      add('Reported model', response.model); add('Reported effort', response.reasoning?.effort);
      add('Reported processing', response.service_tier); add('Response status', response.status);
      if (response.id != null) add('Response ID', response.id);
      const usage = response.usage;
      if (usage) {
        add('Input tokens', usage.input_tokens); add('Output tokens', usage.output_tokens); add('Total tokens', usage.total_tokens);
        if (usage.input_tokens_details?.cached_tokens != null) add('Cached input tokens', usage.input_tokens_details.cached_tokens);
        if (usage.output_tokens_details?.reasoning_tokens != null) add('Reasoning tokens (included in output)', usage.output_tokens_details.reasoning_tokens);
      }
    }
    if (metadata.sent_at != null) add('Sent at (recorded request start)', metadata.sent_at);
    if (metadata.started_at != null) add('Request started', metadata.started_at);
    if (metadata.finished_at != null) add('Request finished', metadata.finished_at);
    const elapsed = Date.parse(metadata.finished_at) - Date.parse(metadata.started_at);
    if (Number.isFinite(elapsed) && elapsed >= 0) add('Elapsed time (local)', `${elapsed.toLocaleString()} ms`);
    if (metadata.http?.status != null) add('HTTP status', metadata.http.status);
    if (rows.length) {
      const list = element('dl', null, 'message-info-facts');
      for (const [label, value] of rows) list.append(element('dt', label), element('dd', value));
      content.append(list);
    }
    const titles = { request: 'All requested settings', response: 'All reported response metadata', http: 'HTTP details', events: 'Stream events', error: 'Error details' };
    for (const [key, value] of Object.entries(metadata)) {
      const title = titles[key] ?? key.replaceAll('_', ' ');
      details(`${title}${Array.isArray(value) ? ` (${value.length})` : ''}`, value);
    }
    if (data.excluded?.length) {
      const note = element('details'); note.open = true; note.append(element('summary', 'Excluded fields'));
      const list = element('ul');
      for (const item of data.excluded) list.append(element('li', `${item.reason}: ${item.fields} field(s)`));
      note.append(list); content.append(note);
    }
  }
  async function open(button, record, { pin = false } = {}) {
    if (pinned && owner !== button && !pin) return;
    clearTimeout(closeTimer);
    if (owner === button && !panel.hidden) { pinned ||= pin; return; }
    owner?.setAttribute('aria-expanded', 'false'); owner = button; pinned = pin || pinned;
    const current = ++version;
    button.setAttribute('aria-expanded', 'true'); panel.hidden = false;
    heading.textContent = 'Message info'; content.replaceChildren(element('p', 'Loading metadata…')); position();
    try {
      let data;
      if (!record) data = { message: { role: button.dataset.role }, source: 'Message in progress', pending: true, available: false, metadata: {} };
      else {
        const key = `${record.chatId}:${record.index}`;
        if (record.private) data = await load(record.chatId, record.index);
        else {
          if (!cache.has(key)) cache.set(key, load(record.chatId, record.index).catch(error => { cache.delete(key); throw error; }));
          data = await cache.get(key);
        }
      }
      if (current !== version || owner !== button || !button.isConnected) return;
      render(data); position();
    } catch (error) {
      if (current !== version) return;
      content.replaceChildren(element('p', `Metadata could not be loaded: ${error.message}`)); position();
    }
  }
  function attach(button, record, role) {
    button.dataset.role = role; button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('pointerenter', () => { void open(button, record); });
    button.addEventListener('pointerleave', scheduleClose);
    button.addEventListener('focus', () => { if (!suppressFocus) void open(button, record); });
    button.addEventListener('blur', scheduleClose);
    button.addEventListener('click', event => {
      if (owner === button && pinned) { close(); return; }
      void open(button, record, { pin: true });
      if (event.detail === 0) dismiss.focus();
    });
  }
  panel.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  panel.addEventListener('pointerleave', scheduleClose);
  panel.addEventListener('focusout', scheduleClose);
  panel.addEventListener('click', position);
  dismiss.onclick = () => close({ restoreFocus: true });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close({ restoreFocus: true }); }
  });
  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !panel.contains(event.target) && !owner?.contains(event.target)) close();
  });
  window.addEventListener('resize', () => { if (!panel.hidden) position(); });
  window.addEventListener('blur', () => close());
  return { attach, close };
}
