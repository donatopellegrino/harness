import { createPrivateChats } from '/private-chats.js';
import { readableMessageMetadata } from '/readable-metadata.js';
import { accountSynchronizer } from '/account-sync.js';
import { reconcileCompaction } from '/compaction-sync.js';
import { createMessageInfo } from '/message-info.js';
import { resizeComposer } from '/composer.js';
import { createScrollFollow } from '/scroll-follow.js';
import { createAgentsEditor } from '/agents-md.js';
import { createFolders, mergeChat, mergeOrganization, visibleChats } from '/folders.js';

const $ = id => document.getElementById(id);
const privateChats = createPrivateChats({ metadata: readableMessageMetadata });
let chats = [], folders = [], models = [], account = {}, activeId, busy = false, compacting = false, savingSettings = false;
let effortPointer = null;
let activities = new Map(), activityRevision = -1, activityEpoch = 0, lastBusy = false, lastLocked = false, checkingActivity = false;
function applyActivity(snapshot) {
  if (!snapshot || snapshot.revision < activityRevision) return;
  activityRevision = snapshot.revision;
  activities = new Map(snapshot.chats.filter(chat => chat.activity).map(chat => [chat.id, chat.activity]));
  folderSidebar.updateActivity();
}
const displayedActivities = () => { const result = new Map(activities); if (busy && activeId) result.set(activeId, compacting ? 'compacting' : 'replying'); return result; };
const active = () => chats.find(chat => chat.id === activeId);
const CUSTOM_MODEL = '__custom__';
const modelID = () => $('model').value === CUSTOM_MODEL ? $('model-id').value.trim() : $('model').value;
const showError = message => { $('error').textContent = message; $('error').hidden = !message; };
const showStatus = message => { $('context-status').textContent = message; $('context-status').hidden = !message; };
const safely = handler => async (...args) => { try { showError(''); await handler(...args); } catch (error) { showError(error.message); } };
async function api(path, method = 'GET', body) {
  if (privateChats.handles(path)) return privateChats.api(path, method, body);
  const response = await fetch(path, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed.');
  return data;
}
function replaceChat(chat) {
  chat = privateChats.accept(chat);
  const index = chats.findIndex(item => item.id === chat.id);
  if (index < 0) chats.unshift(chat); else chats[index] = mergeChat(chats[index], chat);
}
let archivedView = false;
function selectFirstChat() {
  const chat = visibleChats(chats, archivedView)[0];
  activeId = chat?.id;
  folderSidebar.selectChat(activeId, chat?.folderId);
  if (chat?.folderId) folderSidebar.revealFolder(chat.folderId);
  $('prompt').value = '';
}
const folderSidebar = createFolders({ state: () => ({ folders, chats, activeId, archivedView, locked: busy || savingSettings, activities: displayedActivities() }), api,
  onOrganization: update => { const index = chats.findIndex(chat => chat.id === update.id); if (index >= 0) chats[index] = mergeOrganization(chats[index], update); },
  onFolder: folder => { const index = folders.findIndex(item => item.id === folder.id); if (index < 0) folders.push(folder); else folders[index] = folder; },
  onSelectChat: id => { if (id === activeId) { renderChats(); controls(); return true; } if (busy || savingSettings) return false; activeId = id; $('prompt').value = ''; render(); return true; },
  onLifecycle: ({ id, removed }) => {
    if (removed) { chats = chats.filter(chat => chat.id !== id); activities.delete(id); }
    if (!visibleChats(chats, archivedView).some(chat => chat.id === activeId)) selectFirstChat();
    render();
  },
  onAgents: scope => agentsEditor.open(scope),
  afterRender: controls,
});
const agentsEditor = createAgentsEditor({ api });
$('global-agents').onclick = () => agentsEditor.open();
const messageInfo = createMessageInfo({ load: (chatId, index) => api(`/api/chats/${chatId}/messages/${index}/metadata`) });
const messageScroll = createScrollFollow($('messages'));
$('messages').addEventListener('scroll', () => messageInfo.close());
function controls() {
  if (lastBusy !== busy) { activityEpoch++; if (!busy && activeId) activities.delete(activeId); lastBusy = busy; }
  resizeComposer($('prompt'));
  folderSidebar.updateActivity();
  const connected = account.sharing && models.length > 0;
  const locked = busy || savingSettings;
  const readOnly = active()?.archived === true || archivedView && !active();
  if (lastLocked && !locked) folderSidebar.restoreActiveSelection();
  lastLocked = locked;
  $('send').disabled = locked || readOnly || !connected || !modelID();
  $('send-effort').disabled = $('send').disabled || !$('prompt').value.trim();
  if ($('send-effort').disabled) closeEffortMenu();
  $('new-chat').disabled = locked;
  $('new-private-chat').disabled = locked;
  $('private-notice').hidden = !active()?.private;
  $('close-private-chat').disabled = locked;
  $('new-folder').disabled = locked || archivedView;
  $('archive-view').disabled = locked;
  $('archive-view').setAttribute('aria-pressed', String(archivedView));
  const archivedCount = visibleChats(chats, true).length;
  $('archive-view').textContent = archivedView ? '← Back to chats' : `Archived chats${archivedCount ? ` (${archivedCount})` : ''}`;
  $('archive-notice').hidden = !active()?.archived;
  $('model').disabled = locked || readOnly || !connected;
  $('model-id').disabled = locked || readOnly || !connected;
  $('effort').disabled = locked || readOnly || !connected;
  $('speed').disabled = locked || readOnly || !connected;
  $('login').disabled = locked;
  $('logout').disabled = locked;
  $('prompt').disabled = locked || readOnly;
  $('send').textContent = busy && !compacting ? 'Replying…' : 'Send';
  $('compact').disabled = locked || readOnly || !connected || !modelID() || !active()?.messages.length;
  $('compact').textContent = compacting ? 'Compacting…' : 'Compact context';
  renderContext();
}
function renderContext() {
  const selected = models.find(model => model.id === modelID());
  const limit = selected?.maxContextWindow;
  const threshold = limit && Math.floor(limit * 0.4) >= 1000 ? Math.floor(limit * 0.4) : null;
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
  $('context-policy').textContent = threshold ? `Auto compact at ${number(threshold)} tokens (40% of catalog maximum)` : 'Auto compaction unavailable: catalog maximum missing or below the supported threshold.';
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
function renderChats() { folderSidebar.render(); }
function message(role, text, record = null) {
  const article = document.createElement('article'); article.className = `message ${role}`;
  const label = document.createElement('div'); label.className = 'role';
  const name = document.createElement('span'); name.textContent = role === 'user' ? 'You' : 'Assistant';
  const info = document.createElement('button'); info.type = 'button'; info.className = 'message-info-trigger'; info.textContent = 'ⓘ';
  info.setAttribute('aria-label', `Message info for ${name.textContent}`);
  messageInfo.attach(info, record, role); label.append(name, info);
  const content = document.createElement('div'); content.className = 'content'; content.textContent = text;
  article.append(label, content); $('messages').append(article);
  return content;
}
function renderMessages({ preserveScroll = false } = {}) {
  messageInfo.close();
  const draw = () => {
    $('messages').replaceChildren();
    const history = active()?.messages ?? [];
    const markers = new Map();
    for (const marker of active()?.compactionMarkers ?? []) {
      const boundary = marker.afterMessageCount ?? 0;
      if (!markers.has(boundary)) markers.set(boundary, []);
      markers.get(boundary).push(marker);
    }
    const mark = boundary => {
      for (const marker of markers.get(boundary) ?? []) {
        const row = document.createElement('div'); row.className = 'compaction-marker'; row.setAttribute('role', 'note');
        const label = document.createElement('span');
        label.textContent = marker.mode === 'automatic' ? 'Context compacted automatically' : marker.mode === 'manual' ? 'Context compacted manually' : 'Context compacted';
        if (marker.afterMessageCount === null) label.textContent += ' · position not recorded';
        row.append(label);
        if (marker.completedAt) {
          const date = new Date(marker.completedAt), time = document.createElement('time');
          time.dateTime = date.toISOString(); time.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
          time.title = `Completed ${date.toLocaleString()}`; row.append(time);
        }
        $('messages').append(row);
      }
    };
    mark(0);
    if (!history.length && archivedView) {
      const empty = document.createElement('div'); empty.className = 'empty';
      const title = document.createElement('h1'); title.textContent = 'Archived conversations';
      const subtitle = document.createElement('p'); subtitle.textContent = active()
        ? 'This archived chat has no messages. Restore it from its edit dialog to start chatting.' : 'No archived chats. Archive one from its edit dialog.';
      empty.append(title, subtitle); $('messages').append(empty);
    } else history.forEach((item, index) => { message(item.role, item.text, { chatId: activeId, index, private: active()?.private === true }); mark(index + 1); });
  };
  if (preserveScroll) messageScroll.update(draw); else messageScroll.reset(draw);
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
  const state = await api('/api/state');
  if (account.connected && (!state.auth.connected || state.auth.email !== account.email)) {
    privateChats.clear(); messageInfo.close(); showError(''); $('prompt').value = '';
  }
  chats = [...state.chats, ...privateChats.list()]; folders = state.folders ?? []; account = state.auth; applyActivity(state.activity);
  $('account-status').textContent = account.connected ? `${account.email ?? 'Connected'}\n${account.sharing ? 'Using ChatGPT plan' : 'Plan usage not enabled'}` : 'Not connected';
  $('login').hidden = account.connected && account.sharing;
  $('login').textContent = account.connected ? 'Enable ChatGPT plan usage' : 'Continue with ChatGPT';
  $('logout').hidden = !account.connected;
  models = [];
  if (!visibleChats(chats, archivedView).some(chat => chat.id === activeId)) selectFirstChat();
  render();
  if (account.sharing) { models = (await api('/api/models')).models; render(); }
}
async function newChat({ preserveDraft = false, privateMode = false } = {}) {
  const folderId = archivedView ? null : folderSidebar.selectedFolder();
  const chat = privateMode ? privateChats.create(folderId) : await api('/api/chats', 'POST', { folderId }); archivedView = false; replaceChat(chat); activeId = chat.id; folderSidebar.selectChat(chat.id, chat.folderId); folderSidebar.revealFolder(chat.folderId);
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
$('new-private-chat').onclick = safely(() => newChat({ privateMode: true }));
$('close-private-chat').onclick = () => {
  if (busy || savingSettings || !active()?.private) return;
  const id = activeId; privateChats.close(id); chats = chats.filter(chat => chat.id !== id);
  activities.delete(id); showError(''); selectFirstChat(); render();
};
$('new-chat').onclick = safely(newChat);
$('archive-view').onclick = safely(() => {
  if (busy || savingSettings) return;
  archivedView = !archivedView; selectFirstChat(); render();
});
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
  const result = await api('/api/logout', 'POST');
  privateChats.clear(); chats = chats.filter(chat => !chat.private); messageInfo.close(); showError('');
  await refresh();
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
  const chatId = activeId, privateTurn = active()?.private === true;
  try {
    await saveSettings();
    previousCount = active().compactionCount ?? 0;
    requested = true;
    const response = await privateChats.request(chatId, 'compact');
    await readEvents(response, item => { if (item.type === 'done') { replaceChat(item.chat); done = true; } });
    if (!done) throw new Error('Compaction completion could not be confirmed.');
    renderMessages({ preserveScroll: true });
  } catch (error) {
    showStatus('');
    if (privateTurn && !privateChats.has(chatId)) return;
    if (!requested || privateTurn) throw error;
    let confirmed;
    try {
      confirmed = await reconcileCompaction({ chatId, previousCount,
        readState: () => api('/api/state'),
        onChat: chat => { replaceChat(chat); renderMessages({ preserveScroll: true }); },
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
  const text = $('prompt').value.trim(); if (!text || busy || savingSettings || !account.sharing || archivedView || active()?.archived) return;
  busy = true; controls(); showError(''); showStatus('');
  let received = '', done = false;
  const chatId = activeId, privateTurn = active()?.private === true;
  try {
    await saveSettings();
    $('prompt').value = '';
    resizeComposer($('prompt'));
    let reply;
    messageScroll.reset(() => {
      if (!active().messages.length) $('messages').replaceChildren();
      message('user', text); reply = message('assistant', 'Thinking…');
    });
    const response = await privateChats.request(activeId, 'messages', { text });
    await readEvents(response, item => {
      if (item.type === 'delta') { received += item.text; messageScroll.update(() => { reply.textContent = received; }); }
      if (item.type === 'done') { replaceChat(item.chat); done = true; }
    });
    if (!done) throw new Error('The reply did not finish. Try again.');
    renderChats(); renderMessages({ preserveScroll: true });
  } catch (error) {
    // A closed private tab must never restore its draft into another chat.
    if (privateTurn && !privateChats.has(chatId)) return;
    // Failed turns are not added to saved history; preserve the draft for retry.
    $('prompt').value = text; renderMessages({ preserveScroll: true }); showStatus(''); throw error;
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

window.addEventListener('resize', () => resizeComposer($('prompt')));
async function checkActivity() {
  if (checkingActivity || document.hidden) return;
  checkingActivity = true; const epoch = activityEpoch;
  try { const snapshot = await api('/api/activity'); if (epoch === activityEpoch) applyActivity(snapshot); }
  catch { /* Transient failures keep known activity until the next read. */ }
  finally { checkingActivity = false; }
}
setInterval(checkActivity, 1000);
window.addEventListener('focus', checkActivity);
document.addEventListener('visibilitychange', checkActivity);

// Also clear the rendered transcript before a page can enter the back/forward cache.
window.addEventListener('pagehide', () => {
  const wasPrivate = active()?.private;
  showError(''); messageInfo.close();
  privateChats.clear(); chats = chats.filter(chat => !chat.private);
  if (wasPrivate) { activeId = undefined; $('prompt').value = ''; render(); }
  else renderChats();
});
window.addEventListener('pageshow', event => { if (event.persisted) void safely(refresh)(); });
