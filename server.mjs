import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ChatGPTAuth } from './lib/auth.mjs';
import { Store } from './lib/store.mjs';
import { normalizeModels, resolveModel, responseText, streamReply, latestUsage, autoCompactThreshold, compactedInput } from './lib/responses.mjs';
import { readableMessageMetadata } from './lib/message-metadata.mjs';
import { itemName, folderParent } from './lib/folders.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/account-sync.js', ['account-sync.js', 'text/javascript']],
  ['/compaction-sync.js', ['compaction-sync.js', 'text/javascript']],
  ['/composer.js', ['composer.js', 'text/javascript']],
  ['/activity.js', ['activity.js', 'text/javascript']],
  ['/folders.js', ['folders.js', 'text/javascript']],
  ['/message-info.js', ['message-info.js', 'text/javascript']],
  ['/theme.js', ['theme.js', 'text/javascript']],
]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
};
// Keep the ordinary UI payload small; full metadata stays in protected storage.
const organizationView = chat => ({ id: chat.id, title: chat.title, folderId: chat.folderId ?? null, organizationVersion: chat.organizationVersion ?? 0 });
const view = chat => ({ ...organizationView(chat), model: chat.model, effort: chat.effort, fast: chat.fast === true,
  contextUsage: chat.contextUsageSource === 'compaction' ? chat.contextUsage : latestUsage(chat.messages),
  contextUsageSource: chat.contextUsageSource === 'compaction' ? 'compaction' : 'reply',
  compactionCount: chat.compactions?.length ?? 0,
  messages: chat.messages.map(({ role, text }) => ({ role, text })) });

export async function readJSON(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw fail('Expected JSON.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw fail('Message is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON.'); }
}

export async function createHarness({ port = 0, directory = join(root, '.data'), auth, fetcher = fetch } = {}) {
  const store = new Store(directory);
  auth ??= new ChatGPTAuth(store);
  const chats = store.read('chats.json', []);
  const folders = store.read('folders.json', []);
  const cookie = `harness_session=${randomBytes(32).toString('hex')}`;
  let origin, catalog = [], catalogAt = 0;
  const running = new Map();
  let activityRevision = 0;
  const activity = () => ({ revision: activityRevision, chats: chats.map(chat => ({ id: chat.id, activity: running.get(chat.id) ?? null })) });
  const finishActivity = id => { if (running.delete(id)) activityRevision++; };
  const commitChat = (chat, changes) => {
    const updated = { ...chat, ...changes };
    store.write('chats.json', chats.map(item => item === chat ? updated : item));
    // Publish in-memory state only after the atomic disk write succeeds.
    Object.assign(chat, changes);
  };

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
      if (assets.has(url.pathname) && request.method === 'GET') {
        const [name, type] = assets.get(url.pathname);
        if (url.pathname === '/') response.setHeader('Set-Cookie', `${cookie}; HttpOnly; SameSite=Strict; Path=/`);
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return response.end(readFileSync(join(root, 'public', name)));
      }
      if (!request.headers.cookie?.split(';').map(value => value.trim()).includes(cookie)) throw fail('Open the app before making requests.', 403);
      if (request.headers.origin && request.headers.origin !== origin) throw fail('Cross-origin requests are not allowed.', 403);
      if (request.method !== 'GET' && request.headers.origin !== origin) throw fail('A same-origin request is required.', 403);

      if (url.pathname === '/api/state' && request.method === 'GET') return json(response, { auth: auth.status(), chats: chats.map(view), folders, activity: activity() });
      if (url.pathname === '/api/activity' && request.method === 'GET') return json(response, activity());
      if (url.pathname === '/api/account' && request.method === 'GET') return json(response, auth.status());
      if (url.pathname === '/api/models' && request.method === 'GET') return json(response, { models: await models() });
      const metadataMatch = url.pathname.match(/^\/api\/chats\/([\w-]+)\/messages\/(\d+)\/metadata$/);
      if (metadataMatch && request.method === 'GET') {
        const chat = chats.find(chat => chat.id === metadataMatch[1]);
        const index = Number(metadataMatch[2]);
        if (!chat || !Number.isSafeInteger(index)) throw fail('Message not found.', 404);
        const data = readableMessageMetadata(chat, index);
        if (!data) throw fail('Message not found.', 404);
        return json(response, data);
      }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        if (running.size) throw fail('Wait for the reply to finish first.', 409);
        return json(response, { url: await auth.begin(origin) });
      }
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        if (running.size) throw fail('Wait for the reply to finish first.', 409);
        const result = await auth.logout(); catalog = []; catalogAt = 0;
        return json(response, result);
      }
      if (url.pathname === '/api/folders' && request.method === 'POST') {
        const body = await readJSON(request);
        const folder = { id: randomUUID(), name: itemName(body?.name), parentId: folderParent(folders, body?.parentId ?? null) };
        store.write('folders.json', [...folders, folder]);
        folders.push(folder); return json(response, folder, 201);
      }
      const folderMatch = url.pathname.match(/^\/api\/folders\/([\w-]+)$/);
      if (folderMatch && request.method === 'PATCH') {
        const folder = folders.find(item => item.id === folderMatch[1]);
        if (!folder) throw fail('Folder not found.', 404);
        const body = await readJSON(request);
        if (!body || typeof body !== 'object' || !('name' in body)) throw fail('Provide a folder name.');
        if ('parentId' in body) throw fail('Existing folders cannot be moved.');
        const changes = { name: itemName(body.name) };
        store.write('folders.json', folders.map(item => item === folder ? { ...folder, ...changes } : item));
        Object.assign(folder, changes); return json(response, folder);
      }
      const organizationMatch = url.pathname.match(/^\/api\/chats\/([\w-]+)\/organization$/);
      if (organizationMatch && request.method === 'PATCH') {
        const chat = chats.find(item => item.id === organizationMatch[1]);
        if (!chat) throw fail('Chat not found.', 404);
        const body = await readJSON(request);
        if (!body || typeof body !== 'object' || (!('title' in body) && !('folderId' in body))) throw fail('Provide a name or folder.');
        // Organization is independent of generation settings and can change during a reply.
        commitChat(chat, { ...('title' in body ? { title: itemName(body.title), titleEdited: true } : {}),
          ...('folderId' in body ? { folderId: folderParent(folders, body.folderId) } : {}),
          organizationVersion: (chat.organizationVersion ?? 0) + 1 });
        return json(response, organizationView(chat));
      }
      if (url.pathname === '/api/chats' && request.method === 'POST') {
        const body = request.headers['transfer-encoding'] || Number(request.headers['content-length']) > 0 ? await readJSON(request) : {};
        const folderId = folderParent(folders, body?.folderId ?? null);
        const chat = { id: randomUUID(), folderId, title: 'New chat', model: '', effort: 'default', fast: false, messages: [], input: [] };
        store.write('chats.json', [chat, ...chats]);
        chats.unshift(chat); return json(response, view(chat), 201);
      }
      const match = url.pathname.match(/^\/api\/chats\/([\w-]+)(\/(?:messages|compact))?$/);
      if (!match) throw fail('Not found.', 404);
      const chat = chats.find(item => item.id === match[1]);
      if (!chat) throw fail('Chat not found.', 404);
      if (running.has(chat.id)) throw fail('This chat is already generating a reply.', 409);
      const body = await readJSON(request);
      if (!body || typeof body !== 'object') throw fail('Expected a JSON object.');
      if (running.has(chat.id)) throw fail('This chat is already generating a reply.', 409);
      const manual = match[2] === '/compact';
      if (!match[2] && request.method === 'PATCH') {
        if (typeof body.model !== 'string' || typeof body.effort !== 'string') throw fail('Choose a model and effort.');
        if (body.fast !== undefined && typeof body.fast !== 'boolean') throw fail('Fast mode must be on or off.');
        const selected = resolveModel(await models(), body.model);
        if (body.effort !== 'default' && !selected.efforts.includes(body.effort)) throw fail('Choose a supported effort.');
        if (running.has(chat.id)) throw fail('This chat is already generating a reply.', 409);
        commitChat(chat, { model: body.model, effort: body.effort, ...(body.fast !== undefined ? { fast: body.fast } : {}) });
        return json(response, view(chat));
      }
      if (match[2] && request.method === 'POST') {
        if (manual) {
          if (!chat.input.length) throw fail('Send a message before compacting this chat.');
        } else if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 32000) throw fail('Enter a message of up to 32,000 characters.');
        // Acquire the chat lock before any network await.
        running.set(chat.id, manual ? 'compacting' : 'replying'); activityRevision++;
        const controller = new AbortController();
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        const emit = event => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
        const user = manual ? null : { role: 'user', content: body.text.trim() };
        let metadata;
        const saveFailedAttempt = error => {
          if (!metadata) return;
          try { commitChat(chat, { failedAttempts: [...(chat.failedAttempts ?? []), { ...(manual ? { operation: 'compaction' } : { text: user.content }), error, metadata }] }); }
          catch (storageError) { return `Failed request diagnostics could not be saved: ${storageError.message}`; }
        };
        try {
          const selected = resolveModel(await models(), chat.model);
          if (chat.effort !== 'default' && !selected.efforts.includes(chat.effort)) throw fail('Choose a supported effort.');
          const token = await auth.accessToken();
          const threshold = manual ? 1000 : autoCompactThreshold(selected);
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
          response.flushHeaders();
          if (manual) emit({ type: 'status', message: 'Compacting context… This can take a few minutes.' });
          const input = manual ? chat.input : [...chat.input, user];
          const output = await streamReply({
            fetcher, token, model: chat.model, effort: chat.effort, fast: chat.fast === true,
            input, compactThreshold: threshold,
            // Avoid temporary instructions: OpenAI can carry them into the
            // encrypted checkpoint. Discard this request's generated reply.
            ...(manual ? { requireMessage: false } : {}),
            signal: controller.signal, onDelta: text => { if (!manual) emit({ type: 'delta', text }); },
            onCompaction: () => emit({ type: 'status', message: 'Compacted context received; finishing the request…' }),
            onServiceTier: tier => {
              if (chat.fast === true && tier === 'default') emit({ type: 'notice', message: 'Fast mode was requested, but OpenAI used Standard processing for this reply.' });
            },
            onMetadata: value => { metadata = value; },
          });
          if (controller.signal.aborted) { saveFailedAttempt(manual ? 'Compaction was cancelled.' : 'Reply was cancelled.'); return; }
          const checkpoint = output.findLast(item => item.type === 'compaction');
          const nextInput = compactedInput([...input, ...output]);
          if (manual && !checkpoint) throw fail('Nothing to compact: OpenAI requires at least 1,000 context tokens, or this model did not return a compaction. History was not changed.');
          const compactions = checkpoint ? [...(chat.compactions ?? []), {
            mode: manual ? 'manual' : 'automatic', model: chat.model, threshold,
            completed_at: metadata.finished_at, response_id: metadata.response?.id,
            previous_input: chat.input, // Archive superseded opaque state as well as visible messages.
            ...(manual ? { metadata } : {}), // Automatic metadata is already saved with the reply.
          }] : chat.compactions;
          const text = responseText(output);
          commitChat(chat, manual ? {
            // The maintenance generation and its reasoning are not chat turns.
            input: [checkpoint], compactions,
            contextUsage: latestUsage([{ role: 'assistant', metadata }]), contextUsageSource: 'compaction',
          } : {
            input: nextInput, // Keep the latest checkpoint and everything after it.
            compactions, contextUsage: null, contextUsageSource: 'reply',
            messages: [...chat.messages, {
              role: 'user', text: user.content, metadata: { sent_at: metadata.started_at, request: metadata.request },
            }, { role: 'assistant', text, metadata }],
            title: chat.messages.length === 0 && !chat.titleEdited ? user.content.replace(/\s+/g, ' ').slice(0, 60) : chat.title,
          });
          if (checkpoint) emit({ type: 'status', message: `${manual ? 'Context compacted' : 'Context automatically compacted'}. Chat history is preserved.` });
          finishActivity(chat.id);
          emit({ type: 'done', chat: view(chat) }); response.end();
        } catch (error) {
          const diagnosticError = saveFailedAttempt(error.message);
          if (response.headersSent) { emit({ type: 'error', message: error.message + (diagnosticError ? ` (${diagnosticError})` : '') }); response.end(); }
          else throw error;
        } finally { finishActivity(chat.id); }
        return;
      }
      throw fail('Method not allowed.', 405);
    } catch (error) {
      if (!response.headersSent) json(response, { error: error.message }, error.status ?? 400);
      else response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 43187);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
  const { server, origin } = await createHarness({ port });
  console.log(`Basic Harness: ${origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
