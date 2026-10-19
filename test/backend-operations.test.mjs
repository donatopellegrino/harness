import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { createHarness } from '../server.mjs';
import { observeOperation } from '../public/operations.js';

const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const completed = text => ({ type: 'response.completed', response: { status: 'completed', model: 'fixture-model', output: [message(text)] } });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, respond = () => sse([completed('Backend reply')])) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-operations-')), store = new Store(directory), calls = [];
  for (const id of ['first', 'second']) store.createChat({ id, title: id, model: 'fixture-model', effort: 'high', messages: [], input: [] });
  const app = await createHarness({ directory, auth: { status: () => ({ connected: true, sharing: true }), accessToken: async () => 'fixture-token' }, fetcher: async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', supported_reasoning_efforts: ['high'], max_context_window: 20000 }] });
    calls.push(JSON.parse(options.body)); return respond(calls.at(-1), options);
  } });
  t.after(async () => { await app.jobs.idle(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const page = await fetch(app.origin); await page.text();
  const headers = { Cookie: page.headers.get('set-cookie').split(';')[0], Origin: app.origin, 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body) => fetch(app.origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const start = (chatId = 'first', requestId = 'command', text = 'Question') => call('/api/operations', 'POST', { chatId, requestId, text, model: 'fixture-model', effort: 'high', fast: false });
  return { directory, store, app, calls, call, start, headers };
}

test('commands acknowledge before inference finishes, survive detached observers, and reconnect from persisted progress', async t => {
  const started = deferred(); let finish, signal;
  const f = await fixture(t, (_body, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Durable partial' })}\n\n`));
      finish = () => { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(completed('Durable partial and finished'))}\n\n`)); controller.close(); };
      started.resolve();
    } }));
  });
  try {
    const accepted = await f.start(); assert.equal(accepted.status, 202);
    const first = await accepted.json(), path = `/api/chats/first/operations/${first.operation.id}`;
    await started.promise;
    const stream = await f.call(path + '/events'), reader = stream.body.getReader();
    await reader.read(); await reader.cancel(); assert.equal(signal.aborted, false);
    // A second observer sees the durable checkpoint rather than starting work.
    for (let i = 0; i < 50 && !f.store.latestOperation('first').partial_text; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const checkpoint = await (await f.call(path)).json();
    assert.equal(checkpoint.operation.text, 'Durable partial'); assert.equal(checkpoint.operation.status, 'running');
    assert.equal((await (await f.call('/api/chats/first')).json()).operation.id, first.operation.id);
    assert.equal((await f.call('/api/chats/first/organization', 'PATCH', { archived: true })).status, 409);
    assert.equal((await f.call('/api/chats/first', 'DELETE', { confirmed: true })).status, 409);
    finish(); await f.app.jobs.idle();
    const done = await (await f.call(path)).json();
    assert.equal(done.operation.status, 'completed'); assert.equal(done.chat.messages[1].text, 'Durable partial and finished');
    assert.equal(f.calls.length, 1); assert.equal(f.store.latestOperation('first').partial_text, '');
  } finally { if (f.app.jobs.running.size) finish?.(); await f.app.jobs.idle(); }
});

test('idempotent commands and lost acknowledgments never duplicate a model request, including auto-created chats', async t => {
  const held = deferred(), f = await fixture(t, async () => { await held.promise; return sse([completed('One reply')]); });
  try {
    const first = await (await f.start()).json(), duplicate = await (await f.start()).json();
    assert.equal(first.operation.id, duplicate.operation.id);
    assert.equal((await f.start('first', 'different')).status, 409);
    assert.equal((await f.start('first', 'command', 'Different prompt')).status, 409);
    const recovered = await (await f.call('/api/operations/requests/command')).json(); assert.equal(recovered.operation.id, first.operation.id);
    held.resolve(); await f.app.jobs.idle();
    assert.equal((await (await f.start()).json()).operation.status, 'completed'); assert.equal(f.calls.length, 1);
    const body = { requestId: 'auto-create', text: 'New conversation', model: 'fixture-model', effort: 'high', fast: false };
    const created = await (await f.call('/api/operations', 'POST', body)).json(); await f.app.jobs.idle();
    const retry = await (await f.call('/api/operations', 'POST', body)).json();
    assert.equal(created.chat.id, retry.chat.id); assert.equal(created.operation.id, retry.operation.id);
    assert.equal(f.store.listChats().length, 3); assert.equal(f.calls.length, 2);
  } finally { held.resolve(); await f.app.jobs.idle(); }
});

test('per-chat operations run independently and broken observers cannot fail an operation', async t => {
  const held = deferred(), f = await fixture(t, async () => { await held.promise; return sse([completed('Independent')]); });
  try {
    const first = await (await f.start('first', 'one')).json(), second = await (await f.start('second', 'two')).json();
    f.app.jobs.subscribe(first.operation.id, () => { throw new Error('Observer failed'); });
    assert.equal(f.app.jobs.running.size, 2);
    assert.notEqual(first.operation.id, second.operation.id);
    assert.equal((await f.call('/api/chats/first/organization', 'PATCH', { title: 'Renamed while working' })).status, 200);
    held.resolve(); await f.app.jobs.idle();
    assert.equal(f.store.getChat('first').title, 'Renamed while working');
    assert.equal(f.store.latestOperation('first').status, 'completed'); assert.equal(f.store.latestOperation('second').status, 'completed');
  } finally { held.resolve(); await f.app.jobs.idle(); }
});

test('startup marks unfinished durable work interrupted without resubmission or changing its active model context', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-operation-restart-')), store = new Store(directory);
  store.createChat({ id: 'chat', title: 'Before restart', model: 'test', effort: 'default', messages: [], input: [{ role: 'user', content: 'Old context' }] });
  store.startOperation({ id: 'unfinished', chat_id: 'chat', request_id: 'before-crash', command_hash: 'hash', kind: 'reply', created_at: new Date().toISOString(), request: { text: 'Accepted question', model: 'test', effort: 'default', fast: false } });
  store.updateOperation('unfinished', { status: 'running', partial_text: 'Saved partial reply' }); store.close();
  let externalCalls = 0;
  const app = await createHarness({ directory, auth: { status: () => ({ connected: false }) }, fetcher: async () => { externalCalls++; throw new Error('Must not retry'); } });
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const reopened = new Store(directory);
  try {
    const operation = reopened.latestOperation('chat'); assert.equal(operation.status, 'interrupted');
    assert.equal(operation.partial_text, 'Saved partial reply'); assert.equal(operation.request.text, 'Accepted question');
    assert.equal(externalCalls, 0); assert.deepEqual(reopened.getChat('chat').input, [{ role: 'user', content: 'Old context' }]);
    assert.equal(reopened.getChat('chat').messages.length, 0);
  } finally { reopened.close(); }
});

test('a real SQLite transaction failure rolls back both the transcript and completed operation state', async t => {
  const f = await fixture(t);
  f.store.db.exec(`CREATE TRIGGER reject_operation_commit BEFORE UPDATE ON chat_operations WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'Fixture commit failure'); END;`);
  const accepted = await (await f.start()).json(); await f.app.jobs.idle();
  const operation = f.store.getOperation(accepted.operation.id);
  assert.equal(operation.status, 'failed'); assert.match(operation.error, /Fixture commit failure/);
  assert.equal(f.store.getChat('first').messages.length, 0); assert.equal(f.store.getChat('first').input.length, 0);
  f.store.db.exec('DROP TRIGGER reject_operation_commit');
  await f.start('first', 'explicit-retry'); await f.app.jobs.idle(); assert.equal(f.store.getChat('first').messages.length, 2);
  assert.equal((await f.call('/api/chats/first', 'DELETE', { confirmed: true })).status, 200);
  assert.equal(f.store.getOperation(accepted.operation.id), null);
});

test('observer client reconnects to snapshots after a connection drops and abort only stops observation', async () => {
  let calls = 0; const snapshots = [], notices = [], controller = new AbortController();
  await observeOperation({ path: '/events', signal: controller.signal, retryMs: 1,
    fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ type: 'operation', operation: { id: 'operation', status: calls === 1 ? 'running' : 'completed', text: calls === 1 ? 'partial' : '' } }) + '\n');
    }, onSnapshot: event => snapshots.push(event.operation.status), onConnection: text => notices.push(text) });
  assert.deepEqual(snapshots, ['running', 'completed']); assert.equal(calls, 2); assert.ok(notices.some(text => /Reconnecting/.test(text)));
  const aborted = new AbortController(); aborted.abort();
  await observeOperation({ path: '/events', signal: aborted.signal, fetcher: async () => { throw new Error('Should not fetch'); }, onSnapshot() {} });
});

test('graceful backend shutdown drains accepted work even after closing every observer connection', async t => {
  const held = deferred(); let signal;
  const f = await fixture(t, async (_body, options) => { signal = options.signal; await held.promise; return sse([completed('Finished during shutdown')]); });
  try {
    await f.start();
    const closed = new Promise(resolve => f.app.server.close(resolve));
    f.app.server.closeAllConnections(); await closed;
    assert.equal(signal.aborted, false);
    held.resolve(); await f.app.jobs.idle();
    assert.equal(f.store.latestOperation('first').status, 'completed');
    assert.equal(f.store.getChat('first').messages.at(-1).text, 'Finished during shutdown');
  } finally { held.resolve(); }
});

test('an unavailable observer stops reconnecting and asks the page to refresh authoritative chat state', async () => {
  let calls = 0, unavailable = 0;
  await observeOperation({ path: '/expired-private/events', signal: new AbortController().signal,
    fetcher: async () => { calls++; return Response.json({ error: 'Private chat expired or is unavailable.' }, { status: 404 }); },
    onSnapshot() { throw new Error('No snapshot expected'); }, onUnavailable() { unavailable++; } });
  assert.equal(calls, 1); assert.equal(unavailable, 1);
});

test('a duplicate backend rejected by the occupied port cannot interrupt the running owner', async t => {
  const held = deferred();
  const f = await fixture(t, async () => { await held.promise; return sse([completed('Original owner finished')]); });
  try {
    const accepted = await (await f.start()).json();
    await assert.rejects(createHarness({ port: Number(new URL(f.app.origin).port), directory: f.directory,
      auth: { status: () => ({}) } }), { code: 'EADDRINUSE' });
    assert.equal(f.store.getOperation(accepted.operation.id).status, 'running');
    held.resolve(); await f.app.jobs.idle();
    assert.equal(f.store.getOperation(accepted.operation.id).status, 'completed');
  } finally { held.resolve(); }
});
