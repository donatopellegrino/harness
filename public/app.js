import { observeOperation, operationActive, commandId } from '/operations.js';
import { createChatNavigation, chatIdFromPath } from '/chat-navigation.js';
import { createPrivateChats } from '/private-chats.js';
import { accountSynchronizer } from '/account-sync.js';
import { createMessageInfo } from '/message-info.js';
import { resizeComposer } from '/composer.js';
import { createScrollFollow } from '/scroll-follow.js';
import { createAgentsEditor } from '/agents-md.js';
import { createFolders, mergeChat, mergeOrganization, visibleChats } from '/folders.js';

const $ = id => document.getElementById(id);
const privateChats = createPrivateChats();
let chats = [], folders = [], models = [], account = {}, activeId, busy = false, compacting = false, savingSettings = false;
let effortPointer = null, submitting = false, observation = null, pageHidden = false;
let activities = new Map(), activityRevision = -1, activityInstance, activityEpoch = 0, lastBusy = false, lastLocked = false, checkingActivity = false;
function applyActivity(snapshot) {
  if (!snapshot) return;
  if (snapshot.instance !== activityInstance) { activityInstance = snapshot.instance; activityRevision = -1; }
  if (snapshot.revision < activityRevision) return;
  activityRevision = snapshot.revision;
  activities = new Map(snapshot.chats.filter(chat => chat.activity).map(chat => [chat.id, chat.activity]));
  folderSidebar.updateActivity();
  const current = active(), remote = snapshot.chats.find(chat => chat.id === activeId);
  if (remote?.operationId && (remote.operationId !== current?.operation?.id || remote.operationStatus !== current?.operation?.status)) void loadChat(activeId);
}
const displayedActivities = () => { const result = new Map(activities); if (busy && activeId) result.set(activeId, compacting ? 'compacting' : 'replying'); return result; };
const active = () => chats.find(chat => chat.id === activeId);
const CUSTOM_MODEL = '__custom__';
const modelID = () => $('model').value === CUSTOM_MODEL ? $('model-id').value.trim() : $('model').value;
const showError = message => { $('error').textContent = message; $('error').hidden = !message; };
const showStatus = message => { $('context-status').textContent = message; $('context-status').hidden = !message; };
const safely = handler => async (...args) => { try { showError(''); await handler(...args); } catch (error) { showError(error.message); } };
async function api(path, method = 'GET', body) { return privateChats.api(path, method, body); }

function replaceChat(chat) {
  const index = chats.findIndex(item => item.id === chat.id);
  chat = privateChats.accept(mergeChat(chats[index], chat));
  if (index < 0) chats.unshift(chat); else chats[index] = chat;
}
let archivedView = false, initialNavigation = true;
function selectFirstChat({ replace = true } = {}) {
  const chat = visibleChats(chats, archivedView)[0];
  activeId = chat?.id;
  folderSidebar.selectChat(activeId, chat?.folderId);
  if (chat?.folderId) folderSidebar.revealFolder(chat.folderId);
  $('prompt').value = '';
  navigation.write(chat, { replace });
}
const folderSidebar = createFolders({ state: () => ({ folders, chats, activeId, archivedView, locked: submitting || savingSettings, activities: displayedActivities() }), api,
  onOrganization: update => { const index = chats.findIndex(chat => chat.id === update.id); if (index >= 0) chats[index] = mergeOrganization(chats[index], update); },
  onFolder: folder => { const index = folders.findIndex(item => item.id === folder.id); if (index < 0) folders.push(folder); else folders[index] = folder; },
  onSelectChat: id => { if (id === activeId) { renderChats(); controls(); return true; } if (submitting || savingSettings) return false; activeId = id; $('prompt').value = ''; showError(''); navigation.write(active()); render(); void loadChat(id); return true; },
  onLifecycle: ({ id, removed }) => {
    if (removed) { chats = chats.filter(chat => chat.id !== id); activities.delete(id); }
    if (!visibleChats(chats, archivedView).some(chat => chat.id === activeId)) selectFirstChat();
    render();
  },
  onAgents: scope => agentsEditor.open(scope),
  afterRender: controls,
});
const agentsEditor = createAgentsEditor({ api });
function clearPrivateChats() {
  folderSidebar.clearPrivateEditor(); privateChats.clear();
}
$('global-agents').onclick = () => agentsEditor.open();
const messageInfo = createMessageInfo({ load: (chatId, index) => api(`/api/chats/${chatId}/messages/${index}/metadata`) });
const messageScroll = createScrollFollow($('messages'));
$('messages').addEventListener('scroll', () => messageInfo.close());
const navigation = createChatNavigation({ location: window.location, history: window.history,
  findChat: id => chats.find(chat => chat.id === id), isLocked: () => submitting || savingSettings,
  onSelect: chat => {
    showError('');
    if (!chat) { archivedView = false; selectFirstChat(); }
    else {
      archivedView = chat.archived === true; activeId = chat.id;
      folderSidebar.selectChat(chat.id, chat.folderId); folderSidebar.revealFolder(chat.folderId);
      $('prompt').value = '';
    }
    render(); if (chat) void loadChat(chat.id);
  },
  onMissing: () => {
    activeId = undefined; archivedView = false; folderSidebar.selectChat(undefined);
    $('prompt').value = ''; render(); showError('This chat was deleted or is not available.');
  },
});
window.addEventListener('popstate', () => {
  const locked = submitting || savingSettings;
  navigation.openLocation();
  if (locked) showStatus('The linked chat will open when the current request finishes.');
});
function controls() {
  busy = submitting || operationActive(active()?.operation); compacting = active()?.operation?.kind === 'compaction' && operationActive(active()?.operation);
  if (navigation.flush()) return;
  if (lastBusy !== busy) { activityEpoch++; if (!busy && activeId) activities.delete(activeId); lastBusy = busy; }
  resizeComposer($('prompt'));
  folderSidebar.updateActivity();
  const connected = account.sharing && models.length > 0;
  const locked = submitting || savingSettings;
  const readOnly = active()?.archived === true || archivedView && !active();
  if (lastLocked && !locked) folderSidebar.restoreActiveSelection();
  lastLocked = locked;
  $('send').disabled = locked || operationActive(active()?.operation) || readOnly || !connected || !modelID();
  $('send-effort').disabled = $('send').disabled || !$('prompt').value.trim();
  if ($('send-effort').disabled) closeEffortMenu();
  $('new-chat').disabled = locked;
  $('new-private-chat').disabled = locked;
  $('private-notice').hidden = !active()?.private;
  $('close-private-chat').disabled = submitting || savingSettings;
  $('new-folder').disabled = locked || archivedView;
  $('archive-view').disabled = locked;
  $('archive-view').setAttribute('aria-pressed', String(archivedView));
  const archivedCount = visibleChats(chats, true).length;
  $('archive-view').textContent = archivedView ? '← Back to chats' : `Archived chats${archivedCount ? ` (${archivedCount})` : ''}`;
  $('archive-notice').hidden = !active()?.archived;
  $('model').disabled = locked || operationActive(active()?.operation) || readOnly || !connected;
  $('model-id').disabled = locked || operationActive(active()?.operation) || readOnly || !connected;
  $('effort').disabled = locked || operationActive(active()?.operation) || readOnly || !connected;
  $('speed').disabled = locked || operationActive(active()?.operation) || readOnly || !connected;
  $('login').disabled = locked;
  $('logout').disabled = locked || displayedActivities().size > 0;
  $('prompt').disabled = locked || readOnly;
  $('send').textContent = busy && !compacting ? 'Replying…' : 'Send';
  $('compact').disabled = locked || operationActive(active()?.operation) || readOnly || !connected || !modelID() || !active()?.messages.length;
  $('compact').textContent = compacting ? 'Compacting…' : 'Compact context';
  const operation = active()?.operation;
  const status = operation?.error || (operationActive(operation) ? operation.message || (operation.kind === 'compaction' ? 'Compacting context…' : 'Replying…') : operation?.kind === 'compaction' && operation.status === 'completed' ? 'Context compacted.' : '');
  $('operation-status').textContent = status; $('operation-status').hidden = !status;
  if (operation?.notice) showStatus(operation.notice);
  renderContext(); watchActiveOperation();
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
    const operation = active()?.operation;
    if (operation && operation.status !== 'completed' && operation.kind === 'reply') {
      if (operation.prompt) message('user', operation.prompt);
      if (operation.text || operationActive(operation)) message('assistant', operation.text || 'Thinking…');
      if (!operationActive(operation)) {
        const note = document.createElement('p'); note.className = 'operation-incomplete';
        note.textContent = operation.text ? 'Unfinished reply · Partial text preserved by the backend.' : 'This reply did not complete.';
        $('messages').append(note);
      }
    }
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
    clearPrivateChats(); messageInfo.close(); showError(''); $('prompt').value = '';
  }
  chats = [...state.chats, ...await privateChats.refresh()].map(chat => mergeChat(chats.find(current => current.id === chat.id), chat)); folders = state.folders ?? []; account = state.auth; applyActivity(state.activity);
  $('account-status').textContent = account.connected ? `${account.email ?? 'Connected'}\n${account.sharing ? 'Using ChatGPT plan' : 'Plan usage not enabled'}` : 'Not connected';
  $('login').hidden = account.connected && account.sharing;
  $('login').textContent = account.connected ? 'Enable ChatGPT plan usage' : 'Continue with ChatGPT';
  $('logout').hidden = !account.connected;
  models = [];
  if (initialNavigation) { initialNavigation = false; navigation.openLocation(); }
  else if (!visibleChats(chats, archivedView).some(chat => chat.id === activeId)) {
    if (chatIdFromPath(window.location.pathname)) navigation.openLocation();
    else selectFirstChat();
  }
  render();
  if (account.sharing) { models = (await api('/api/models')).models; render(); }
}
async function newChat({ preserveDraft = false, privateMode = false } = {}) {
  const folderId = archivedView ? null : folderSidebar.selectedFolder();
  const chat = privateMode ? await privateChats.create(folderId) : await api('/api/chats', 'POST', { folderId }); archivedView = false; replaceChat(chat); activeId = chat.id; folderSidebar.selectChat(chat.id, chat.folderId); folderSidebar.revealFolder(chat.folderId);
  navigation.write(chat);
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
$('close-private-chat').onclick = safely(async () => {
  if (submitting || savingSettings || !active()?.private) return;
  const id = activeId; folderSidebar.clearPrivateEditor();
  try { await privateChats.close(id); }
  finally {
    chats = chats.filter(chat => chat.id !== id); activities.delete(id); selectFirstChat(); render();
  }
});
$('new-chat').onclick = safely(newChat);
$('archive-view').onclick = safely(() => {
  if (submitting || savingSettings) return;
  archivedView = !archivedView; selectFirstChat({ replace: false }); render();
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
  clearPrivateChats(); chats = chats.filter(chat => !chat.private); messageInfo.close(); showError('');
  await refresh();
  if (!result.revoked) showError('Signed out locally. Remote revocation was not confirmed; disconnect Basic Harness in ChatGPT settings.');
});

async function loadChat(id) {
  try {
    const chat = await api(`/api/chats/${id}`);
    if (chat.private && !privateChats.has(id)) return;
    replaceChat(chat);
    if (activeId === id) { renderMessages({ preserveScroll: true }); controls(); }
  } catch (error) { if (activeId === id) showError(error.message); }
}
function watchActiveOperation() {
  const chat = active(), operation = chat?.operation;
  const key = !pageHidden && operationActive(operation) ? operation.id : null;
  if (observation?.key === key) return;
  observation?.controller.abort(); observation = null;
  $('connection-status').hidden = true;
  if (!key) return;
  const controller = new AbortController(); observation = { key, controller };
  void observeOperation({ fetcher: privateChats.fetch, path: `/api/chats/${chat.id}/operations/${key}/events`, signal: controller.signal,
    onSnapshot: event => {
      if (chat.private && !privateChats.has(chat.id)) return;
      const current = chats.find(item => item.id === chat.id); if (!current) return;
      replaceChat(event.chat ?? { ...current, operation: event.operation });
      if (activeId === chat.id) { renderMessages({ preserveScroll: true }); controls(); }
    },
    onConnection: message => {
      if (activeId !== chat.id || controller.signal.aborted) return;
      $('connection-status').textContent = message; $('connection-status').hidden = !message;
    },
    onUnavailable: () => { if (!controller.signal.aborted) void safely(refresh)(); },
  });
}
async function startOperation(kind, text) {
  if (submitting || savingSettings || operationActive(active()?.operation) || active()?.archived) return;
  const chat = active(), requestId = commandId();
  const command = { requestId, kind, ...(text === undefined ? {} : { text }), model: modelID(), effort: $('effort').value,
    fast: $('speed').getAttribute('aria-pressed') === 'true' };
  submitting = true; controls();
  const apply = result => {
    replaceChat(result.chat);
    activeId = result.chat.id; archivedView = false;
    folderSidebar.selectChat(activeId, result.chat.folderId); folderSidebar.revealFolder(result.chat.folderId);
    navigation.write(result.chat);
    if (kind === 'reply') $('prompt').value = '';
    render();
  };
  try {
    const result = chat?.private ? await api(`/api/chats/${chat.id}/operations`, 'POST', command)
      : await api('/api/operations', 'POST', { ...command, ...(chat ? { chatId: chat.id } : { folderId: folderSidebar.selectedFolder() }) });
    apply(result);
  } catch (error) {
    // A missing HTTP acknowledgment is not a reason to submit the command a
    // second time. Ask the backend whether this request was already accepted.
    let recovered;
    try {
      if (chat?.private) {
        const current = await api(`/api/chats/${chat.id}`);
        if (current.operation?.requestId === requestId) recovered = { chat: current };
      } else recovered = await api(`/api/operations/requests/${requestId}`);
    } catch { /* The original error is reported; the draft remains available. */ }
    if (recovered) apply(recovered); else throw error;
  } finally { submitting = false; controls(); }
}
$('compact').onclick = safely(() => startOperation('compaction'));

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
  const text = $('prompt').value.trim();
  if (!text || submitting || savingSettings || !account.sharing || archivedView || active()?.archived) return;
  await startOperation('reply', text);
  $('prompt').focus();
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
});
const login = new URLSearchParams(window.location.search).get('login');
await safely(refresh)();
if (login && login !== 'success') showError(login);
if (login) {
  const url = new URL(window.location.href); url.searchParams.delete('login');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

const syncAccount = accountSynchronizer({
  readStatus: () => api('/api/account'),
  currentStatus: () => account,
  onChange: refresh,
  canSync: () => !submitting && !savingSettings && !document.hidden,
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
  pageHidden = true; observation?.controller.abort(); observation = null;
  const wasPrivate = active()?.private;
  showError(''); messageInfo.close();
  clearPrivateChats(); chats = chats.filter(chat => !chat.private);
  if (wasPrivate) { activeId = undefined; $('prompt').value = ''; render(); }
  else renderChats();
});
window.addEventListener('pageshow', event => { pageHidden = false; if (event.persisted) void safely(refresh)(); });
