import { mergeChat } from './folders.js';

// The backend owns private chat state. This page keeps only an ephemeral access
// capability and display projections; neither is written to browser storage.
export function createPrivateChats({ fetcher = fetch } = {}) {
  const chats = new Map(); let epoch = 0;
  const match = path => path.match(/^\/api\/chats\/([^/]+)(.*)$/);
  async function request(path, options = {}) {
    const parsed = match(path), entry = parsed && chats.get(parsed[1]);
    if (entry) {
      path = `/api/private/chats/${parsed[1]}${parsed[2]}`;
      options = { ...options, headers: { ...options.headers, 'X-Private-Chat-Token': entry.token } };
    }
    let response = await fetcher(path, options);
    if (response.status === 403) {
      // A restarted backend issues a fresh local session cookie. Refreshing it
      // does not restart, retry, or cancel a model operation.
      const page = await fetcher('/'); await page.text();
      response = await fetcher(path, options);
    }
    return response;
  }
  async function api(path, method = 'GET', body) {
    const response = await request(path, { method, headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error ?? 'Request failed.'), { status: response.status });
    return value;
  }
  async function create(folderId = null) {
    const current = epoch, result = await api('/api/private/chats', 'POST', { folderId });
    if (current !== epoch) throw new Error('This page was closed before the private chat opened.');
    chats.set(result.chat.id, { token: result.token, view: result.chat }); return result.chat;
  }
  function accept(chat) {
    if (chat.private) {
      const entry = chats.get(chat.id);
      if (!entry) throw new Error('This private chat is no longer open in this page.');
      entry.view = mergeChat(entry.view, chat);
      return entry.view;
    }
    return chat;
  }
  async function refresh() {
    await Promise.all([...chats].map(async ([id]) => {
      try { accept(await api(`/api/chats/${id}`)); }
      catch (error) { if (error.status === 404) chats.delete(id); else throw error; }
    }));
    return [...chats.values()].map(entry => entry.view);
  }
  return { create, accept, api, fetch: request, refresh,
    handles: path => chats.has(match(path)?.[1]), has: id => chats.has(id), list: () => [...chats.values()].map(entry => entry.view),
    close: async id => { try { await api(`/api/chats/${id}`, 'DELETE', {}); } finally { chats.delete(id); } },
    clear: () => { epoch++; chats.clear(); } };
}
