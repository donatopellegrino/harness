import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Store } from '../lib/store.mjs';
import { ChatGPTAuth } from '../lib/auth.mjs';
import { createHarness, readJSON } from '../server.mjs';
import { streamReply, normalizeModels, resolveModel, latestUsage } from '../lib/responses.mjs';
import { accountSynchronizer } from '../public/account-sync.js';

const discovery = {
  issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
  revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
};
const tempStore = t => {
  const directory = mkdtempSync(join(tmpdir(), 'basic-harness-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new Store(directory);
};
async function fixture(t, { scope = 'openid chatgpt.tokens.use.direct offline_access', badNonce = false, audience = 'oaiapp_test', expired = false, wrongKey = false } = {}) {
  const store = tempStore(t);
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = await exportJWK(publicKey);
  const signingKey = wrongKey ? (await generateKeyPair('RS256')).privateKey : privateKey;
  const jwks = createLocalJWKSet({ keys: [{ ...key, kid: 'test', alg: 'RS256' }] });
  let nonce, refreshes = 0, revokedToken, lastGrant;
  const auth = new ChatGPTAuth(store, { discovery, jwks, fetcher: async (url, options) => {
    const body = new URLSearchParams(options.body);
    if (url === discovery.revocation_endpoint) { revokedToken = body.get('token'); return new Response('', { status: 200 }); }
    lastGrant = body;
    if (body.get('grant_type') === 'refresh_token') {
      refreshes++; await new Promise(resolve => setTimeout(resolve, 15));
      return Response.json({ access_token: 'access-refreshed', refresh_token: 'refresh-new', expires_in: 3600, scope });
    }
    const idToken = await new SignJWT({ nonce: badNonce ? 'wrong' : nonce, email: 'test@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(discovery.issuer).setAudience(audience)
      .setSubject('user-test').setIssuedAt().setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 100 : '1h').sign(signingKey);
    return Response.json({ access_token: 'access-test', refresh_token: 'refresh-test', id_token: idToken, scope, expires_in: 3600 });
  } });
  async function login() {
    const url = new URL(await auth.begin('http://127.0.0.1:12345'));
    nonce = url.searchParams.get('nonce');
    await auth.finish(new URLSearchParams({ code: 'code', state: url.searchParams.get('state'), client_id: 'oaiapp_test' }));
    return url;
  }
  return { auth, store, login, refreshes: () => refreshes, revokedToken: () => revokedToken, lastGrant: () => lastGrant };
}

test('dynamic registration, PKCE, signed identity, scoped access, protected persistence', async t => {
  const f = await fixture(t), url = await f.login();
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'Basic Harness');
  assert.match(url.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(f.lastGrant().get('client_id'), 'oaiapp_test');
  assert.equal(f.lastGrant().get('resource'), 'https://api.openai.com/v1');
  assert.equal(await f.auth.accessToken(), 'access-test');
  assert.deepEqual(f.auth.status(), { connected: true, sharing: true, email: 'test@example.com' });
  assert.equal(statSync(join(f.store.directory, 'auth.json')).mode & 0o777, 0o600);
  const again = new URL(await f.auth.begin('http://127.0.0.1:22222'));
  assert.equal(again.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(again.searchParams.get('agent_name_hint'), null);
  assert.equal(again.searchParams.get('ext_agent_host_id'), url.searchParams.get('ext_agent_host_id'));
  assert.equal(new ChatGPTAuth(f.store, { discovery }).host.id, f.auth.host.id);
});

test('rejects wrong state, nonce and client registration; callbacks cannot be replayed', async t => {
  const f = await fixture(t);
  await f.auth.begin('http://127.0.0.1:12345');
  await assert.rejects(f.auth.finish(new URLSearchParams({ state: 'wrong', code: 'code' })), /state/);
  await f.login();
  await assert.rejects(f.auth.finish(new URLSearchParams({ state: 'wrong', code: 'code' })), /state/);
  const url = new URL(await f.auth.begin('http://127.0.0.1:12345'));
  await assert.rejects(f.auth.finish(new URLSearchParams({ state: url.searchParams.get('state'), code: 'code', client_id: 'oaiapp_other' })), /registration/);
  const invalid = await fixture(t, { badNonce: true });
  await assert.rejects(invalid.login(), /identity validation/);
  assert.equal(invalid.auth.status().connected, false);
});

test('identity login without plan permission cannot make model requests', async t => {
  const f = await fixture(t, { scope: 'openid email' }); await f.login();
  assert.equal(f.auth.status().connected, true);
  assert.equal(f.auth.status().sharing, false);
  await assert.rejects(f.auth.accessToken(), /allow ChatGPT plan usage/);
  assert.equal(new URL(await f.auth.begin('http://127.0.0.1:12345')).searchParams.get('prompt'), 'consent');
});

test('rejects untrusted signatures, wrong audience, expired identity and expired login attempts', async t => {
  for (const options of [{ wrongKey: true }, { audience: 'oaiapp_other' }, { expired: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.login());
    assert.equal(f.auth.status().connected, false);
  }
  const f = await fixture(t);
  const url = new URL(await f.auth.begin('http://127.0.0.1:12345')); f.auth.pending.expires = 0;
  await assert.rejects(f.auth.finish(new URLSearchParams({ state: url.searchParams.get('state'), code: 'code', client_id: 'oaiapp_test' })), /expired/);
});

test('concurrent token refresh is serialized and logout revokes the replacement', async t => {
  const f = await fixture(t); await f.login(); f.auth.profile.expires_at = 0;
  assert.deepEqual(await Promise.all([f.auth.accessToken(), f.auth.accessToken()]), ['access-refreshed', 'access-refreshed']);
  assert.equal(f.refreshes(), 1);
  assert.deepEqual(await f.auth.logout(), { revoked: true });
  assert.equal(f.revokedToken(), 'refresh-new');
  assert.equal(f.auth.status().connected, false);
  assert.equal(f.store.read('auth.json').refresh_token, undefined);
  assert.equal(f.store.read('auth.json').client_id, 'oaiapp_test');
});

function sse(events, headers = {}) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  // Deliberately split UTF-8 and SSE delimiters into tiny chunks.
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream', ...headers } });
}
const output = text => [
  { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque' },
  { type: 'message', id: 'msg_test', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
];

test('requires response.completed; distinguishes incomplete and failed streams', async () => {
  const common = { token: 'test', model: 'test', effort: 'default', input: [], onDelta() {} };
  await assert.rejects(streamReply({ ...common, fetcher: async () => sse([{ type: 'response.output_text.delta', delta: 'partial' }]) }), /before the reply completed/);
  await assert.rejects(streamReply({ ...common, fetcher: async () => sse([{ type: 'response.incomplete' }]) }), /incomplete/);
  await assert.rejects(streamReply({ ...common, fetcher: async () => sse([{ type: 'response.failed', response: { error: { message: 'Usage limit' } } }]) }), /Usage limit/);
  await assert.rejects(streamReply({ ...common, fetcher: async () => sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]) }), /without a message/);
});

test('streamed output items survive a completion event with an empty output array', async () => {
  const expected = output('Harness is working.');
  let metadata;
  const completed = { id: 'resp_test', status: 'completed', model: 'test', output: [], reasoning: { effort: null }, future_field: { nested: [1, null] } };
  const events = [
    { type: 'response.output_text.delta', delta: 'Harness is working.' },
    ...expected.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
    { type: 'response.completed', response: completed },
  ];
  const result = await streamReply({
    token: 'test', model: 'test', effort: 'default', input: [], onDelta() {},
    onMetadata: value => { metadata = value; },
    fetcher: async () => sse(events),
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(metadata.response, completed); // Do not replace the raw empty output envelope.
  assert.deepEqual(metadata.events, events); // Completed item metadata remains available separately.
  assert.equal(metadata.request.reasoning, undefined);
  assert.equal(metadata.request.input, undefined);
});

test('archives HTTP failures, incomplete streams, interrupted streams and transport errors', async () => {
  const common = { token: 'secret-test-token', model: 'test', effort: 'default', input: [], onDelta() {} };
  const incomplete = { id: 'resp_partial', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 100 } };
  const scenarios = [
    { fetcher: async () => Response.json({ error: { code: 'rate_limit', message: 'Try later' } }, { status: 429, headers: { 'x-request-id': 'req_error', 'set-cookie': 'secret-cookie' } }), match: /Try later/, check: data => {
      assert.equal(data.http.status, 429);
      assert.equal(data.http.headers['x-request-id'], 'req_error');
      assert.equal(data.http.headers['set-cookie'], undefined);
      assert.equal(JSON.parse(data.http.body).error.code, 'rate_limit');
    } },
    { fetcher: async () => sse([{ type: 'response.incomplete', response: incomplete }]), match: /incomplete/, check: data => assert.deepEqual(data.response, incomplete) },
    { fetcher: async () => sse([{ type: 'response.output_text.delta', delta: 'partial' }]), match: /before the reply completed/, check: data => assert.equal(data.events[0].delta, 'partial') },
    { fetcher: async () => { throw new TypeError('Network offline'); }, match: /Network offline/, check: data => assert.equal(data.http, null) },
  ];
  for (const scenario of scenarios) {
    let metadata;
    await assert.rejects(streamReply({ ...common, fetcher: scenario.fetcher, onMetadata: value => { metadata = value; } }), scenario.match);
    scenario.check(metadata);
    assert.match(metadata.error.message, scenario.match);
    assert.ok(Date.parse(metadata.finished_at) >= Date.parse(metadata.started_at));
    assert.equal(JSON.stringify(metadata).includes('secret-test-token'), false);
  }
});

test('a page opened before OAuth completion picks up the new account without a reload', async () => {
  let current = { connected: false, sharing: false, email: null };
  let backend = { ...current }, refreshes = 0;
  const sync = accountSynchronizer({
    readStatus: async () => backend, currentStatus: () => current,
    onChange: async () => { refreshes++; current = { ...backend }; },
  });
  await sync(); assert.equal(refreshes, 0);
  backend = { connected: true, sharing: true, email: 'test@example.com' };
  await sync();
  assert.deepEqual(current, backend);
  assert.equal(refreshes, 1);
  await sync(); assert.equal(refreshes, 1);
  backend = { connected: false, sharing: false, email: 'test@example.com' };
  await sync(); assert.equal(refreshes, 2);
});

test('account checks do not overwrite a streaming chat or run concurrently', async () => {
  let busy = true, reads = 0, refreshes = 0, resolve;
  const sync = accountSynchronizer({
    readStatus: () => { reads++; return new Promise(done => { resolve = done; }); },
    currentStatus: () => ({ connected: false }),
    onChange: async () => { refreshes++; }, canSync: () => !busy,
  });
  await sync(); assert.equal(reads, 0);
  busy = false; const pending = sync();
  await sync(); assert.equal(reads, 1);
  busy = true; resolve({ connected: true, sharing: true }); await pending;
  assert.equal(refreshes, 0);
});

test('a transient account read failure allows the next check to recover', async () => {
  let reads = 0, refreshes = 0;
  const sync = accountSynchronizer({
    readStatus: async () => { if (++reads === 1) throw new Error('Offline'); return { connected: true, sharing: true }; },
    currentStatus: () => ({ connected: false }), onChange: async () => { refreshes++; },
  });
  await assert.rejects(sync(), /Offline/);
  await sync(); assert.equal(refreshes, 1);
});

test('an incomplete model refresh is retried even after account status was updated', async () => {
  const connected = { connected: true, sharing: true, email: 'fixture@example.com' };
  let current = { connected: false }, models = [], refreshes = 0;
  const sync = accountSynchronizer({
    readStatus: async () => connected, currentStatus: () => current,
    needsRefresh: () => current.sharing && models.length === 0,
    onChange: async () => {
      current = connected;
      if (++refreshes === 1) throw new Error('Temporary model catalog failure');
      models = ['test'];
    },
  });
  await assert.rejects(sync(), /Temporary model/);
  await sync();
  assert.equal(refreshes, 2);
  assert.deepEqual(models, ['test']);
  await sync();
  assert.equal(refreshes, 2);
});

test('HTTP chat flow: model/effort, full history, isolation, failed-turn rollback and restart', async t => {
  const store = tempStore(t), sent = [];
  const auth = { status: () => ({ connected: true, sharing: true, email: 'test@example.com' }), accessToken: async () => 'private-token' };
  const fetcher = async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ models: [
      { slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list', supported_reasoning_efforts: ['low', 'medium', 'high'] },
      { slug: 'hidden', visibility: 'hidden' },
    ] });
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    const body = JSON.parse(options.body); sent.push(body);
    if (body.input.at(-1).content === 'fail') return sse([{ type: 'response.failed', response: { id: 'resp_failed', status: 'failed', error: { code: 'usage_limit', message: 'Usage limit reached' } } }]);
    return sse([{ type: 'response.output_text.delta', delta: 'Hello 🐱' }, { type: 'response.completed', response: {
      id: 'resp_metadata', object: 'response', created_at: 1234, completed_at: 1235,
      status: 'completed', model: body.model, reasoning: { effort: 'medium', summary: null }, service_tier: 'default',
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 30 },
      metadata: { label: 'provider-value' }, future_field: { nested: [null, 'preserve'] }, error: null, output: output('Hello 🐱'),
    } }], { 'x-request-id': 'req_metadata', 'openai-processing-ms': '123', 'set-cookie': 'secret-cookie', authorization: 'secret-header' });
  };
  const app = await createHarness({ directory: store.directory, auth, fetcher });
  t.after(() => { app.server.close(); app.server.closeAllConnections(); });
  const home = await fetch(app.origin);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const call = (path, method = 'GET', body, extra = {}) => fetch(app.origin + path, { method, headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(app.origin + '/api/state')).status, 403);
  assert.equal((await call('/api/chats', 'POST', undefined, { Origin: 'https://evil.example' })).status, 403);
  const state = await (await call('/api/state')).text(); assert.equal(state.includes('private-token'), false);
  const account = await (await call('/api/account')).json();
  assert.deepEqual(account, { connected: true, sharing: true, email: 'test@example.com' });
  const modelList = (await (await call('/api/models')).json()).models;
  assert.equal(modelList.length, 4);
  assert.ok(modelList.some(model => model.id === 'gpt-6-sol'));
  assert.ok(modelList.some(model => model.id === 'gpt-6-luna'));
  const first = await (await call('/api/chats', 'POST')).json();
  const second = await (await call('/api/chats', 'POST')).json();
  assert.equal(first.fast, false);
  assert.equal((await call(`/api/chats/${first.id}`, 'PATCH', { model: 'gpt-6.1-sol', effort: 'high', fast: 'true' })).status, 400);
  await call(`/api/chats/${first.id}`, 'PATCH', { model: 'gpt-6.1-sol', effort: 'high', fast: true });
  let events = (await (await call(`/api/chats/${first.id}/messages`, 'POST', { text: 'Hi' })).text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].text, 'Hello 🐱'); assert.equal(events.at(-1).type, 'done');
  assert.deepEqual(events.at(-1).chat.contextUsage, {
    model: 'gpt-6.1-sol', inputTokens: 10, outputTokens: 20, totalTokens: 30, cachedTokens: 4, reasoningTokens: 12,
  });
  assert.match(events.find(event => event.type === 'notice').message, /OpenAI used Standard/);
  await call(`/api/chats/${first.id}/messages`, 'POST', { text: 'Follow up' });
  assert.deepEqual(sent[1].input.slice(1, 3), output('Hello 🐱'));
  assert.equal(sent[1].reasoning.effort, 'high');
  assert.equal(sent[0].service_tier, 'priority');
  assert.equal(sent[1].service_tier, 'priority');
  assert.equal(sent[1].store, false); assert.equal(sent[1].stream, true);
  assert.equal(sent[1].previous_response_id, undefined); assert.equal(sent[1].tools, undefined);
  await call(`/api/chats/${second.id}`, 'PATCH', { model: 'gpt-6.1-sol', effort: 'default' });
  const standardEvents = await (await call(`/api/chats/${second.id}/messages`, 'POST', { text: 'Separate' })).text();
  assert.equal(standardEvents.includes('"type":"notice"'), false);
  assert.deepEqual(sent[2].input, [{ role: 'user', content: 'Separate' }]);
  assert.equal(sent[2].reasoning, undefined);
  assert.equal(sent[2].service_tier, 'default');
  assert.equal((await call(`/api/chats/${second.id}`, 'PATCH', { model: 'future-chat-model', effort: 'default' })).status, 200);
  await call(`/api/chats/${second.id}/messages`, 'POST', { text: 'Use an unlisted model' });
  assert.equal(sent[3].model, 'future-chat-model');
  assert.equal((await call(`/api/chats/${second.id}`, 'PATCH', { model: '../invalid', effort: 'default' })).status, 400);
  events = (await (await call(`/api/chats/${first.id}/messages`, 'POST', { text: 'fail' })).text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'error');
  const saved = store.read('chats.json');
  const savedFirst = saved.find(chat => chat.id === first.id);
  assert.equal(savedFirst.messages.length, 4);
  assert.equal(savedFirst.input.at(-1).type, 'message');
  const metadata = savedFirst.messages[1].metadata;
  assert.equal(metadata.request.reasoning.effort, 'high');
  assert.equal(metadata.request.service_tier, 'priority');
  assert.equal(metadata.response.reasoning.effort, 'medium');
  assert.equal(metadata.response.service_tier, 'default');
  assert.equal(metadata.response.usage.output_tokens_details.reasoning_tokens, 12);
  assert.deepEqual(metadata.response.future_field, { nested: [null, 'preserve'] });
  assert.equal(metadata.response.error, null);
  assert.equal(metadata.response.completed_at, 1235);
  assert.equal(metadata.http.headers['x-request-id'], 'req_metadata');
  assert.equal(metadata.http.headers['openai-processing-ms'], '123');
  assert.equal(metadata.events.at(-1).response.id, 'resp_metadata');
  assert.equal(savedFirst.failedAttempts.length, 1);
  assert.equal(savedFirst.failedAttempts[0].metadata.response.error.code, 'usage_limit');
  assert.equal(statSync(join(store.directory, 'chats.json')).mode & 0o777, 0o600);
  const serialized = JSON.stringify(saved);
  for (const secret of ['private-token', 'secret-cookie', 'secret-header']) assert.equal(serialized.includes(secret), false);
  // Metadata is archived locally, not sent back as model input or ordinary UI state.
  assert.equal(sent[1].input.some(item => item.metadata), false);
  assert.equal(JSON.stringify(events.at(-1)).includes('req_metadata'), false);
  const setting = await (await call(`/api/chats/${first.id}`, 'PATCH', { model: 'gpt-6.1-sol', effort: 'high', fast: false })).json();
  assert.equal(setting.fast, false);
  await call(`/api/chats/${first.id}/messages`, 'POST', { text: 'Standard again' });
  assert.equal(sent.at(-1).service_tier, 'default');
  assert.equal(sent.at(-1).reasoning.effort, 'high');
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  const restarted = await createHarness({ directory: store.directory, auth, fetcher });
  t.after(() => { restarted.server.close(); restarted.server.closeAllConnections(); });
  const newCookie = (await fetch(restarted.origin)).headers.get('set-cookie').split(';')[0];
  const restored = await (await fetch(restarted.origin + '/api/state', { headers: { Cookie: newCookie } })).json();
  assert.equal(restored.chats.find(chat => chat.id === first.id).effort, 'high');
  assert.equal(restored.chats.find(chat => chat.id === first.id).fast, false);
  assert.equal(restored.chats.find(chat => chat.id === first.id).messages.length, 6);
  assert.equal(restored.chats.find(chat => chat.id === first.id).messages[1].metadata, undefined);
  assert.equal(restored.chats.find(chat => chat.id === first.id).contextUsage.totalTokens, 30);
  await fetch(`${restarted.origin}/api/chats/${first.id}/messages`, {
    method: 'POST', headers: { Cookie: newCookie, Origin: restarted.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Continue after restart' }),
  }).then(response => response.text());
  const afterRestart = store.read('chats.json').find(chat => chat.id === first.id);
  assert.deepEqual(afterRestart.messages[1].metadata, metadata);
  assert.equal(afterRestart.messages.at(-1).metadata.response.id, 'resp_metadata');
  assert.equal(afterRestart.failedAttempts[0].metadata.response.id, 'resp_failed');
  assert.deepEqual(sent.at(-1).input.slice(1, 3), output('Hello 🐱'));
});

test('client cancellation archives received metadata without committing a partial turn', async t => {
  const store = tempStore(t);
  store.write('chats.json', [{ id: 'cancel-test', title: 'New chat', model: 'test', effort: 'default', messages: [], input: [] }]);
  const auth = { status: () => ({ connected: true, sharing: true }), accessToken: async () => 'secret' };
  const app = await createHarness({ directory: store.directory, auth, fetcher: async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'test' }] });
    return new Response(new ReadableStream({ start(controller) {
      const events = [{ type: 'response.created', response: { id: 'resp_cancel', status: 'in_progress', future_field: 'keep' } }, { type: 'response.output_text.delta', delta: 'partial' }];
      controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Cancelled', 'AbortError')), { once: true });
    } }), { headers: { 'x-request-id': 'req_cancel' } });
  } });
  t.after(() => { app.server.close(); app.server.closeAllConnections(); });
  const cookie = (await fetch(app.origin)).headers.get('set-cookie').split(';')[0];
  const abort = new AbortController();
  const response = await fetch(`${app.origin}/api/chats/cancel-test/messages`, {
    method: 'POST', signal: abort.signal,
    headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Cancel this' }),
  });
  await response.body.getReader().read();
  abort.abort();
  // Wait only for this local server's close/abort handler to persist the record.
  let saved;
  for (let i = 0; i < 100; i++) {
    saved = store.read('chats.json')[0];
    if (saved.failedAttempts?.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(saved.messages, []);
  assert.deepEqual(saved.input, []);
  const metadata = saved.failedAttempts[0].metadata;
  assert.equal(metadata.response.id, 'resp_cancel');
  assert.equal(metadata.response.future_field, 'keep');
  assert.equal(metadata.http.headers['x-request-id'], 'req_cancel');
  assert.equal(metadata.error.name, 'AbortError');
  assert.equal(metadata.events.at(-1).delta, 'partial');
});

test('existing chats without a speed setting use Standard mode', async t => {
  const store = tempStore(t);
  store.write('chats.json', [{ id: 'legacy', title: 'Old chat', model: 'gpt-6-luna', effort: 'high', messages: [], input: [] }]);
  const app = await createHarness({ directory: store.directory, auth: { status: () => ({ connected: false }) } });
  t.after(() => { app.server.close(); app.server.closeAllConnections(); });
  const cookie = (await fetch(app.origin)).headers.get('set-cookie').split(';')[0];
  const state = await (await fetch(app.origin + '/api/state', { headers: { cookie } })).json();
  assert.equal(state.chats[0].fast, false);
});

test('model picker retains the whole catalog, supplements missing GPT-6 models, and permits custom IDs', () => {
  const catalog = normalizeModels({ models: [
    { slug: 'gpt-6-astra', display_name: 'Astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
    { slug: 'gpt-5.5', visibility: 'hide' },
    { slug: 'gpt-6-sol', supported_reasoning_efforts: ['low', 'high'] },
    { slug: 'gpt-6-sol' },
  ] });
  assert.deepEqual(catalog.map(model => model.id), ['gpt-6-astra', 'gpt-5.5', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna']);
  assert.deepEqual(resolveModel(catalog, 'gpt-6-astra').efforts, ['low', 'ultra']);
  assert.deepEqual(resolveModel(catalog, 'gpt-6-sol').efforts, ['low', 'high']);
  assert.equal(resolveModel(catalog, 'future-model').id, 'future-model');
  assert.throws(() => resolveModel(catalog, ''), /valid model ID/);
});

test('context limits use account catalog values and never substitute the larger maximum', () => {
  const catalog = normalizeModels({ models: [
    { slug: 'gpt-6.1-sol', context_window: 272000, max_context_window: 872000 },
    { slug: 'unknown', context_window: '128000', max_context_window: 0 },
    { slug: 'bad', context_window: -1, max_context_window: Number.MAX_SAFE_INTEGER + 1 },
  ] });
  assert.equal(resolveModel(catalog, 'gpt-6.1-sol').contextWindow, 272000);
  assert.equal(resolveModel(catalog, 'gpt-6.1-sol').maxContextWindow, 872000);
  for (const id of ['unknown', 'bad', 'custom', 'gpt-6-luna']) {
    assert.equal(resolveModel(catalog, id).contextWindow, null);
    assert.equal(resolveModel(catalog, id).maxContextWindow, null);
  }
});

test('usage summaries preserve recorded counts without exposing metadata or reusing an older reply', () => {
  const message = { role: 'assistant', text: 'Reply', metadata: {
    request: { model: 'requested-model' },
    response: { model: 'reported-model', usage: { input_tokens: 20000, output_tokens: 10000, total_tokens: 30000,
      input_tokens_details: { cached_tokens: 15000 }, output_tokens_details: { reasoning_tokens: 5000 }, private_field: 'not-for-ui' } },
    http: { headers: { 'x-request-id': 'private-id' } },
  } };
  assert.deepEqual(latestUsage([message]), {
    model: 'reported-model', inputTokens: 20000, outputTokens: 10000, totalTokens: 30000, cachedTokens: 15000, reasoningTokens: 5000,
  });
  assert.equal(latestUsage([message, { role: 'assistant', text: 'Legacy reply' }]), null);
  assert.equal(latestUsage([]), null);
  delete message.metadata.response.model;
  message.metadata.response.usage = { input_tokens: 0, output_tokens: -1, total_tokens: '25' };
  assert.deepEqual(latestUsage([message]), {
    model: 'requested-model', inputTokens: 0, outputTokens: null, totalTokens: null, cachedTokens: null, reasoningTokens: null,
  });
});

test('JSON requests preserve Unicode split across arbitrary byte chunks and enforce byte limits', async () => {
  const body = { text: 'Caffè 🐱 漢字' };
  const bytes = Buffer.from(JSON.stringify(body));
  const request = { headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() {
    for (const byte of bytes) yield Buffer.from([byte]);
  } };
  assert.deepEqual(await readJSON(request), body);
  await assert.rejects(readJSON({ ...request, async *[Symbol.asyncIterator]() { yield Buffer.alloc(128 * 1024 + 1, 32); } }), /too large/);
});

test('a failed disk commit does not publish a turn or contaminate retries', async t => {
  const write = Store.prototype.write;
  t.after(() => { Store.prototype.write = write; });
  for (const failures of [1, 2]) {
    const store = tempStore(t), sent = [];
    store.write('chats.json', [{ id: 'disk-test', title: 'New chat', model: 'test', effort: 'default', messages: [], input: [] }]);
    const app = await createHarness({ directory: store.directory,
      auth: { status: () => ({ connected: true, sharing: true }), accessToken: async () => 'fixture' },
      fetcher: async (url, options) => {
        if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'test' }] });
        sent.push(JSON.parse(options.body));
        return sse([{ type: 'response.completed', response: { status: 'completed', output: output('Saved reply') } }]);
      },
    });
    t.after(() => { app.server.close(); app.server.closeAllConnections(); });
    const cookie = (await fetch(app.origin)).headers.get('set-cookie').split(';')[0];
    const call = (path, method = 'GET', body) => fetch(app.origin + path, { method,
      headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let remaining = failures;
    Store.prototype.write = function(name, value) {
      if (this.directory === store.directory && name === 'chats.json' && remaining > 0) {
        const message = remaining === failures ? 'turn-write-failed' : 'diagnostic-write-failed';
        remaining--;
        throw Object.assign(new Error(message), { code: 'EIO' });
      }
      return write.call(this, name, value);
    };
    const events = (await (await call('/api/chats/disk-test/messages', 'POST', { text: 'First try' })).text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).message, /turn-write-failed/);
    const inMemory = (await (await call('/api/state')).json()).chats[0];
    assert.deepEqual(inMemory.messages, []);
    assert.equal(inMemory.title, 'New chat');
    const saved = store.read('chats.json')[0];
    assert.deepEqual(saved.input, []);
    assert.deepEqual(saved.messages, []);
    await (await call('/api/chats/disk-test/messages', 'POST', { text: 'Retry' })).text();
    assert.deepEqual(sent[1].input, [{ role: 'user', content: 'Retry' }]);
    assert.equal(store.read('chats.json')[0].messages.length, 2);
    Store.prototype.write = write;
  }
});
