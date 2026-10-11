import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { createHarness } from '../server.mjs';
import { autoCompactThreshold } from '../lib/responses.mjs';
import { reconcileCompaction } from '../public/compaction-sync.js';

const checkpoint = id => ({ type: 'compaction', id, encrypted_content: `encrypted-${id}` });
const answer = text => ({ type: 'message', role: 'assistant', id: 'message', status: 'completed', content: [{ type: 'output_text', text }] });
const seed = () => ({ id: 'chat', title: 'Existing chat', model: 'gpt-6.1-sol', effort: 'high', fast: false,
  input: [{ role: 'user', content: 'Remember the project code.' }, answer('Remembered.')],
  messages: [{ role: 'user', text: 'Remember the project code.' }, { role: 'assistant', text: 'Remembered.' }] });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const complete = (output, id = 'response') => ({ type: 'response.completed', response: { id, status: 'completed', model: 'gpt-6.1-sol', output,
  usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100, output_tokens_details: { reasoning_tokens: 12 } } } });

async function fixture(t, respond, chat = seed()) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-compaction-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory), sent = [];
  store.write('chats.json', [chat]);
  const fetcher = async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ models: [
      { slug: 'gpt-6.1-sol', supported_reasoning_efforts: ['high'], context_window: 272000, max_context_window: 872000 },
      { slug: 'gpt-5.5', context_window: 272000, max_context_window: 272000 },
    ] });
    const request = JSON.parse(options.body); sent.push(request);
    return respond(request, options);
  };
  const auth = { status: () => ({ connected: true, sharing: true }), accessToken: async () => 'private-token' };
  const connect = async () => {
    const app = await createHarness({ directory, auth, fetcher });
    t.after(() => { app.server.close(); app.server.closeAllConnections(); });
    const page = await fetch(app.origin); await page.text();
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const call = (path, method = 'GET', body) => fetch(app.origin + path, { method,
      headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { app, call };
  };
  return { store, sent, connect, ...await connect() };
}
const events = async response => (await response.text()).trim().split('\n').map(JSON.parse);

test('automatic checkpoints prune replay, manual compaction preserves transcript, and restart continues from the latest checkpoint', async t => {
  let mode = 'auto';
  const f = await fixture(t, request => {
    const cp = checkpoint(mode === 'auto' ? 'automatic' : 'manual');
    if (mode === 'failure') return sse([
      { type: 'response.output_item.done', output_index: 0, item: checkpoint('uncommitted') },
      { type: 'response.failed', response: { status: 'failed', error: { message: 'Provider failed' } } },
    ]);
    if (mode === 'continue') return sse([complete([answer('Continued.')])]);
    const output = [cp, { type: 'reasoning', encrypted_content: 'private-reasoning' }, answer(mode === 'auto' ? 'Normal reply.' : 'OK')];
    // Recover the checkpoint even when the final response omits its output.
    return sse([...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })), complete([], mode)]);
  });
  let result = await events(await f.call('/api/chats/chat/messages', 'POST', { text: 'Next message' }));
  assert.equal(result.at(-1).type, 'done');
  assert.ok(result.some(item => item.type === 'status' && /automatically compacted/.test(item.message)));
  assert.equal(f.sent[0].context_management[0].compact_threshold, 436000);
  assert.equal(f.sent[0].instructions, undefined);
  let saved = f.store.read('chats.json')[0];
  assert.equal(saved.input[0].id, 'automatic');
  assert.equal(saved.input.length, 3);
  assert.equal(saved.messages.length, 4);
  assert.equal(saved.messages[0].text, 'Remember the project code.');
  assert.equal(saved.messages.at(-1).metadata.events[0].item.id, 'automatic');
  assert.deepEqual(saved.compactions[0].previous_input, seed().input);
  const transcript = saved.messages;

  mode = 'manual';
  result = await events(await f.call('/api/chats/chat/compact', 'POST', {}));
  assert.equal(result[0].type, 'status');
  assert.equal(result.at(-1).type, 'done');
  assert.equal(result.some(item => item.type === 'delta'), false);
  assert.equal(f.sent[1].context_management[0].compact_threshold, 1000);
  assert.equal(f.sent[1].input[0].id, 'automatic');
  assert.equal(f.sent[1].input.some(item => item.role === 'user'), false);
  saved = f.store.read('chats.json')[0];
  assert.deepEqual(saved.messages, transcript);
  assert.deepEqual(saved.input, [checkpoint('manual')]);
  assert.equal(saved.compactions.length, 2);
  assert.equal(saved.compactions[1].mode, 'manual');
  assert.equal(saved.compactions[1].previous_input[0].id, 'automatic');
  assert.equal(f.sent[1].instructions, undefined);
  assert.equal(saved.compactions[1].metadata.request.instructions, undefined);
  assert.equal(saved.contextUsage.totalTokens, 100);
  const publicChat = result.at(-1).chat;
  assert.equal(publicChat.contextUsageSource, 'compaction');
  assert.equal(publicChat.compactionCount, 2);
  assert.equal(JSON.stringify(publicChat).includes('encrypted'), false);
  assert.equal(JSON.stringify(saved).includes('private-token'), false);

  mode = 'failure';
  result = await events(await f.call('/api/chats/chat/compact', 'POST', {}));
  assert.equal(result.at(-1).type, 'error');
  saved = f.store.read('chats.json')[0];
  assert.deepEqual(saved.input, [checkpoint('manual')]);
  assert.deepEqual(saved.messages, transcript);
  assert.equal(saved.compactions.length, 2);
  assert.equal(saved.failedAttempts[0].operation, 'compaction');
  assert.match(saved.failedAttempts[0].metadata.error.message, /Provider failed/);

  f.app.server.closeAllConnections(); await new Promise(resolve => f.app.server.close(resolve));
  const restarted = await f.connect();
  const state = await (await restarted.call('/api/state')).json();
  assert.equal(state.chats[0].contextUsageSource, 'compaction');
  mode = 'continue';
  await events(await restarted.call('/api/chats/chat/messages', 'POST', { text: 'Continue' }));
  assert.deepEqual(f.sent.at(-1).input, [checkpoint('manual'), { role: 'user', content: 'Continue' }]);
  saved = f.store.read('chats.json')[0];
  assert.equal(saved.messages.length, 6);
  assert.equal(saved.contextUsage, null);
  assert.equal(saved.input[0].id, 'manual');
});

test('manual compaction accepts checkpoint-only output and refuses missing, malformed or unfinished checkpoints without replacing history', async t => {
  const scenarios = [
    { name: 'checkpoint only', reply: [complete([checkpoint('only')])], succeeds: true },
    { name: 'too short or unsupported', reply: [complete([answer('OK')])], error: /Nothing to compact/ },
    { name: 'malformed checkpoint', reply: [complete([{ type: 'compaction', id: 'bad' }, answer('OK')])], error: /without encrypted context/ },
    { name: 'incomplete', reply: [{ type: 'response.incomplete' }], error: /incomplete/ },
    { name: 'disconnected', reply: [{ type: 'response.output_item.done', output_index: 0, item: checkpoint('partial') }], error: /before the reply completed/ },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const before = seed();
    const f = await fixture(t, () => sse(scenario.reply), before);
    const result = await events(await f.call('/api/chats/chat/compact', 'POST', {}));
    const saved = f.store.read('chats.json')[0];
    assert.deepEqual(saved.messages, before.messages);
    if (scenario.succeeds) {
      assert.equal(result.at(-1).type, 'done');
      assert.deepEqual(saved.input, [checkpoint('only')]);
    } else {
      assert.equal(result.at(-1).type, 'error');
      assert.match(result.at(-1).message, scenario.error);
      assert.deepEqual(saved.input, before.input);
      assert.equal(saved.compactions, undefined);
      assert.equal(saved.failedAttempts[0].operation, 'compaction');
    }
  });
});

test('manual compaction locks chat edits, duplicate requests and sign-out until it finishes', async t => {
  let unblock, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async () => {
    started(); await new Promise(resolve => { unblock = resolve; });
    return sse([complete([checkpoint('locked')])]);
  });
  const pending = f.call('/api/chats/chat/compact', 'POST', {});
  await ready;
  assert.equal((await f.call('/api/chats/chat/compact', 'POST', {})).status, 409);
  assert.equal((await f.call('/api/chats/chat/messages', 'POST', { text: 'Concurrent' })).status, 409);
  assert.equal((await f.call('/api/chats/chat', 'PATCH', { model: 'gpt-5.5', effort: 'low' })).status, 409);
  assert.equal((await f.call('/api/logout', 'POST', {})).status, 409);
  unblock();
  assert.equal((await events(await pending)).at(-1).type, 'done');
  assert.equal(f.sent.length, 1);
});

test('compaction disk failure keeps the old checkpoint in memory and on disk', async t => {
  const f = await fixture(t, () => sse([complete([checkpoint('new')])]));
  const write = Store.prototype.write;
  t.after(() => { Store.prototype.write = write; });
  let fail = true;
  Store.prototype.write = function(name, value) {
    if (this.directory === f.store.directory && name === 'chats.json' && fail) { fail = false; throw new Error('Disk full'); }
    return write.call(this, name, value);
  };
  const result = await events(await f.call('/api/chats/chat/compact', 'POST', {}));
  assert.equal(result.at(-1).type, 'error');
  assert.match(result.at(-1).message, /Disk full/);
  assert.deepEqual(f.store.read('chats.json')[0].input, seed().input);
  const state = await (await f.call('/api/state')).json();
  assert.equal(state.chats[0].compactionCount, 0);
  assert.deepEqual(state.chats[0].messages, seed().messages);
  assert.equal((await events(await f.call('/api/chats/chat/compact', 'POST', {}))).at(-1).type, 'done');
});

test('automatic compaction uses half the catalog maximum and is unavailable without a supported maximum', () => {
  assert.equal(autoCompactThreshold({ contextWindow: 272000, maxContextWindow: 872000 }), 436000);
  assert.equal(autoCompactThreshold({ maxContextWindow: 272000 }), 136000);
  for (const maximum of [null, undefined, 0, -1, '872000', 1999, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(autoCompactThreshold({ contextWindow: 272000, maxContextWindow: maximum }), null);
  }
});

test('model changes use the selected catalog maximum and custom models have no invented automatic threshold', async t => {
  const f = await fixture(t, () => sse([complete([answer('Reply.')])]));
  await f.call('/api/chats/chat', 'PATCH', { model: 'gpt-5.5', effort: 'default' });
  await events(await f.call('/api/chats/chat/messages', 'POST', { text: 'Use GPT-5.5' }));
  assert.equal(f.sent[0].model, 'gpt-5.5');
  assert.equal(f.sent[0].context_management[0].compact_threshold, 136000);
  await f.call('/api/chats/chat', 'PATCH', { model: 'custom-model', effort: 'default' });
  await events(await f.call('/api/chats/chat/messages', 'POST', { text: 'Use custom model' }));
  assert.equal(f.sent[1].context_management, undefined);
});

test('closing a manual compaction stream cancels inference and preserves the old active context', { timeout: 3000 }, async t => {
  let notifyAbort;
  const aborted = new Promise(resolve => { notifyAbort = resolve; });
  const f = await fixture(t, (_request, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(new DOMException('Cancelled', 'AbortError')); notifyAbort();
    }, { once: true });
  }));
  const response = await f.call('/api/chats/chat/compact', 'POST', {});
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /Compacting context/);
  await reader.cancel(); await aborted;
  const state = await (await f.call('/api/state')).json();
  assert.equal(state.chats[0].compactionCount, 0);
  const saved = f.store.read('chats.json')[0];
  assert.deepEqual(saved.input, seed().input);
  assert.deepEqual(saved.messages, seed().messages);
  assert.equal(saved.failedAttempts[0].operation, 'compaction');
  assert.equal(saved.failedAttempts[0].metadata.error.name, 'AbortError');
});

test('a lost manual completion acknowledgment is reconciled from durable state', async t => {
  for (const disconnect of [false, true]) await t.test(disconnect ? 'socket closes after commit' : 'done frame is missing', async t => {
    const f = await fixture(t, () => sse([complete([checkpoint('saved-before-disconnect')])]));
    // Lose the browser acknowledgment after the real handler commits the chat.
    f.app.server.on('request', (request, response) => {
      if (request.url !== '/api/chats/chat/compact') return;
      const write = response.write;
      response.write = function(chunk, ...args) {
        if (String(chunk).startsWith('{"type":"done"')) {
          if (disconnect) this.destroy();
          return true;
        }
        return write.call(this, chunk, ...args);
      };
    });
    const response = await f.call('/api/chats/chat/compact', 'POST', {});
    if (disconnect) await assert.rejects(response.text());
    else assert.equal((await events(response)).some(item => item.type === 'done'), false);
    let displayed;
    const confirmed = await reconcileCompaction({ chatId: 'chat', previousCount: 0,
      readState: async () => (await f.call('/api/state')).json(),
      onChat: chat => { displayed = chat; },
    });
    assert.equal(confirmed, true);
    assert.equal(displayed.compactionCount, 1);
    assert.equal(displayed.contextUsageSource, 'compaction');
    assert.equal(displayed.contextUsage.totalTokens, 100);
    assert.deepEqual(displayed.messages, seed().messages);
    assert.deepEqual(f.store.read('chats.json')[0].input, [checkpoint('saved-before-disconnect')]);
  });
});

test('reconciliation distinguishes an uncommitted operation and does not claim success when saved state cannot be read', async t => {
  const f = await fixture(t, () => sse([{ type: 'response.failed', response: { status: 'failed', error: { message: 'Failed' } } }]));
  await events(await f.call('/api/chats/chat/compact', 'POST', {}));
  let displayed;
  const confirmed = await reconcileCompaction({ chatId: 'chat', previousCount: 0,
    readState: async () => (await f.call('/api/state')).json(), onChat: chat => { displayed = chat; },
  });
  assert.equal(confirmed, false);
  assert.equal(displayed.compactionCount, 0);
  assert.deepEqual(displayed.messages, seed().messages);
  await assert.rejects(reconcileCompaction({ chatId: 'chat', previousCount: 0,
    readState: async () => { throw new Error('Offline'); }, onChat() { throw new Error('Must not publish an unknown state'); },
  }), /Offline/);
});
