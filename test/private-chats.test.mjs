import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { createHarness } from '../server.mjs';
import { createPrivateChats } from '../public/private-chats.js';
import { readableMessageMetadata } from '../lib/message-metadata.mjs';

const secret = 'PRIVATE_FIXTURE_CONTENT_4893';
const output = checkpoint => [
  ...(checkpoint ? [{ type: 'compaction', encrypted_content: `${secret}_checkpoint` }] : []),
  { type: 'reasoning', encrypted_content: `${secret}_reasoning` },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${secret}_reply` }] },
];
const response = checkpoint => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
  id: 'fixture-response', status: 'completed', model: 'fixture-model', output: output(checkpoint),
  usage: { input_tokens: 400, output_tokens: 20, total_tokens: 420 },
} })}\n\n`);
const seed = () => ({ id: 'private-fixture', model: 'fixture-model', effort: 'high', folderId: 'child', messages: [], input: [], compactions: [] });
const dump = store => JSON.stringify(store.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
  .map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));

async function fixture(t, respond = () => response(false)) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-private-test-'));
  const store = new Store(directory);
  store.createFolder({ id: 'parent', parentId: null, name: 'Parent' });
  store.createFolder({ id: 'child', parentId: 'parent', name: 'Child' });
  store.saveAgentsMd(null, 'GLOBAL_RULE', 0); store.saveAgentsMd('parent', 'PARENT_RULE', 0); store.saveAgentsMd('child', 'DIRECT_RULE', 0);
  const sent = [];
  const app = await createHarness({ directory,
    auth: { status: () => ({ connected: true, sharing: true }), accessToken: async () => 'fixture-token' },
    fetcher: async (url, options) => {
      if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', supported_reasoning_efforts: ['high'], max_context_window: 20000 }] });
      sent.push(JSON.parse(options.body)); return respond(sent.at(-1), options);
    },
  });
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const page = await fetch(app.origin); await page.text();
  const headers = { Cookie: page.headers.get('set-cookie').split(';')[0], Origin: app.origin, 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body) => fetch(app.origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const turn = async (chat, compact = false) => {
    const result = await call(`/api/private/chats/${chat.id}/${compact ? 'compact' : 'messages'}`, 'POST', { chat, text: secret });
    assert.equal(result.status, 200);
    return (await result.text()).trim().split('\n').map(JSON.parse);
  };
  return { app, store, directory, sent, headers, call, turn };
}

test('private replies, reasoning, metadata and compactions never write to any SQLite table or file', async t => {
  const f = await fixture(t, () => response(true)), before = dump(f.store);
  let chat = { ...seed(), title: 'Temporary research' };
  const done = (await f.turn(chat)).at(-1);
  assert.equal(done.type, 'done'); assert.equal(done.chat.private, true); assert.equal(done.chat.title, 'Temporary research');
  assert.ok(done.chat.privateState.input.some(item => item.type === 'compaction'));
  assert.equal(done.chat.messages[1].text, `${secret}_reply`);
  assert.ok(f.sent[0].instructions.includes('GLOBAL_RULE')); assert.ok(f.sent[0].instructions.includes('DIRECT_RULE'));
  assert.ok(!f.sent[0].instructions.includes('PARENT_RULE')); assert.equal(f.sent[0].store, false);
  chat = { ...chat, ...done.chat, ...done.chat.privateState };
  assert.equal((await f.turn(chat, true)).at(-1).chat.compactionCount, 2);
  assert.equal(dump(f.store), before);
  assert.equal((await (await f.call('/api/state')).json()).chats.length, 0);
  assert.equal((await f.call('/api/chats/private-fixture/messages/1/metadata')).status, 404);
  for (const file of readdirSync(f.directory)) assert.equal(readFileSync(join(f.directory, file)).includes(Buffer.from(secret)), false, file);
  const reopened = new Store(f.directory);
  try { assert.equal(reopened.getChat(chat.id), null); } finally { reopened.close(); }
});

test('private failures and active turns never enter persistent or shared chat lookups', async t => {
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async () => { started(); await held; return new Response('Fixture failed', { status: 500 }); });
  const before = dump(f.store), pending = f.turn(seed()); await ready;
  assert.equal((await (await f.call('/api/activity')).json()).chats.length, 0);
  assert.equal((await f.call('/api/chats/private-fixture/messages/0/metadata')).status, 404);
  release(); assert.equal((await pending).at(-1).type, 'error');
  assert.equal(dump(f.store), before);
});

test('private endpoint validates context, session, origin and size; ordinary creation cannot accidentally save private chats', async t => {
  const f = await fixture(t), path = '/api/private/chats/private-fixture/messages';
  for (const chat of [null, {}, { ...seed(), id: 'other' }, { ...seed(), input: null }, { ...seed(), messages: [{}] }])
    assert.equal((await f.call(path, 'POST', { chat, text: secret })).status, 400);
  assert.equal((await f.call(path, 'POST', { chat: { ...seed(), folderId: 'missing' }, text: secret })).status, 404);
  assert.equal((await f.call(path)).status, 405);
  assert.equal((await fetch(f.app.origin + path, { method: 'POST', headers: { ...f.headers, Cookie: '' }, body: '{}' })).status, 403);
  assert.equal((await fetch(f.app.origin + path, { method: 'POST', headers: { ...f.headers, Origin: 'https://other.example' }, body: '{}' })).status, 403);
  assert.equal((await f.call('/api/chats', 'POST', { private: true })).status, 400);
  assert.throws(() => f.store.createChat({ ...seed(), private: true }), /cannot be persisted/);
  assert.equal(f.sent.length, 0); assert.equal(f.store.listChats().length, 0);
});

test('private replay can exceed ordinary message request size without persisting and retains encrypted context', async t => {
  const f = await fixture(t), chat = seed();
  chat.input = [{ type: 'reasoning', encrypted_content: 'x'.repeat(200000) }];
  assert.equal((await f.turn(chat)).at(-1).type, 'done');
  assert.equal(f.sent[0].input[0].encrypted_content.length, 200000);
  assert.equal(f.store.listChats().length, 0);
});

test('disconnecting a private turn aborts provider work without saving partial results or diagnostics', async t => {
  let started, cancelled;
  const ready = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { cancelled = resolve; });
  const f = await fixture(t, async (_request, { signal }) => {
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    cancelled(); throw new Error('Private request cancelled');
  });
  const before = dump(f.store), controller = new AbortController();
  const pending = fetch(f.app.origin + '/api/private/chats/private-fixture/messages', {
    method: 'POST', headers: f.headers, signal: controller.signal, body: JSON.stringify({ chat: seed(), text: secret }),
  }).then(result => result.text());
  const rejected = assert.rejects(pending, /abort/i);
  await ready; controller.abort(); await rejected; await stopped;
  assert.equal(dump(f.store), before);
});

test('client private storage is tab-local, closes without network, preserves metadata, and sends only active replay context', async () => {
  const sent = [], f = createPrivateChats({ metadata: readableMessageMetadata, uuid: () => 'fixture', fetcher: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return response(false); } });
  const created = f.create('child'), path = `/api/chats/${created.id}`;
  const settings = await f.api(path, 'PATCH', { model: 'fixture-model', effort: 'high', fast: true });
  assert.equal(settings.private, true); assert.equal(sent.length, 0);
  const renamed = await f.api(`${path}/organization`, 'PATCH', { title: 'Temporary research' });
  assert.equal(renamed.title, 'Temporary research'); assert.equal(sent.length, 0);
  const first = { ...settings, messages: [{ role: 'assistant', text: secret }], privateState: {
    input: [{ type: 'reasoning', encrypted_content: 'opaque' }], messages: [{ role: 'assistant', text: secret, metadata: { request: { instructions: 'OLD_RULE' } } }],
    compactions: [{ mode: 'manual', after_message_count: 0, previous_input: ['old-context'], metadata: { events: ['archive'] } }],
  } };
  f.accept(first); f.accept({ ...first, privateState: { ...first.privateState, messages: [{ role: 'assistant', text: secret }] } });
  assert.equal((await f.api(`${path}/messages/0/metadata`)).metadata.request.instructions, 'OLD_RULE');
  await f.request(created.id, 'messages', { text: 'Continue' });
  assert.equal(sent[0].url, `/api/private/chats/${created.id}/messages`);
  assert.equal(JSON.stringify(sent[0].body).includes('OLD_RULE'), false);
  assert.equal(JSON.stringify(sent[0].body).includes('old-context'), false);
  assert.equal(sent[0].body.chat.input[0].encrypted_content, 'opaque');
  await assert.rejects(f.api(`${path}/organization`, 'PATCH', { archived: true }), /cannot be archived/);
  assert.equal(createPrivateChats().list().length, 0);
  assert.equal(f.close(created.id), true); assert.equal(f.list().length, 0); assert.equal(sent.length, 1);
  assert.throws(() => f.accept(first), /closed/);
});

test('closing or clearing browser-private state aborts its active requests and cannot affect a saved chat', async () => {
  const signals = [];
  const f = createPrivateChats({ uuid: () => 'fixture', fetcher: async (_url, options) => { signals.push(options.signal); return response(false); } });
  const chat = f.create();
  await f.request(chat.id, 'messages', { text: secret });
  assert.equal(signals[0].aborted, false);
  f.close(chat.id); assert.equal(signals[0].aborted, true);
  const second = f.create();
  await f.request(second.id, 'messages', { text: secret });
  f.clear(); assert.equal(signals[1].aborted, true); assert.equal(f.list().length, 0);
  await f.request('saved-example', 'messages', { text: 'Ordinary message' });
  assert.equal(signals[2], undefined);
});

test('private chat creation works on plain HTTP where crypto.randomUUID is unavailable', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));
  const chat = createPrivateChats().create();
  assert.match(chat.id, /^private-[0-9a-f]{32}$/);
});
