import { accountSynchronizer } from '/account-sync.js';

const $ = id => document.getElementById(id);
let chats = [], models = [], account = {}, activeId, busy = false;
const active = () => chats.find(chat => chat.id === activeId);
const CUSTOM_MODEL = '__custom__';
const modelID = () => $('model').value === CUSTOM_MODEL ? $('model-id').value.trim() : $('model').value;
const showError = message => { $('error').textContent = message; $('error').hidden = !message; };
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
  $('send').disabled = busy || !connected || !modelID();
  $('new-chat').disabled = busy;
  $('model').disabled = busy || !connected;
  $('model-id').disabled = busy || !connected;
  $('effort').disabled = busy || !connected;
  $('speed').disabled = busy || !connected;
  $('login').disabled = busy;
  $('logout').disabled = busy;
  $('prompt').disabled = busy;
  $('send').textContent = busy ? 'Replying…' : 'Send';
  for (const button of $('chats').children) button.disabled = busy;
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
async function newChat() {
  const chat = await api('/api/chats', 'POST'); replaceChat(chat); activeId = chat.id;
  $('prompt').value = ''; render(); $('prompt').focus();
}
async function saveSettings() {
  const model = modelID(), effort = $('effort').value, fast = $('speed').getAttribute('aria-pressed') === 'true';
  if (!active()) await newChat();
  const chat = await api(`/api/chats/${activeId}`, 'PATCH', { model, effort, fast });
  replaceChat(chat);
  selectModel(model); fillEfforts(); $('effort').value = effort;
  $('speed').setAttribute('aria-pressed', String(chat.fast));
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
$('composer').onsubmit = safely(async event => {
  event.preventDefault();
  const text = $('prompt').value.trim(); if (!text || busy || !account.sharing) return;
  busy = true; controls(); showError('');
  let received = '', done = false;
  try {
    await saveSettings();
    $('prompt').value = '';
    if (!active().messages.length) $('messages').replaceChildren();
    message('user', text); const reply = message('assistant', 'Thinking…');
    const response = await fetch(`/api/chats/${activeId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed.');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const item = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (item.type === 'delta') { received += item.text; reply.textContent = received; $('messages').scrollTop = $('messages').scrollHeight; }
        if (item.type === 'error') throw new Error(item.message);
        if (item.type === 'notice') showError(item.message);
        if (item.type === 'done') { replaceChat(item.chat); done = true; }
      }
    }
    if (!done) throw new Error('The reply did not finish. Try again.');
    renderChats(); renderMessages();
  } catch (error) {
    // Failed turns are not added to saved history; preserve the draft for retry.
    $('prompt').value = text; renderMessages(); throw error;
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
  canSync: () => !busy && !document.hidden,
});
// Background checks are read-only. Transient network errors leave the current UI
// intact and are retried on the next check; user-initiated actions show errors.
const checkAccount = () => { void syncAccount().catch(() => {}); };
setInterval(checkAccount, 3000);
window.addEventListener('focus', checkAccount);
document.addEventListener('visibilitychange', checkAccount);
