import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { createHarness } from '../server.mjs';
import { ChatOperations } from '../lib/chat-operations.mjs';
import { createPrivateChats } from '../public/private-chats.js';

const secret = 'PRIVATE_BACKEND_FIXTURE_62748';
const complete = checkpoint => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
  ...(checkpoint ? [{ type: 'compaction', encrypted_content: secret + '_checkpoint' }] : []),
  { type: 'reasoning', encrypted_content: secret + '_reasoning' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: secret }] },
] } })}\n\n`);
const dump = store => JSON.stringify(store.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
  .map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));

const modelCatalog = () => Response.json({ models: [{ slug: 'fixture-model', supported_reasoning_efforts: ['high'], max_context_window: 20000 }] });

async function fixture(t, respond = () => complete(false), loadModels = modelCatalog) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-private-backend-')), store = new Store(directory), sent = [];
  store.createFolder({ id: 'parent', name: 'Parent', parentId: null }); store.createFolder({ id: 'child', name: 'Child', parentId: 'parent' });
  store.saveAgentsMd(null, 'GLOBAL_RULE', 0); store.saveAgentsMd('parent', 'PARENT_RULE', 0); store.saveAgentsMd('child', 'DIRECT_RULE', 0);
  const app = await createHarness({ directory, auth: { status: () => ({ connected: true, sharing: true }), accessToken: async () => 'fixture-token' },
    fetcher: async (url, options) => {
      if (url.endsWith('/models')) return loadModels();
      sent.push(JSON.parse(options.body)); return respond(sent.at(-1), options);
    } });
  t.after(async () => { await app.jobs.idle(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const page = await fetch(app.origin); await page.text();
  const headers = { Cookie: page.headers.get('set-cookie').split(';')[0], Origin: app.origin, 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body, extra = {}) => fetch(app.origin + path, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const created = await (await call('/api/private/chats', 'POST', { folderId: 'child' })).json();
  const path = `/api/private/chats/${created.chat.id}`, token = { 'X-Private-Chat-Token': created.token };
  const scoped = (suffix = '', method = 'GET', body) => call(path + suffix, method, body, token);
  const start = async (kind = 'reply') => {
    const result = await scoped('/operations', 'POST', { kind, text: secret, model: 'fixture-model', effort: 'high', fast: false });
    assert.equal(result.status, 202); return result.json();
  };
  return { app, store, directory, sent, call, scoped, start, created, path, token, headers };
}

test('backend-private conversations keep context, reasoning and metadata only in RAM across replies and compaction', async t => {
  const f = await fixture(t, () => complete(true)), before = dump(f.store);
  const accepted = await f.start(); await f.app.jobs.idle();
  let chat = await (await f.scoped()).json();
  assert.equal(chat.private, true); assert.equal(chat.messages[1].text, secret);
  assert.equal(chat.privateState, undefined); assert.equal(chat.input, undefined);
  assert.ok(f.sent[0].instructions.includes('GLOBAL_RULE')); assert.ok(f.sent[0].instructions.includes('DIRECT_RULE'));
  assert.ok(!f.sent[0].instructions.includes('PARENT_RULE')); assert.equal(f.sent[0].store, false);
  assert.ok(f.app.jobs.privateChat(chat.id, f.created.token).input.some(item => item.type === 'compaction'));
  await f.start('compaction'); await f.app.jobs.idle();
  chat = await (await f.scoped()).json(); assert.equal(chat.compactionCount, 2); assert.equal(chat.messages.length, 2);
  const metadata = await (await f.scoped('/messages/1/metadata')).json(); assert.equal(metadata.metadata.operation_id, accepted.operation.id);
  assert.equal(dump(f.store), before);
  for (const file of readdirSync(f.directory)) assert.equal(readFileSync(join(f.directory, file)).includes(Buffer.from(secret)), false, file);
});

test('private capabilities protect active work from every shared chat, metadata and operation lookup', async t => {
  let release, signal;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (_request, options) => { signal = options.signal; await held; return complete(false); });
  try {
    const accepted = await f.start();
    assert.equal((await f.call(f.path)).status, 404);
    assert.equal((await f.call(f.path, 'GET', undefined, { 'X-Private-Chat-Token': 'a'.repeat(64) })).status, 404);
    assert.equal((await f.call(`/api/chats/${f.created.chat.id}`)).status, 404);
    assert.equal((await f.call(`/api/chats/${f.created.chat.id}/messages/0/metadata`)).status, 404);
    assert.equal((await f.call(`/api/chats/${f.created.chat.id}/operations/${accepted.operation.id}`)).status, 404);
    assert.equal((await (await f.call('/api/state')).json()).chats.length, 0);
    assert.equal((await (await f.call('/api/activity')).json()).chats.length, 0);
    assert.equal(signal.aborted, false);
  } finally { release(); await f.app.jobs.idle(); }
});

test('explicit private close discards access while an accepted operation finishes independently', async t => {
  let release, signal;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (_request, options) => { signal = options.signal; await held; return complete(false); });
  try {
    await f.start(); assert.equal((await f.scoped('', 'DELETE', {})).status, 200);
    assert.equal(signal.aborted, false); assert.equal((await f.scoped()).status, 404);
  } finally { release(); await f.app.jobs.idle(); }
  assert.equal(f.sent.length, 1); assert.equal(f.app.jobs.privateOperations.size, 0); assert.equal(f.store.listChats().length, 0);
});

test('private ownership, fixed folder and validation remain on the backend', async t => {
  const f = await fixture(t);
  assert.equal((await f.scoped('/messages', 'POST', { chat: { input: [] }, text: secret })).status, 400);
  assert.equal((await f.scoped('/organization', 'PATCH', { title: 'Renamed', folderId: 'parent' })).status, 400);
  assert.equal((await f.scoped('/organization', 'PATCH', { archived: true })).status, 400);
  assert.equal((await f.scoped('/organization', 'PATCH', { title: 'Renamed in RAM' })).status, 200);
  await f.start(); await f.app.jobs.idle();
  assert.equal((await (await f.scoped()).json()).title, 'Renamed in RAM');
  assert.equal((await f.call('/api/chats', 'POST', { private: true })).status, 400);
  assert.throws(() => f.store.createChat({ id: 'private', private: true, messages: [], input: [] }), /cannot be persisted/);
  assert.equal(f.store.listChats().length, 0);
});

test('private chats expire after five idle minutes, while active work gets a fresh idle period on completion', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-private-expiry-')), store = new Store(directory);
  let now = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const jobs = new ChatOperations({ store, now: () => now, execute: async () => { await held; return {}; } });
  t.after(async () => { release(); await jobs.idle(); jobs.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = jobs.createPrivate(null); now = 5 * 60 * 1000 - 1; jobs.reap(); assert.ok(jobs.privateChats.has(first.chat.id));
  now++; jobs.reap(); assert.equal(jobs.privateChat(first.chat.id, first.token), null);
  const active = jobs.createPrivate(null);
  jobs.start({ chat: active.chat, kind: 'reply', requestId: 'fixture', commandHash: 'fixture', request: { model: 'test', effort: 'default', fast: false, text: secret } });
  now += 10 * 60 * 1000; jobs.reap(); assert.ok(jobs.privateChat(active.chat.id, active.token));
  release(); await jobs.idle(); now += 5 * 60 * 1000 - 1; jobs.reap(); assert.ok(jobs.privateChats.has(active.chat.id));
  now++; jobs.reap(); assert.equal(jobs.privateChat(active.chat.id, active.token), null);
});

test('private browser client sends commands to backend and forgetting the page sends no cancellation or deletion', async () => {
  const sent = [], view = { id: 'private-fixture', private: true, title: 'Private chat', messages: [] };
  const client = createPrivateChats({ fetcher: async (path, options) => {
    sent.push({ path, options });
    return Response.json(path === '/api/private/chats' ? { chat: view, token: 'capability' } : view, { status: path === '/api/private/chats' ? 201 : 200 });
  } });
  const chat = await client.create('child'); assert.equal(chat.id, view.id);
  await client.api(`/api/chats/${chat.id}`, 'PATCH', { model: 'test', effort: 'default' });
  assert.equal(sent[1].path, `/api/private/chats/${chat.id}`); assert.equal(sent[1].options.headers['X-Private-Chat-Token'], 'capability');
  const count = sent.length; client.clear(); assert.equal(sent.length, count); assert.equal(client.list().length, 0);
  assert.equal(createPrivateChats().list().length, 0);
});

test('a private command still uploading must be rejected if its capability is closed or expires before acceptance', async t => {
  for (const mode of ['closed', 'expired']) await t.test(mode, async t => {
    const f = await fixture(t); let now = 0;
    f.app.jobs.now = () => now; await f.scoped();
    const body = JSON.stringify({ requestId: 'late-upload', kind: 'reply', text: secret, model: 'fixture-model', effort: 'high', fast: false });
    const received = new Promise(resolve => f.app.server.once('request', resolve));
    let upload;
    const finished = new Promise((resolve, reject) => {
      upload = httpRequest(f.app.origin + f.path + '/operations', { method: 'POST', headers: { ...f.headers, ...f.token } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      upload.on('error', reject); upload.write(body.slice(0, 1));
    });
    try {
      await received;
      if (mode === 'closed') assert.equal((await f.scoped('', 'DELETE', {})).status, 200);
      else now = 5 * 60 * 1000;
      upload.end(body.slice(1));
      assert.equal(await finished, 404);
      await f.app.jobs.idle();
      assert.equal(f.sent.length, 0); assert.equal(f.app.jobs.privateOperations.size, 0);
    } finally { upload.destroy(); }
  });
});

test('private settings revalidate their capability after waiting for the model catalog', async t => {
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const fetching = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, undefined, async () => { started(); await held; return modelCatalog(); });
  try {
    const pending = f.scoped('', 'PATCH', { model: 'fixture-model', effort: 'high', fast: true });
    await fetching;
    assert.equal((await f.scoped('', 'DELETE', {})).status, 200);
    release(); assert.equal((await pending).status, 404);
    assert.equal(f.sent.length, 0); assert.equal((await f.scoped()).status, 404);
  } finally { release(); }
});
