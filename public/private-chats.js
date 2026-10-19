// No localStorage, sessionStorage, IndexedDB, cookies, or server-side chat store.
// Each page instance owns its private conversations and loses them on reload.
export function createPrivateChats({ metadata, fetcher = fetch, uuid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') } = {}) {
  const chats = new Map(), controllers = new Map();
  const visible = chat => {
    const { input, compactions, ...view } = chat;
    return { ...view, messages: chat.messages.map(({ role, text }) => ({ role, text })) };
  };
  function create(folderId = null) {
    const chat = { id: `private-${uuid()}`, private: true, folderId, title: 'Private chat',
      model: '', effort: 'default', fast: false, messages: [], input: [], compactions: [] };
    chats.set(chat.id, chat); return visible(chat);
  }
  function accept(view) {
    if (!view.private) return view;
    const old = chats.get(view.id);
    if (!old) throw new Error('This private chat is closed.');
    const { privateState, ...summary } = view;
    const organization = (old.organizationVersion ?? 0) > (summary.organizationVersion ?? 0)
      ? { title: old.title, titleEdited: old.titleEdited, organizationVersion: old.organizationVersion } : {};
    const chat = { ...old, ...summary, ...privateState, ...organization };
    // Old metadata is kept only here; it is never sent back with the snapshot.
    chat.messages = chat.messages.map((message, index) => ({ ...message,
      metadata: message.metadata ?? old.messages[index]?.metadata }));
    chats.set(chat.id, chat); return visible(chat);
  }
  const match = path => path.match(/^\/api\/chats\/([^/]+)(.*)$/);
  function handles(path) { return chats.has(match(path)?.[1]); }
  async function api(path, method = 'GET', body) {
    const [, id, suffix] = match(path), chat = chats.get(id);
    if (!chat) throw new Error('Private chat not found.');
    const info = suffix.match(/^\/messages\/(\d+)\/metadata$/);
    if (method === 'GET' && info) {
      const data = metadata(chat, Number(info[1]));
      return data ? { ...data, source: 'Kept only in this tab; not saved to the database' } : null;
    }
    if (method === 'PATCH' && !suffix) {
      Object.assign(chat, { model: body.model, effort: body.effort, fast: body.fast === true });
      return visible(chat);
    }
    if (method === 'PATCH' && suffix === '/organization' && typeof body?.title === 'string' &&
        !('folderId' in body) && !('archived' in body)) {
      const title = body.title.trim();
      if (!title || title.length > 120) throw new Error('Enter a name of up to 120 characters.');
      Object.assign(chat, { title, titleEdited: true, organizationVersion: (chat.organizationVersion ?? 0) + 1 });
      return visible(chat);
    }
    throw new Error('Private chats cannot be archived or saved. Use Close private chat to discard them.');
  }
  function request(id, operation, body = {}) {
    const chat = chats.get(id);
    if (!chat) return fetcher(`/api/chats/${id}/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const snapshot = { ...chat,
      // Historical request/event archives stay in browser memory, not in the
      // request body. Only provider replay input and small display data travel.
      messages: chat.messages.map(({ role, text }) => ({ role, text })),
      compactions: chat.compactions.map(({ mode, model, threshold, completed_at, response_id, after_message_count }) =>
        ({ mode, model, threshold, completed_at, response_id, after_message_count })),
    };
    const controller = new AbortController(); controllers.set(id, controller);
    return fetcher(`/api/private/chats/${id}/${operation}`, { signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, chat: snapshot }) });
  }
  return { create, accept, handles, api, request, list: () => [...chats.values()].map(visible),
    has: id => chats.has(id),
    close: id => { controllers.get(id)?.abort(); controllers.delete(id); return chats.delete(id); },
    clear: () => { for (const controller of controllers.values()) controller.abort(); controllers.clear(); chats.clear(); } };
}
