import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ChatGPTAuth } from './lib/auth.mjs';
import { Store } from './lib/store.mjs';
import { normalizeModels, resolveModel, responseText, streamReply } from './lib/responses.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/account-sync.js', ['account-sync.js', 'text/javascript']],
]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
};
const view = chat => ({ id: chat.id, title: chat.title, model: chat.model, effort: chat.effort, fast: chat.fast === true, messages: chat.messages });

async function readJSON(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw fail('Expected JSON.', 415);
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 128 * 1024) throw fail('Message is too large.', 413);
  }
  try { return JSON.parse(data); } catch { throw fail('Invalid JSON.'); }
}

export async function createHarness({ port = 0, directory = join(root, '.data'), auth, fetcher = fetch } = {}) {
  const store = new Store(directory);
  auth ??= new ChatGPTAuth(store);
  const chats = store.read('chats.json', []);
  const cookie = `harness_session=${randomBytes(32).toString('hex')}`;
  let origin, catalog = [], catalogAt = 0;
  const running = new Set();
  const persist = () => store.write('chats.json', chats);

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

      if (url.pathname === '/api/state' && request.method === 'GET') return json(response, { auth: auth.status(), chats: chats.map(view) });
      if (url.pathname === '/api/account' && request.method === 'GET') return json(response, auth.status());
      if (url.pathname === '/api/models' && request.method === 'GET') return json(response, { models: await models() });
      if (url.pathname === '/api/login' && request.method === 'POST') {
        if (running.size) throw fail('Wait for the reply to finish first.', 409);
        return json(response, { url: await auth.begin(origin) });
      }
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        if (running.size) throw fail('Wait for the reply to finish first.', 409);
        const result = await auth.logout(); catalog = []; catalogAt = 0;
        return json(response, result);
      }
      if (url.pathname === '/api/chats' && request.method === 'POST') {
        const chat = { id: randomUUID(), title: 'New chat', model: '', effort: 'default', fast: false, messages: [], input: [] };
        chats.unshift(chat); persist(); return json(response, view(chat), 201);
      }
      const match = url.pathname.match(/^\/api\/chats\/([\w-]+)(\/messages)?$/);
      if (!match) throw fail('Not found.', 404);
      const chat = chats.find(item => item.id === match[1]);
      if (!chat) throw fail('Chat not found.', 404);
      if (running.has(chat.id)) throw fail('This chat is already generating a reply.', 409);
      const body = await readJSON(request);
      if (!body || typeof body !== 'object') throw fail('Expected a JSON object.');
      if (running.has(chat.id)) throw fail('This chat is already generating a reply.', 409);
      if (!match[2] && request.method === 'PATCH') {
        if (typeof body.model !== 'string' || typeof body.effort !== 'string') throw fail('Choose a model and effort.');
        if (body.fast !== undefined && typeof body.fast !== 'boolean') throw fail('Fast mode must be on or off.');
        const selected = resolveModel(await models(), body.model);
        if (body.effort !== 'default' && !selected.efforts.includes(body.effort)) throw fail('Choose a supported effort.');
        if (running.has(chat.id)) throw fail('This chat is already generating a reply.', 409);
        chat.model = body.model; chat.effort = body.effort;
        if (body.fast !== undefined) chat.fast = body.fast;
        persist();
        return json(response, view(chat));
      }
      if (match[2] && request.method === 'POST') {
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 32000) throw fail('Enter a message of up to 32,000 characters.');
        // Acquire the chat lock before any network await.
        running.add(chat.id);
        const controller = new AbortController();
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        const emit = event => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
        try {
          const selected = resolveModel(await models(), chat.model);
          if (chat.effort !== 'default' && !selected.efforts.includes(chat.effort)) throw fail('Choose a supported effort.');
          const token = await auth.accessToken();
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
          response.flushHeaders();
          const user = { role: 'user', content: body.text.trim() };
          const output = await streamReply({
            fetcher, token, model: chat.model, effort: chat.effort, fast: chat.fast === true,
            input: [...chat.input, user], signal: controller.signal, onDelta: text => emit({ type: 'delta', text }),
            onServiceTier: tier => {
              if (chat.fast === true && tier === 'default') emit({ type: 'notice', message: 'Fast mode was requested, but OpenAI used Standard processing for this reply.' });
            },
          });
          if (controller.signal.aborted) return;
          const text = responseText(output);
          chat.input.push(user, ...output); // Replay full output, including opaque reasoning, on the next request.
          chat.messages.push({ role: 'user', text: user.content }, { role: 'assistant', text });
          if (chat.messages.length === 2) chat.title = user.content.replace(/\s+/g, ' ').slice(0, 60);
          persist(); emit({ type: 'done', chat: view(chat) }); response.end();
        } catch (error) {
          if (response.headersSent) { emit({ type: 'error', message: error.message }); response.end(); }
          else throw error;
        } finally { running.delete(chat.id); }
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
