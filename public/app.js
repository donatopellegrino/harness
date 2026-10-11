import { accountSynchronizer } from '/account-sync.js';
import { reconcileCompaction } from '/compaction-sync.js';

const $ = id => document.getElementById(id);
let chats = [], models = [], account = {}, activeId, busy = false, compacting = false, savingSettings = false;
let effortPointer = null;
const active = () => chats.find(chat => chat.id === activeId);
const CUSTOM_MODEL = '__custom__';
const modelID = () => $('model').value === CUSTOM_MODEL ? $('model-id').value.trim() : $('model').value;
const showError = message => { $('error').textContent = message; $('error').hidden = !message; };
const showStatus = message => { $('context-status').textContent = message; $('context-status').hidden = !message; };
const safely = handler => async (...args) => { try { showError(''); await handler(...args); } catch (error) { showError(error.message); } };
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed.');
  return data;
}
function replaceChat(chat) {
  const index = chats.findIndex(item => item.id === chat.id);
  if (index < 0) chats.unshift(chat); else chats[index] = chat;
}
function controls() {
  const connected = account.sharing && models.length > 0;
  const locked = busy || savingSettings;
  $('send').disabled = locked || !connected || !modelID();
  $('send-effort').disabled = $('send').disabled || !$('prompt').value.trim();
  if ($('send-effort').disabled) closeEffortMenu();
  $('new-chat').disabled = locked;
  $('model').disabled = locked || !connected;
  $('model-id').disabled = locked || !connected;
  $('effort').disabled = locked || !connected;
  $('speed').disabled = locked || !connected;
  $('login').disabled = locked;
  $('logout').disabled = locked;
  $('prompt').disabled = locked;
  $('send').textContent = busy && !compacting ? 'Replying…' : 'Send';
  $('compact').disabled = locked || !connected || !modelID() || !active()?.messages.length;
  $('compact').textContent = compacting ? 'Compacting…' : 'Compact context';
  for (const button of $('chats').children) button.disabled = locked;
  renderContext();
}
function renderContext() {
  const selected = models.find(model => model.id === modelID());
  const limit = selected?.maxContextWindow;
  const threshold = limit && Math.floor(limit / 2) >= 1000 ? Math.floor(limit / 2) : null;
  const usage = active()?.contextUsage;
  const number = value => value?.toLocaleString('en-US') ?? 'unavailable';
  const total = usage?.totalTokens ?? (usage?.inputTokens != null && usage?.outputTokens != null ? usage.inputTokens + usage.outputTokens : null);
  const sameModel = usage?.model === modelID();
  const percent = limit && total != null && sameModel ? total / limit * 100 : null;
  const percentText = percent > 0 && percent < .1 ? '<0.1%' : `${percent?.toFixed(1)}%`;
  const capacity = limit ? `${number(limit)} tokens` : 'limit unavailable';
  $('context-label').textContent = percent != null
    ? `Last request: ${number(total)} / ${capacity} · ${percentText} of catalog maximum`
    : `Catalog maximum: ${capacity}${total != null ? ` · Last request: ${number(total)} tokens` : ''}`;
  $('context-policy').textContent = threshold ? `Auto compact at ${number(threshold)} tokens (50% of catalog maximum)` : 'Auto compaction unavailable: catalog maximum missing or below the supported threshold.';
  $('context-meter').hidden = percent == null;
  if (percent != null) $('context-meter').value = Math.min(percent, 100);
  const breakdown = [];
  if (usage) {
    breakdown.push(`Last ${active()?.contextUsageSource === 'compaction' ? 'compaction request' : 'reply'} (${usage.model ?? 'unknown model'}): ${number(usage.inputTokens)} input + ${number(usage.outputTokens)} output tokens.`);
    if (usage.cachedTokens != null) breakdown.push(`${number(usage.cachedTokens)} input tokens were cached.`);
    if (usage.reasoningTokens != null) breakdown.push(`${number(usage.reasoningTokens)} reasoning tokens are included in the output count.`);
  } else breakdown.push(active()?.messages.length ? 'Token usage was not recorded for the latest request.' : 'Token usage will appear after a completed reply.');
  $('context-breakdown').textContent = breakdown.join(' ');
  const notes = [limit ? 'This maximum is reported by your account catalog; it is not a verified hard limit.' : 'The account catalog does not provide a maximum for this model.'];
  if (threshold) notes.push('OpenAI checks the rendered context against the automatic threshold during requests.');
  if (usage) notes.push('The meter uses the last completed request’s input and output usage, including reasoning, and excludes your draft. It is not a live count of the context after compaction.');
  if (usage && !sameModel) notes.push('The last request used a different or unknown model, so its usage is not compared with this maximum.');
  $('context-note').textContent = notes.join(' ');
}
function renderChats() {
  $('chats').replaceChildren(...chats.map(chat => {
    const button = document.createElement('button'); button.textContent = chat.title;
    button.setAttribute('aria-current', String(chat.id === activeId));
    button.onclick = safely(async () => { activeId = chat.id; $('prompt').value = ''; render(); });
    return button;
  }));
}
function message(role, text) {
  const article = document.createElement('article'); article.className = `message ${role}`;
  const label = document.createElement('div'); label.className = 'role'; label.textContent = role === 'user' ? 'You' : 'Assistant';
  const content = document.createElement('div'); content.className = 'content'; content.textContent = text;
  article.append(label, content); $('messages').append(article);
  return content;
}
function renderMessages() {
  $('messages').replaceChildren();
  const history = active()?.messages ?? [];
  if (!history.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const title = document.createElement('h1'); title.textContent = 'A simple place to chat.';
    const subtitle = document.createElement('p'); subtitle.textContent = account.sharing ? 'Choose a model and send a message.' : 'Continue with ChatGPT to get started.';
    empty.append(title, subtitle); $('messages').append(empty);
  } else history.forEach(item => message(item.role, item.text));
  $('messages').scrollTop = $('messages').scrollHeight;
}
function fillEfforts() {
  closeEffortMenu();
  const selected = models.find(model => model.id === modelID());
  const options = ['default', ...(selected?.efforts ?? ($('model').value === CUSTOM_MODEL ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : []))];
  $('effort').replaceChildren(...options.map(effort => new Option(effort === 'default' ? 'Default' : effort[0].toUpperCase() + effort.slice(1), effort)));
  $('effort').value = options.includes(active()?.effort) ? active().effort : 'default';
}
function selectModel(id) {
  const custom = Boolean(id) && !models.some(model => model.id === id);
  $('model').value = custom ? CUSTOM_MODEL : id;
  $('model-id').hidden = !custom;
  $('model-id').value = custom ? id : '';
}
function render() {
  showStatus('');
  renderChats(); renderMessages();
  $('model').replaceChildren(...(models.length ? [...models.map(model => new Option(model.name, model.id)), new Option('Custom model…', CUSTOM_MODEL)] : [new Option('Sign in to load models', '')]));
  selectModel(models.length ? active()?.model || models[0].id : '');
  fillEfforts(); controls();
  $('speed').setAttribute('aria-pressed', String(active()?.fast === true));
}
async function refresh() {
  const state = await api('/api/state'); chats = state.chats; account = state.auth;
  $('account-status').textContent = account.connected ? `${account.email ?? 'Connected'}\n${account.sharing ? 'Using ChatGPT plan' : 'Plan usage not enabled'}` : 'Not connected';
  $('login').hidden = account.connected && account.sharing;
  $('login').textContent = account.connected ? 'Enable ChatGPT plan usage' : 'Continue with ChatGPT';
  $('logout').hidden = !account.connected;
  models = [];
  if (!chats.some(chat => chat.id === activeId)) activeId = chats[0]?.id;
  render();
  if (account.sharing) { models = (await api('/api/models')).models; render(); }
}
async function newChat({ preserveDraft = false } = {}) {
  const chat = await api('/api/chats', 'POST'); replaceChat(chat); activeId = chat.id;
  if (!preserveDraft) $('prompt').value = '';
  render(); $('prompt').focus();
}
async function saveSettings() {
  if (savingSettings) throw new Error('Wait for the settings to finish saving.');
  const model = modelID(), effort = $('effort').value, fast = $('speed').getAttribute('aria-pressed') === 'true';
  savingSettings = true; controls();
  try {
    if (!active()) await newChat({ preserveDraft: true });
    const chatId = activeId;
    const chat = await api(`/api/chats/${chatId}`, 'PATCH', { model, effort, fast });
    replaceChat(chat);
    if (activeId === chatId) {
      selectModel(model); fillEfforts(); $('effort').value = effort;
      $('speed').setAttribute('aria-pressed', String(chat.fast));
      renderContext();
    }
  } finally { savingSettings = false; controls(); }
}
$('new-chat').onclick = safely(newChat);
$('model').onchange = safely(async () => {
  const custom = $('model').value === CUSTOM_MODEL;
  $('model-id').hidden = !custom;
  if (custom) { $('model-id').value = ''; fillEfforts(); controls(); $('model-id').focus(); }
  else { fillEfforts(); await saveSettings(); }
});
$('model-id').oninput = controls;
$('model-id').onchange = safely(async () => { if (modelID()) { fillEfforts(); await saveSettings(); } });
$('effort').onchange = safely(saveSettings);
$('speed').onclick = safely(async () => {
  const wasFast = $('speed').getAttribute('aria-pressed') === 'true';
  $('speed').setAttribute('aria-pressed', String(!wasFast));
  try { await saveSettings(); }
  catch (error) { $('speed').setAttribute('aria-pressed', String(wasFast)); throw error; }
});
$('login').onclick = safely(async () => { const { url } = await api('/api/login', 'POST'); window.location.assign(url); });
$('logout').onclick = safely(async () => {
  const result = await api('/api/logout', 'POST'); await refresh();
  if (!result.revoked) showError('Signed out locally. Remote revocation was not confirmed; disconnect Basic Harness in ChatGPT settings.');
});

async function readEvents(response, onEvent) {
  if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed.');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (chunk.done && buffer.trim()) buffer += '\n';
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.type === 'error') throw new Error(item.message);
        if (item.type === 'notice') showError(item.message);
        if (item.type === 'status') showStatus(item.message);
        onEvent(item);
      }
      if (chunk.done) break;
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

$('compact').onclick = safely(async () => {
  if (busy || savingSettings || !active()?.messages.length) return;
  compacting = true; busy = true; controls(); showStatus('Compacting context… This can take a few minutes.');
  let done = false, requested = false, previousCount = active().compactionCount ?? 0;
  const chatId = activeId;
  try {
    await saveSettings();
    previousCount = active().compactionCount ?? 0;
    requested = true;
    const response = await fetch(`/api/chats/${chatId}/compact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await readEvents(response, item => { if (item.type === 'done') { replaceChat(item.chat); done = true; } });
    if (!done) throw new Error('Compaction completion could not be confirmed.');
  } catch (error) {
    showStatus('');
    if (!requested) throw error;
    let confirmed;
    try {
      confirmed = await reconcileCompaction({ chatId, previousCount,
        readState: () => api('/api/state'),
        onChat: chat => { replaceChat(chat); renderMessages(); },
      });
    } catch {
      throw new Error(`${error.message} Reload the page to check saved state before retrying compaction.`);
    }
    if (!confirmed) throw error;
    showStatus('Context compacted. Saved state was refreshed after the interrupted request.');
  }
  finally { compacting = false; busy = false; controls(); }
});

function closeEffortMenu() {
  const pointer = effortPointer; effortPointer = null;
  if (pointer !== null && $('send-effort').hasPointerCapture(pointer)) $('send-effort').releasePointerCapture(pointer);
  $('send-efforts').hidden = true;
  $('send-effort').setAttribute('aria-expanded', 'false');
}
function sendWithEffort(effort) {
  closeEffortMenu();
  if ($('send-effort').disabled || ![...$('effort').options].some(option => option.value === effort)) return;
  $('effort').value = effort;
  $('composer').requestSubmit();
}
function openEffortMenu() {
  if ($('send-effort').disabled) return;
  $('send-efforts').replaceChildren(...[...$('effort').options].map(option => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = option.textContent;
    button.dataset.effort = option.value; button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(option.value === $('effort').value));
    button.onclick = () => sendWithEffort(option.value);
    return button;
  }));
  $('send-efforts').hidden = false;
  $('send-effort').setAttribute('aria-expanded', 'true');
}
function effortAt(event) {
  const menu = $('send-efforts');
  if (menu.hidden) return null;
  const bounds = menu.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return null;
  // Use the full menu width, including its padding, rather than the hit element.
  // Top/bottom padding belongs to the first/last row respectively.
  const buttons = [...menu.children];
  return buttons.find(button => event.clientY < button.getBoundingClientRect().bottom) ?? buttons.at(-1) ?? null;
}
$('send-effort').addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0 || $('send-effort').disabled) return;
  event.preventDefault();
  openEffortMenu(); effortPointer = event.pointerId;
  $('send-effort').setPointerCapture(event.pointerId);
});
$('send-effort').addEventListener('pointermove', event => {
  if (event.pointerId !== effortPointer) return;
  const hovered = effortAt(event);
  for (const button of $('send-efforts').children) button.dataset.highlighted = String(button === hovered);
});
$('send-effort').addEventListener('pointerup', event => {
  if (event.pointerId !== effortPointer) return;
  event.preventDefault();
  const effort = effortAt(event)?.dataset.effort;
  closeEffortMenu();
  if (effort !== undefined) sendWithEffort(effort);
});
$('send-effort').addEventListener('pointercancel', closeEffortMenu);
$('send-effort').addEventListener('lostpointercapture', () => { if (effortPointer !== null) closeEffortMenu(); });
// Keyboard activation opens a focusable menu; pointer release handles dragging.
$('send-effort').onclick = event => {
  if (event.detail !== 0) return;
  if (!$('send-efforts').hidden) { closeEffortMenu(); return; }
  openEffortMenu();
  [...$('send-efforts').children].find(button => button.dataset.effort === $('effort').value)?.focus();
};
$('send-efforts').addEventListener('keydown', event => {
  const buttons = [...$('send-efforts').children];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('send-efforts').hidden) {
    event.preventDefault(); closeEffortMenu(); $('send-effort').focus();
  }
});
document.addEventListener('pointerdown', event => {
  if (effortPointer === null && !event.target.closest('.effort-send')) closeEffortMenu();
});
window.addEventListener('blur', closeEffortMenu);
document.addEventListener('visibilitychange', () => { if (document.hidden) closeEffortMenu(); });
$('prompt').addEventListener('input', controls);
$('composer').onsubmit = safely(async event => {
  event.preventDefault();
  const text = $('prompt').value.trim(); if (!text || busy || savingSettings || !account.sharing) return;
  busy = true; controls(); showError(''); showStatus('');
  let received = '', done = false;
  try {
    await saveSettings();
    $('prompt').value = '';
    if (!active().messages.length) $('messages').replaceChildren();
    message('user', text); const reply = message('assistant', 'Thinking…');
    const response = await fetch(`/api/chats/${activeId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    await readEvents(response, item => {
      if (item.type === 'delta') { received += item.text; reply.textContent = received; $('messages').scrollTop = $('messages').scrollHeight; }
      if (item.type === 'done') { replaceChat(item.chat); done = true; }
    });
    if (!done) throw new Error('The reply did not finish. Try again.');
    renderChats(); renderMessages();
  } catch (error) {
    // Failed turns are not added to saved history; preserve the draft for retry.
    $('prompt').value = text; renderMessages(); showStatus(''); throw error;
  } finally { busy = false; controls(); $('prompt').focus(); }
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
});
await safely(refresh)();
const login = new URLSearchParams(window.location.search).get('login');
if (login && login !== 'success') showError(login);
if (login) history.replaceState(null, '', '/');

const syncAccount = accountSynchronizer({
  readStatus: () => api('/api/account'),
  currentStatus: () => account,
  onChange: refresh,
  canSync: () => !busy && !savingSettings && !document.hidden,
  needsRefresh: () => account.sharing && models.length === 0,
});
// Background checks are read-only. Transient network errors leave the current UI
// intact and are retried on the next check; user-initiated actions show errors.
const checkAccount = () => { void syncAccount().catch(() => {}); };
setInterval(checkAccount, 3000);
window.addEventListener('focus', checkAccount);
document.addEventListener('visibilitychange', checkAccount);
