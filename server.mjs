import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ChatGPTAuth } from './lib/auth.mjs';
import { Store } from './lib/store.mjs';
import { normalizeModels, resolveModel, responseText, streamReply, latestUsage, autoCompactThreshold, compactedInput } from './lib/responses.mjs';
import { readableMessageMetadata } from './lib/message-metadata.mjs';
import { compactionMarkers } from './lib/compaction-markers.mjs';
import { itemName, folderParent } from './lib/folders.mjs';
import { ChatOperations, activeOperation, operationView } from './lib/chat-operations.mjs';
import { agentsInstructions } from './lib/agents-md.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/account-sync.js', ['account-sync.js', 'text/javascript']],
  ['/compaction-sync.js', ['compaction-sync.js', 'text/javascript']],
  ['/composer.js', ['composer.js', 'text/javascript']],
  ['/scroll-follow.js', ['scroll-follow.js', 'text/javascript']],
  ['/activity.js', ['activity.js', 'text/javascript']],
  ['/folders.js', ['folders.js', 'text/javascript']],
  ['/agents-md.js', ['agents-md.js', 'text/javascript']],
  ['/private-chats.js', ['private-chats.js', 'text/javascript']],
  ['/chat-navigation.js', ['chat-navigation.js', 'text/javascript']],
  ['/operations.js', ['operations.js', 'text/javascript']],
  ['/readable-metadata.js', ['../lib/message-metadata.mjs', 'text/javascript']],
  ['/message-info.js', ['message-info.js', 'text/javascript']],
  ['/theme.js', ['theme.js', 'text/javascript']],
]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
};
// Keep the ordinary UI payload small; full metadata stays in protected storage.
const organizationView = chat => ({ id: chat.id, title: chat.title, folderId: chat.folderId ?? null, archived: chat.archived === true, organizationVersion: chat.organizationVersion ?? 0 });
const view = chat => ({ ...organizationView(chat), model: chat.model, effort: chat.effort, fast: chat.fast === true,
  contextUsage: chat.contextUsageSource === 'compaction' ? chat.contextUsage : latestUsage(chat.messages),
  contextUsageSource: chat.contextUsageSource === 'compaction' ? 'compaction' : 'reply',
  compactionCount: chat.compactions?.length ?? 0,
  compactionMarkers: compactionMarkers(chat.messages, chat.compactions),
  messages: chat.messages.map(({ role, text }) => ({ role, text })) });

export async function readJSON(request, limit = 128 * 1024) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw fail('Expected JSON.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail('Message is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON.'); }
}

export async function createHarness({ port = 0, directory = join(root, '.data'), auth, fetcher = fetch } = {}) {
  const store = new Store(directory);
  auth ??= new ChatGPTAuth(store);
  const cookie = `harness_session=${randomBytes(32).toString('hex')}`;
  let origin, catalog = [], catalogAt = 0;
  const activityInstance = randomUUID();
  let activityRevision = 0, activeRequests = 0, serverClosed = false, storeClosed = false;
  const maybeClose = () => {
    if (serverClosed && !activeRequests && !jobs.tasks.size && !storeClosed) {
      storeClosed = true; jobs.dispose(); store.close();
    }
  };
  const jobs = new ChatOperations({ store, execute: executeOperation, onChange: () => { activityRevision++; maybeClose(); } });
  const findChat = id => jobs.chat(id);
  const chatView = chat => ({ ...view(chat), ...(chat.private ? { private: true } : {}), operation: operationView(jobs.latest(chat)) });
  const activity = () => ({ instance: activityInstance, revision: activityRevision, chats: store.listChatHeaders().map(chat => {
    const operation = jobs.latest(chat);
    return { id: chat.id, activity: activeOperation(operation) ? operation.kind === 'compaction' ? 'compacting' : 'replying' : null,
      operationId: operation?.id ?? null, operationStatus: operation?.status ?? null };
  }) });
  const commitChat = (chat, changes) => {
    if (chat.private) Object.assign(chat, changes);
    else Object.assign(chat, store.updateChat(chat.id, changes));
  };
  function startCommand(chat, body, newChat = false) {
    const kind = body.kind ?? 'reply', manual = kind === 'compaction';
    if (!['reply', 'compaction'].includes(kind)) throw fail('Choose reply or compaction.');
    if (manual ? !chat.input.length : typeof body.text !== 'string' || !body.text.trim() || body.text.length > 32000)
      throw fail(manual ? 'Send a message before compacting this chat.' : 'Enter a message of up to 32,000 characters.');
    const requestId = body.requestId ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId)) throw fail('Invalid request ID.');
    const commandHash = createHash('sha256').update(JSON.stringify({ chatId: newChat ? null : chat.id, folderId: newChat ? body.folderId ?? null : chat.folderId ?? null,
      kind, text: manual ? null : body.text.trim(), model: body.model ?? null, effort: body.effort ?? null, fast: body.fast ?? null })).digest('hex');
    const prior = jobs.prior(requestId, chat.private ? chat : null);
    if (prior) {
      if (prior.command_hash !== commandHash) throw fail('This request ID was already used for a different command.', 409);
      return prior;
    }
    if (chat.archived) throw fail('Restore this archived chat before starting an operation.', 409);
    if (jobs.running.has(chat.id)) throw fail('This chat is already working.', 409);
    const model = body.model ?? chat.model, effort = body.effort ?? chat.effort, fast = body.fast ?? chat.fast ?? false;
    if (typeof model !== 'string' || !model || typeof effort !== 'string' || typeof fast !== 'boolean') throw fail('Choose a model and effort.');
    const agents = store.agentsForChat(chat.folderId ?? null);
    return jobs.start({ chat, newChat, requestId, commandHash, kind,
      request: { model, effort, fast, ...(manual ? {} : { text: body.text.trim() }), instructions: agentsInstructions(agents),
        agents: agents.map(({ folderId, revision, updatedAt }) => ({ folderId, revision, updatedAt })) } });
  }
  async function executeOperation(record, chat, { delta, status, notice }) {
    const manual = record.kind === 'compaction', request = record.request;
    let metadata;
    try {
      const selected = resolveModel(await models(), request.model);
      if (request.effort !== 'default' && !selected.efforts.includes(request.effort)) throw fail('Choose a supported effort.');
      const token = await auth.accessToken(), threshold = manual ? 1000 : autoCompactThreshold(selected);
      if (manual) status('Compacting context… This can take a few minutes.');
      const input = manual ? chat.input : [...chat.input, { role: 'user', content: request.text }];
      const output = await streamReply({ fetcher, token, model: request.model, effort: request.effort, fast: request.fast,
        input, instructions: request.instructions, compactThreshold: threshold, requireMessage: !manual,
        signal: new AbortController().signal,
        onDelta: text => { if (!manual) delta(text); },
        onCompaction: () => status('Compacted context received; finishing the operation…'),
        onServiceTier: tier => { if (request.fast && tier === 'default') notice('Fast mode was requested, but OpenAI used Standard processing for this reply.'); },
        onMetadata: value => { metadata = { ...value, operation_id: record.id, request_id: record.request_id, agents_md: request.agents }; },
      });
      const checkpoint = output.findLast(item => item.type === 'compaction');
      const nextInput = compactedInput([...input, ...output]);
      if (manual && !checkpoint) throw fail('Nothing to compact: OpenAI requires at least 1,000 context tokens, or this model did not return a compaction. History was not changed.');
      const compactions = checkpoint ? [...(chat.compactions ?? []), {
        mode: manual ? 'manual' : 'automatic', model: request.model, threshold,
        completed_at: metadata.finished_at, response_id: metadata.response?.id,
        after_message_count: chat.messages.length + (manual ? 0 : 2), previous_input: chat.input,
        ...(manual ? { metadata } : {}),
      }] : chat.compactions;
      if (checkpoint) status(`${manual ? 'Context compacted' : 'Context automatically compacted'}. Chat history is preserved.`);
      return manual ? { input: [checkpoint], compactions,
        contextUsage: latestUsage([{ role: 'assistant', metadata }]), contextUsageSource: 'compaction' } : {
        input: nextInput, compactions, contextUsage: null, contextUsageSource: 'reply',
        messages: [...chat.messages, { role: 'user', text: request.text, metadata: { sent_at: metadata.started_at, request: metadata.request } },
          { role: 'assistant', text: responseText(output), metadata }],
        title: chat.messages.length === 0 && !chat.titleEdited ? request.text.replace(/\s+/g, ' ').slice(0, 60) : chat.title,
      };
    } catch (error) {
      if (metadata) error.attempt = { ...(manual ? { operation: 'compaction' } : { text: request.text }), error: error.message, metadata };
      throw error;
    }
  }
  function observe(record, chat, response, legacy = false) {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' }); response.flushHeaders();
    let sent = '', ended = false;
    const send = event => { if (!response.destroyed && response.writableLength < 1024 * 1024) response.write(JSON.stringify(event) + '\n'); else response.destroy(); };
    const listener = event => {
      if (ended || response.destroyed) return;
      const snapshot = event.operation;
      if (legacy) {
        if (snapshot.text && snapshot.text !== sent) { send({ type: 'delta', text: snapshot.text.slice(sent.length) }); sent = snapshot.text; }
        if (snapshot.message) send({ type: 'status', message: snapshot.message });
        if (snapshot.notice) send({ type: 'notice', message: snapshot.notice });
        if (!activeOperation(snapshot)) {
          send(snapshot.status === 'completed' ? { type: 'done', chat: chatView(event.chat ?? chat) } : { type: 'error', message: snapshot.error });
          ended = true; response.end();
        }
      } else {
        send({ ...event, ...(event.chat ? { chat: chatView(event.chat) } : {}) });
        if (!activeOperation(snapshot)) { ended = true; response.end(); }
      }
    };
    const unsubscribe = jobs.subscribe(record.id, listener);
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write('\n'); }, 15000); heartbeat.unref();
    const cleanup = () => { unsubscribe(); clearInterval(heartbeat); };
    response.on('close', cleanup);
    const current = jobs.record(record.id, chat.private) ?? record;
    listener({ type: 'operation', operation: operationView(current), chat });
    if (ended) cleanup();
  }

  async function models() {
    const token = await auth.accessToken();
    if (Date.now() - catalogAt < 60000) return catalog;
    const response = await fetcher('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw fail(`Could not load your ChatGPT models (HTTP ${response.status}). Reconnect or try again.`, 502);
    catalog = normalizeModels(await response.json());
    catalogAt = Date.now();
    return catalog;
  }

  const server = createServer(async (request, response) => {
    activeRequests++;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== new URL(origin).host) throw fail('Unexpected host.', 403);
      const url = new URL(request.url, origin);
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        let result = 'success';
        try { await auth.finish(url.searchParams); catalogAt = 0; }
        catch (error) { result = error.message; }
        response.writeHead(303, { Location: `/?login=${encodeURIComponent(result)}` });
        return response.end();
      }
      const chatPage = /^\/chats\/[\w-]+$/.test(url.pathname);
      if ((assets.has(url.pathname) || chatPage) && request.method === 'GET') {
        const [name, type] = assets.get(chatPage ? '/' : url.pathname);
        if (url.pathname === '/' || chatPage) response.setHeader('Set-Cookie', `${cookie}; HttpOnly; SameSite=Strict; Path=/`);
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return response.end(readFileSync(join(root, 'public', name)));
      }
      if (!request.headers.cookie?.split(';').map(value => value.trim()).includes(cookie)) throw fail('Open the app before making requests.', 403);
      if (request.headers.origin && request.headers.origin !== origin) throw fail('Cross-origin requests are not allowed.', 403);
      if (request.method !== 'GET' && request.headers.origin !== origin) throw fail('A same-origin request is required.', 403);

      const scoped = url.pathname.match(/^\/api\/private\/chats\/([\w-]+)(.*)$/);
      const privateChat = scoped ? jobs.privateChat(scoped[1], request.headers['x-private-chat-token']) : null;
      if (scoped && !privateChat) throw fail('Private chat expired or is unavailable.', 404);
      const path = scoped ? `/api/chats/${scoped[1]}${scoped[2]}` : url.pathname;
      const scopedChat = id => privateChat?.id === id ? jobs.privateChat(id, request.headers['x-private-chat-token']) : findChat(id);
      if (url.pathname === '/api/private/chats' && request.method === 'POST') {
        const body = await readJSON(request);
        const folderId = folderParent(store.listFolders(), body?.folderId ?? null);
        const created = jobs.createPrivate(folderId);
        return json(response, { chat: chatView(created.chat), token: created.token }, 201);
      }
      if (url.pathname === '/api/operations' && request.method === 'POST') {
        const body = await readJSON(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.private !== undefined) throw fail('Expected a saved-chat operation command.');
        let chat = body.chatId ? findChat(body.chatId) : null;
        const prior = typeof body.requestId === 'string' ? jobs.prior(body.requestId) : null;
        if (prior && !body.chatId) {
          chat = { ...findChat(prior.chat_id), id: prior.chat_id };
          const record = startCommand(chat, body, true);
          return json(response, { operation: operationView(record), chat: chatView(chat) }, 202);
        }
        if (body.chatId && !chat) throw fail('Chat not found.', 404);
        if (!chat) chat = { id: randomUUID(), folderId: folderParent(store.listFolders(), body.folderId ?? null), title: 'New chat', model: '', effort: 'default', messages: [], input: [] };
        const record = startCommand(chat, body, !body.chatId);
        return json(response, { operation: operationView(record), chat: chatView(findChat(record.chat_id)) }, 202);
      }
      const requestMatch = path.match(/^\/api\/operations\/requests\/([\w-]+)$/);
      if (requestMatch && request.method === 'GET') {
        const record = jobs.prior(requestMatch[1]); if (!record) throw fail('Command was not accepted.', 404);
        const chat = findChat(record.chat_id);
        return json(response, { operation: operationView(record), chat: chatView(chat) });
      }
      const operationMatch = path.match(/^\/api\/chats\/([\w-]+)\/operations\/([\w-]+)(\/events)?$/);
      if (operationMatch && request.method === 'GET') {
        const chat = scopedChat(operationMatch[1]), record = jobs.record(operationMatch[2], !!privateChat);
        if (!chat || !record || record.chat_id !== chat.id) throw fail('Operation not found.', 404);
        if (operationMatch[3]) return observe(record, chat, response);
        return json(response, { operation: operationView(record), chat: chatView(chat) });
      }
      const getChatMatch = path.match(/^\/api\/chats\/([\w-]+)$/);
      if (getChatMatch && request.method === 'GET') {
        const chat = scopedChat(getChatMatch[1]); if (!chat) throw fail('Chat not found.', 404);
        return json(response, chatView(chat));
      }
      if (url.pathname === '/api/state' && request.method === 'GET') return json(response, { auth: auth.status(), chats: store.listChatsForDisplay().map(chatView), folders: store.listFolders(), activity: activity() });
      if (url.pathname === '/api/activity' && request.method === 'GET') return json(response, activity());
      if (url.pathname === '/api/account' && request.method === 'GET') return json(response, auth.status());
      if (url.pathname === '/api/models' && request.method === 'GET') return json(response, { models: await models() });
      const agentsMatch = url.pathname.match(/^\/api\/(?:agents-md\/(global)|folders\/([\w-]+)\/agents-md)$/);
      if (agentsMatch) {
        const folderId = agentsMatch[2] ?? null;
        if (folderId !== null && !store.listFolders().some(folder => folder.id === folderId)) throw fail('Folder not found.', 404);
        if (request.method === 'GET') return json(response, store.getAgentsMd(folderId));
        if (request.method === 'PUT') {
          const body = await readJSON(request);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Expected a JSON object.');
          return json(response, store.saveAgentsMd(folderId, body.content, body.revision));
        }
        throw fail('Method not allowed.', 405);
      }
      const metadataMatch = path.match(/^\/api\/chats\/([\w-]+)\/messages\/(\d+)\/metadata$/);
      if (metadataMatch && request.method === 'GET') {
        const chat = scopedChat(metadataMatch[1]);
        const index = Number(metadataMatch[2]);
        if (!chat || !Number.isSafeInteger(index)) throw fail('Message not found.', 404);
        const data = readableMessageMetadata(chat, index);
        if (!data) throw fail('Message not found.', 404);
        return json(response, data);
      }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        if (jobs.running.size) throw fail('Wait for the reply to finish first.', 409);
        return json(response, { url: await auth.begin(origin) });
      }
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        if (jobs.running.size) throw fail('Wait for the reply to finish first.', 409);
        const result = await auth.logout(); catalog = []; catalogAt = 0;
        return json(response, result);
      }
      if (url.pathname === '/api/folders' && request.method === 'POST') {
        const body = await readJSON(request);
        const folder = { id: randomUUID(), name: itemName(body?.name), parentId: folderParent(store.listFolders(), body?.parentId ?? null) };
        store.createFolder(folder); return json(response, folder, 201);
      }
      const folderMatch = url.pathname.match(/^\/api\/folders\/([\w-]+)$/);
      if (folderMatch && request.method === 'PATCH') {
        const folder = store.listFolders().find(item => item.id === folderMatch[1]);
        if (!folder) throw fail('Folder not found.', 404);
        const body = await readJSON(request);
        if (!body || typeof body !== 'object' || !('name' in body)) throw fail('Provide a folder name.');
        if ('parentId' in body) throw fail('Existing folders cannot be moved.');
        const changes = { name: itemName(body.name) };
        return json(response, store.updateFolder(folder.id, changes));
      }
      const organizationMatch = path.match(/^\/api\/chats\/([\w-]+)\/organization$/);
      if (organizationMatch && request.method === 'PATCH') {
        let chat = scopedChat(organizationMatch[1]);
        if (!chat) throw fail('Chat not found.', 404);
        const body = await readJSON(request);
        if (!body || typeof body !== 'object') throw fail('Expected a JSON object.');
        if (chat.private && 'archived' in body) throw fail('Private chats cannot be archived.');
        if ('folderId' in body) throw fail('A chat\'s container is fixed at creation. Existing chats cannot be moved.');
        if (!('title' in body) && !('archived' in body)) throw fail('Provide a name or archive state.');
        if ('archived' in body && typeof body.archived !== 'boolean') throw fail('Archive state must be on or off.');
        // A reply or another rename may start while the body is arriving.
        // Re-read the current header or share that reply's in-flight object.
        chat = scopedChat(organizationMatch[1]);
        if (!chat) throw fail('Chat not found.', 404);
        if ('archived' in body && jobs.running.has(chat.id)) throw fail('Wait for this chat to finish working before archiving or restoring it.', 409);
        // Organization is independent of generation settings and can change during a reply.
        commitChat(chat, { ...('title' in body ? { title: itemName(body.title), titleEdited: true } : {}),
          ...('archived' in body ? { archived: body.archived } : {}),
          organizationVersion: (chat.organizationVersion ?? 0) + 1 });
        return json(response, organizationView(chat));
      }
      if (url.pathname === '/api/chats' && request.method === 'POST') {
        const body = request.headers['transfer-encoding'] || Number(request.headers['content-length']) > 0 ? await readJSON(request) : {};
        if (body?.private !== undefined) throw fail('Private chats must use the temporary chat interface.');
        const folderId = folderParent(store.listFolders(), body?.folderId ?? null);
        const chat = { id: randomUUID(), folderId, title: 'New chat', model: '', effort: 'default', fast: false, messages: [], input: [] };
        store.createChat(chat); return json(response, chatView(chat), 201);
      }
      const match = path.match(/^\/api\/chats\/([\w-]+)(\/(?:messages|compact|operations))?$/);
      if (!match) throw fail('Not found.', 404);
      let chat = scopedChat(match[1]); if (!chat) throw fail('Chat not found.', 404);
      const body = await readJSON(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Expected a JSON object.');
      chat = scopedChat(match[1]); if (!chat) throw fail('Chat not found.', 404);
      if (!match[2] && request.method === 'DELETE' && chat.private) {
        jobs.forgetPrivate(chat.id); return json(response, { deleted: chat.id });
      }
      if (!match[2] && request.method === 'DELETE') {
        if (jobs.running.has(chat.id)) throw fail('This chat is already working.', 409);
        if (body.confirmed !== true) throw fail('Confirm permanent deletion first.');
        store.deleteChat(chat.id); activityRevision++; return json(response, { deleted: chat.id });
      }
      if (chat.archived) throw fail('Restore this archived chat before changing settings, sending messages, or compacting it.', 409);
      if (!match[2] && request.method === 'PATCH') {
        if (jobs.running.has(chat.id)) throw fail('This chat is already working.', 409);
        if (typeof body.model !== 'string' || typeof body.effort !== 'string') throw fail('Choose a model and effort.');
        if (body.fast !== undefined && typeof body.fast !== 'boolean') throw fail('Fast mode must be on or off.');
        const selected = resolveModel(await models(), body.model);
        if (body.effort !== 'default' && !selected.efforts.includes(body.effort)) throw fail('Choose a supported effort.');
        chat = scopedChat(match[1]); if (!chat) throw fail('Chat not found.', 404);
        if (chat.archived || jobs.running.has(chat.id)) throw fail('This chat is archived or working.', 409);
        commitChat(chat, { model: body.model, effort: body.effort, ...(body.fast !== undefined ? { fast: body.fast } : {}) });
        return json(response, chatView(chat));
      }
      if (match[2] && request.method === 'POST') {
        if (body.chat) throw fail('Conversation context is owned by the backend. Reload the page.');
        const record = startCommand(chat, { ...body, kind: match[2] === '/compact' ? 'compaction' : body.kind ?? 'reply' });
        if (match[2] === '/operations' || request.headers.accept === 'application/json')
          return json(response, { operation: operationView(record), chat: chatView(chat) }, 202);
        // Compatibility stream: observing an operation, never owning it.
        observe(record, chat, response, true); return;
      }
      throw fail('Method not allowed.', 405);
    } catch (error) {
      if (!response.headersSent) json(response, { error: error.message }, error.status ?? 400);
      else response.end();
    } finally {
      activeRequests--;
      maybeClose();
    }
  });
  server.once('close', () => { serverClosed = true; maybeClose(); });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    // A duplicate startup that cannot claim this port must not interrupt the
    // operations still owned by the existing backend.
    store.recoverOperations();
  } catch (error) {
    storeClosed = true; jobs.dispose(); store.close(); server.close(); throw error;
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, jobs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 43187);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
  const { server, origin } = await createHarness({ port });
  console.log(`Basic Harness: ${origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
