import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Store } from '../lib/store.mjs';
import { ChatGPTAuth } from '../lib/auth.mjs';
import { createHarness } from '../server.mjs';
import { streamReply } from '../lib/responses.mjs';
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

function sse(events) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  // Deliberately split UTF-8 and SSE delimiters into tiny chunks.
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
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
  const result = await streamReply({
    token: 'test', model: 'test', effort: 'default', input: [], onDelta() {},
    fetcher: async () => sse([
      { type: 'response.output_text.delta', delta: 'Harness is working.' },
      ...expected.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ]),
  });
  assert.deepEqual(result, expected);
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
    if (body.input.at(-1).content === 'fail') return sse([{ type: 'response.failed', response: { error: { message: 'Usage limit reached' } } }]);
    return sse([{ type: 'response.output_text.delta', delta: 'Hello 🐱' }, { type: 'response.completed', response: { status: 'completed', output: output('Hello 🐱') } }]);
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
  assert.equal((await (await call('/api/models')).json()).models.length, 1);
  const first = await (await call('/api/chats', 'POST')).json();
  const second = await (await call('/api/chats', 'POST')).json();
  await call(`/api/chats/${first.id}`, 'PATCH', { model: 'gpt-6.1-sol', effort: 'high' });
  let events = (await (await call(`/api/chats/${first.id}/messages`, 'POST', { text: 'Hi' })).text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].text, 'Hello 🐱'); assert.equal(events.at(-1).type, 'done');
  await call(`/api/chats/${first.id}/messages`, 'POST', { text: 'Follow up' });
  assert.deepEqual(sent[1].input.slice(1, 3), output('Hello 🐱'));
  assert.equal(sent[1].reasoning.effort, 'high');
  assert.equal(sent[1].store, false); assert.equal(sent[1].stream, true);
  assert.equal(sent[1].previous_response_id, undefined); assert.equal(sent[1].tools, undefined);
  await call(`/api/chats/${second.id}`, 'PATCH', { model: 'gpt-6.1-sol', effort: 'default' });
  await call(`/api/chats/${second.id}/messages`, 'POST', { text: 'Separate' });
  assert.deepEqual(sent[2].input, [{ role: 'user', content: 'Separate' }]);
  assert.equal(sent[2].reasoning, undefined);
  events = (await (await call(`/api/chats/${first.id}/messages`, 'POST', { text: 'fail' })).text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'error');
  const saved = store.read('chats.json');
  assert.equal(saved.find(chat => chat.id === first.id).messages.length, 4);
  assert.equal(saved.find(chat => chat.id === first.id).input.at(-1).type, 'message');
  const restarted = await createHarness({ directory: store.directory, auth, fetcher });
  t.after(() => { restarted.server.close(); restarted.server.closeAllConnections(); });
  const newCookie = (await fetch(restarted.origin)).headers.get('set-cookie').split(';')[0];
  const restored = await (await fetch(restarted.origin + '/api/state', { headers: { Cookie: newCookie } })).json();
  assert.equal(restored.chats.find(chat => chat.id === first.id).effort, 'high');
  assert.equal(restored.chats.find(chat => chat.id === first.id).messages.length, 4);
});
