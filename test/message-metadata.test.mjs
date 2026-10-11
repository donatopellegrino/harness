import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readableMessageMetadata } from '../lib/message-metadata.mjs';
import { createHarness } from '../server.mjs';
import { Store } from '../lib/store.mjs';

const metadata = () => ({
  request: { model: 'gpt-6.1-sol', reasoning: { effort: 'high' }, service_tier: 'priority',
    include: ['reasoning.encrypted_content'], context_management: [{ type: 'compaction', compact_threshold: 348800 }] },
  started_at: '2026-10-11T12:00:00.000Z', finished_at: '2026-10-11T12:00:01.000Z',
  http: { status: 200, headers: { 'x-request-id': 'request-id', authorization: 'Bearer secret-auth', 'set-cookie': 'secret-cookie' } },
  response: { id: 'resp_identifier', model: 'reported-model', service_tier: 'default', reasoning: { effort: null }, status: 'completed',
    usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60, output_tokens_details: { reasoning_tokens: 10 } },
    output: [
      { type: 'reasoning', id: 'rs_identifier', encrypted_content: 'secret-reasoning', summary: [{ type: 'summary_text', text: 'A readable reasoning summary.' }] },
      { type: 'compaction', id: 'cp_identifier', encrypted_content: 'secret-compaction' },
      { type: 'message', id: 'msg_identifier', role: 'assistant', content: [{ type: 'output_text', text: 'Duplicate reply body', annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'Source' }], logprobs: [{ token: 'Hello', logprob: -.2 }] }] },
    ], future_field: { flag: false, count: 0, value: null, input: 7, bytes: 200, description: '<script>readable, never executable</script>' },
    future_encoded: 'A'.repeat(200), future_id: 'id'.repeat(120), image: { file_data: 'secret-file-data', url: 'data:image/png;base64,secret-media' },
  },
  events: [
    { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, delta: 'Duplicate streamed body' },
    { type: 'response.reasoning_summary_text.delta', sequence_number: 3, delta: 'Readable summary delta' },
  ],
});

test('readable metadata retains readable and unknown fields while removing opaque, credential and duplicate payloads without changing the archive', () => {
  const raw = metadata(), before = structuredClone(raw);
  const data = readableMessageMetadata({ messages: [{ role: 'assistant', text: 'Reply', metadata: raw }] }, 0);
  assert.equal(data.available, true);
  assert.equal(data.metadata.request.reasoning.effort, 'high');
  assert.equal(data.metadata.response.reasoning.effort, null);
  assert.equal(data.metadata.http.headers['x-request-id'], 'request-id');
  assert.equal(data.metadata.response.output[0].summary[0].text, 'A readable reasoning summary.');
  assert.equal(data.metadata.response.output[2].content[0].annotations[0].title, 'Source');
  assert.equal(data.metadata.response.output[2].content[0].logprobs[0].token, 'Hello');
  assert.deepEqual(data.metadata.response.future_field, raw.response.future_field);
  assert.equal(data.metadata.response.future_id, raw.response.future_id);
  assert.equal(data.metadata.events[0].sequence_number, 2);
  assert.equal(data.metadata.events[1].delta, 'Readable summary delta');
  assert.deepEqual(raw, before);
  const serialized = JSON.stringify(data);
  for (const hidden of ['secret-reasoning', 'secret-compaction', 'secret-auth', 'secret-cookie', 'secret-file-data', 'secret-media', 'Duplicate reply body', 'Duplicate streamed body', 'A'.repeat(200)]) {
    assert.equal(serialized.includes(hidden), false, `Must exclude ${hidden.slice(0, 30)}`);
  }
  assert.equal(data.excluded.find(item => item.reason === 'Encrypted reasoning or compaction state').fields, 2);
});

test('older user messages recover their own request from the paired reply rather than the current chat settings', () => {
  const chat = { model: 'different-model', effort: 'low', messages: [
    { role: 'user', text: 'Question' }, { role: 'assistant', text: 'Reply', metadata: metadata() },
    { role: 'user', text: 'Old question without metadata' }, { role: 'assistant', text: 'Old reply' },
  ] };
  const data = readableMessageMetadata(chat, 0);
  assert.equal(data.metadata.request.model, 'gpt-6.1-sol');
  assert.equal(data.metadata.request.reasoning.effort, 'high');
  assert.equal(data.metadata.sent_at, '2026-10-11T12:00:00.000Z');
  assert.match(data.source, /paired assistant reply/);
  assert.equal(data.metadata.response, undefined);
  assert.equal(readableMessageMetadata(chat, 2).available, false);
  assert.equal(readableMessageMetadata(chat, 3).available, false);
  assert.equal(readableMessageMetadata(chat, 4), null);
});

test('message-info route is session protected, scoped to one message, lazy and survives compaction and restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-message-info-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  store.write('chats.json', [{ id: 'chat', title: 'Saved', model: 'other-model', effort: 'low',
    // Active context has been compacted; transcript metadata remains available.
    input: [{ type: 'compaction', encrypted_content: 'private-active-state' }],
    messages: [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Reply', metadata: metadata() }] }]);
  const auth = { status: () => ({ connected: false }) };
  for (let i = 0; i < 2; i++) {
    const app = await createHarness({ directory, auth });
    t.after(() => { app.server.close(); app.server.closeAllConnections(); });
    const url = `${app.origin}/api/chats/chat/messages/1/metadata`;
    assert.equal((await fetch(url)).status, 403);
    const home = await fetch(app.origin); await home.text();
    const headers = { Cookie: home.headers.get('set-cookie').split(';')[0] };
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
    const state = await (await fetch(app.origin + '/api/state', { headers })).json();
    assert.equal(state.chats[0].messages[1].metadata, undefined);
    const response = await fetch(url, { headers }), data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.message.position, 2);
    assert.equal(data.metadata.response.id, 'resp_identifier');
    assert.equal(JSON.stringify(data).includes('private-active-state'), false);
    assert.equal(JSON.stringify(data).includes('secret-reasoning'), false);
    const user = await (await fetch(`${app.origin}/api/chats/chat/messages/0/metadata`, { headers })).json();
    assert.equal(user.metadata.request.model, 'gpt-6.1-sol');
    assert.equal((await fetch(`${app.origin}/api/chats/chat/messages/9/metadata`, { headers })).status, 404);
    assert.equal((await fetch(`${app.origin}/api/chats/unknown/messages/0/metadata`, { headers })).status, 404);
    assert.deepEqual(store.read('chats.json')[0].messages[1].metadata, metadata());
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  }
});
