import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Store } from '../lib/store.mjs';
import { createHarness } from '../server.mjs';
import { mergeChat, mergeOrganization, visibleChats } from '../public/folders.js';

const reply = () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply' }] },
] } })}\n\n`);

async function fixture(t, respond = reply, beforeModels = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-lifecycle-'));
  const store = new Store(directory);
  store.createFolder({ id: 'folder', name: 'Keep folder', parentId: null });
  store.setState('host', { id: 'keep-host' });
  const chat = { id: 'chat', title: 'Keep history', folderId: 'folder', model: 'gpt-6.1-sol', effort: 'high',
    messages: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hello', metadata: { events: [{ type: 'test' }] } }],
    input: [{ role: 'user', content: 'Hello' }, { type: 'reasoning', encrypted_content: 'secret-context' }],
    compactions: [{ mode: 'manual', after_message_count: 2, previous_input: [{ role: 'user', content: 'earlier' }] }],
    failedAttempts: [{ error: 'test failure' }] };
  store.createChat(chat);
  store.createChat({ ...chat, id: 'other', title: 'Unrelated' });
  const auth = { status: () => ({ connected: false }), accessToken: async () => 'fixture-token' };
  const fetcher = async (url, options) => {
    if (!url.endsWith('/models')) return respond(JSON.parse(options.body));
    await beforeModels();
    return Response.json({ models: [{ slug: 'gpt-6.1-sol', supported_reasoning_efforts: ['high'], max_context_window: 872000 }] });
  };
  const app = await createHarness({ directory, auth, fetcher });
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const page = await fetch(app.origin); await page.text();
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body) => fetch(app.origin + path, { method, headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { store, app, call, headers, directory };
}

test('archive and restore preserve every collection and folder across reopen, with no schema migration', async t => {
  const f = await fixture(t);
  const before = f.store.getChat('chat');
  assert.equal((await (await f.call('/api/state')).json()).chats.find(chat => chat.id === 'chat').archived, false);
  const archived = await (await f.call('/api/chats/chat/organization', 'PATCH', { archived: true })).json();
  assert.equal(archived.archived, true); assert.equal(archived.organizationVersion, 1);
  assert.deepEqual(f.store.getChat('chat'), { ...before, archived: true, organizationVersion: 1 });
  const reopened = new Store(f.directory);
  try { assert.equal(reopened.getChat('chat').archived, true); }
  finally { reopened.close(); }
  for (const [path, method, body] of [
    ['/api/chats/chat/messages', 'POST', { text: 'Blocked' }],
    ['/api/chats/chat/compact', 'POST', {}],
    ['/api/chats/chat', 'PATCH', { model: 'gpt-6.1-sol', effort: 'high' }],
  ]) assert.equal((await f.call(path, method, body)).status, 409);
  assert.equal((await f.call('/api/chats/chat/messages/1/metadata')).status, 200);
  const restored = await (await f.call('/api/chats/chat/organization', 'PATCH', { archived: false })).json();
  assert.equal(restored.archived, false); assert.equal(restored.folderId, 'folder');
  assert.deepEqual(f.store.getChat('chat'), { ...before, archived: false, organizationVersion: 2 });
  assert.equal((await f.call('/api/chats/chat/messages', 'POST', { text: 'Continue' })).status, 200);
});

test('permanent deletion requires explicit confirmation and cascades through all stored chat data only', async t => {
  const f = await fixture(t);
  const other = f.store.getChat('other');
  for (const body of [{}, { confirmed: false }, { confirmed: 'true' }])
    assert.equal((await f.call('/api/chats/chat', 'DELETE', body)).status, 400);
  assert.equal((await fetch(f.app.origin + '/api/chats/chat', { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(f.app.origin + '/api/chats/chat', { method: 'DELETE', headers: { ...f.headers, Origin: 'https://other.example' }, body: '{"confirmed":true}' })).status, 403);
  await f.call('/api/chats/chat/organization', 'PATCH', { archived: true });
  assert.deepEqual(await (await f.call('/api/chats/chat', 'DELETE', { confirmed: true })).json(), { deleted: 'chat' });
  for (const table of ['chats', 'chat_items', 'chat_payloads']) {
    const column = table === 'chats' ? 'id' : 'chat_id';
    assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get('chat').n, 0);
  }
  assert.equal(f.store.getChat('chat'), null);
  assert.deepEqual(f.store.getChat('other'), other);
  assert.equal(f.store.listFolders()[0].id, 'folder'); assert.equal(f.store.getState('host').id, 'keep-host');
  assert.equal((await f.call('/api/chats/chat/messages/1/metadata')).status, 404);
  assert.equal((await f.call('/api/chats/chat', 'DELETE', { confirmed: true })).status, 404);
  const reopened = new Store(f.directory);
  try { assert.equal(reopened.getChat('chat'), null); assert.equal(reopened.listChats().length, 1); }
  finally { reopened.close(); }
});

test('a failed cascading delete rolls back the entire chat and all collections', async t => {
  const f = await fixture(t), before = f.store.getChat('chat');
  f.store.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON chat_payloads BEGIN SELECT RAISE(ABORT, 'Synthetic delete failure'); END;");
  assert.equal((await f.call('/api/chats/chat', 'DELETE', { confirmed: true })).status, 400);
  assert.deepEqual(f.store.getChat('chat'), before);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('working chats cannot be archived, restored or deleted, and completion does not lose their history', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => { started(); await held; return reply(); });
  const stream = await f.call('/api/chats/chat/messages', 'POST', { text: 'Work' });
  await ready;
  try {
    for (const archived of [true, false]) assert.equal((await f.call('/api/chats/chat/organization', 'PATCH', { archived })).status, 409);
    assert.equal((await f.call('/api/chats/chat', 'DELETE', { confirmed: true })).status, 409);
    assert.equal((await f.call('/api/chats/other/organization', 'PATCH', { archived: true })).status, 200);
  } finally { release(); }
  const events = (await stream.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).chat.messages.length, 4);
  assert.equal(f.store.getChat('chat').archived, undefined);
});

async function delayed(f, path, method, body) {
  const text = JSON.stringify(body);
  let req, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.app.server.once('request', started);
  const result = new Promise((resolve, reject) => {
    req = request(f.app.origin + path, { method, headers: { ...f.headers, 'Content-Length': Buffer.byteLength(text) } }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', part => { data += part; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      response.on('error', reject);
    });
    req.on('error', reject); req.write(text.slice(0, 1));
  });
  await ready;
  return { finish: () => { req.end(text.slice(1)); return result; } };
}

test('delayed request bodies recheck deletion and archive state before mutating or generating', async t => {
  const f = await fixture(t);
  const generation = await delayed(f, '/api/chats/chat/messages', 'POST', { text: 'Too late' });
  await f.call('/api/chats/chat/organization', 'PATCH', { archived: true });
  assert.equal((await generation.finish()).status, 409);
  const settings = await delayed(f, '/api/chats/chat', 'PATCH', { model: 'gpt-6.1-sol', effort: 'high' });
  const rename = await delayed(f, '/api/chats/chat/organization', 'PATCH', { title: 'Too late' });
  await f.call('/api/chats/chat', 'DELETE', { confirmed: true });
  assert.equal((await settings.finish()).status, 404); assert.equal((await rename.finish()).status, 404);
  assert.equal(f.store.getChat('chat'), null);
});

test('archive filtering and out-of-order replies preserve the newest archive state', () => {
  const original = { id: 'chat', title: 'Title', folderId: 'folder', messages: [], organizationVersion: 0 };
  const archived = { ...original, archived: true, organizationVersion: 1 };
  const restored = { ...original, archived: false, organizationVersion: 2 };
  assert.deepEqual(visibleChats([original, archived]), [original]);
  assert.deepEqual(visibleChats([original, archived], true), [archived]);
  for (const [a, b] of [[archived, original], [original, archived]]) assert.equal(mergeChat(a, b).archived, true);
  assert.equal(mergeOrganization(archived, restored).archived, false);
  assert.equal(mergeOrganization(restored, archived).archived, false);
});

test('settings recheck archive and deletion after a delayed model catalog lookup', async t => {
  for (const remove of [false, true]) await t.test(remove ? 'deleted' : 'archived', async t => {
    let started, release;
    const ready = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, reply, async () => { started(); await held; });
    const settings = f.call('/api/chats/chat', 'PATCH', { model: 'gpt-6.1-sol', effort: 'high', fast: true });
    await ready;
    try {
      assert.equal((await f.call(remove ? '/api/chats/chat' : '/api/chats/chat/organization', remove ? 'DELETE' : 'PATCH', remove ? { confirmed: true } : { archived: true })).status, 200);
    } finally { release(); }
    assert.equal((await settings).status, remove ? 404 : 409);
    assert.equal(f.store.getChat('chat')?.fast, undefined);
  });
});
