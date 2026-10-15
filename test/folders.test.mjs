import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { folderChoices, mergeChat, mergeOrganization, organizationChanges } from '../public/folders.js';

async function fixture(t, respond) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-folders-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  store.replaceChats([{ id: 'old', title: 'Existing', model: 'gpt-6.1-sol', effort: 'high', messages: [], input: [] }]);
  const auth = { status: () => ({ connected: false }), accessToken: async () => 'fixture-token' };
  const fetcher = async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', max_context_window: 872000, supported_reasoning_efforts: ['high'] }] });
    if (!respond) throw new Error('Unexpected inference');
    return respond(JSON.parse(options.body));
  };
  async function connect() {
    const app = await createHarness({ directory, auth, fetcher });
    t.after(() => { app.server.close(); app.server.closeAllConnections(); });
    const page = await fetch(app.origin); await page.text();
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const call = (path, method = 'GET', body) => fetch(app.origin + path, { method,
      headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { app, call };
  }
  return { store, connect, ...await connect() };
}
const completed = () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply' }] },
] } })}\n\n`);

test('nested folders, chat moves and renames persist across restart; old chats start at the top level', async t => {
  const f = await fixture(t);
  let state = await (await f.call('/api/state')).json();
  assert.deepEqual(state.folders, []); assert.equal(state.chats[0].folderId, null);
  const parent = await (await f.call('/api/folders', 'POST', { name: ' Projects ' })).json();
  const child = await (await f.call('/api/folders', 'POST', { name: 'Research', parentId: parent.id })).json();
  const nested = await (await f.call('/api/chats', 'POST', { folderId: child.id })).json();
  assert.equal(nested.folderId, child.id);
  assert.equal((await f.call(`/api/folders/${parent.id}`, 'PATCH', { name: 'Work' })).status, 200);
  assert.equal((await f.call('/api/chats/old/organization', 'PATCH', { title: 'My name', folderId: child.id })).status, 200);
  assert.equal((await f.call(`/api/folders/${child.id}`, 'PATCH', { name: 'Study', parentId: null })).status, 400);
  assert.equal((await f.call(`/api/chats/${nested.id}/organization`, 'PATCH', { folderId: null })).status, 200);
  f.app.server.closeAllConnections(); await new Promise(resolve => f.app.server.close(resolve));
  const reopened = await f.connect(); state = await (await reopened.call('/api/state')).json();
  assert.equal(state.folders.find(folder => folder.id === parent.id).name, 'Work');
  assert.equal(state.folders.find(folder => folder.id === child.id).parentId, parent.id);
  assert.equal(state.folders.find(folder => folder.id === child.id).name, 'Research');
  const old = state.chats.find(chat => chat.id === 'old'); assert.equal(old.title, 'My name'); assert.equal(old.folderId, child.id);
  assert.equal(state.chats.find(chat => chat.id === nested.id).folderId, null);
});

test('folder moves, missing parents and invalid names are rejected without changing structure; routes require session and origin', async t => {
  const f = await fixture(t);
  const parent = await (await f.call('/api/folders', 'POST', { name: 'A' })).json();
  const child = await (await f.call('/api/folders', 'POST', { name: 'B', parentId: parent.id })).json();
  const grandchild = await (await f.call('/api/folders', 'POST', { name: 'C', parentId: child.id })).json();
  for (const parentId of [parent.id, child.id, grandchild.id]) assert.equal((await f.call(`/api/folders/${parent.id}`, 'PATCH', { parentId })).status, 400);
  for (const name of ['', '  ', 'x'.repeat(121), 1]) {
    assert.equal((await f.call('/api/folders', 'POST', { name })).status, 400);
    assert.equal((await f.call('/api/chats/old/organization', 'PATCH', { title: name })).status, 400);
  }
  assert.equal((await f.call('/api/folders', 'POST', { name: 'Missing', parentId: 'missing' })).status, 404);
  assert.equal((await f.call('/api/chats/old/organization', 'PATCH', { folderId: 'missing' })).status, 404);
  assert.equal((await f.call('/api/chats', 'POST', { folderId: 'missing' })).status, 404);
  assert.equal((await f.call(`/api/folders/${child.id}`, 'PATCH', { parentId: 10 })).status, 400);
  assert.equal((await fetch(f.app.origin + '/api/folders', { method: 'POST' })).status, 403);
  assert.equal((await fetch(f.app.origin + '/api/chats/old/organization', { method: 'PATCH', headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal(f.store.listFolders().length, 3);
  assert.equal(f.store.listFolders()[0].parentId, null);
  assert.equal(f.store.listChats()[0].title, 'Existing');
});

test('renaming and moving during first generation is preserved by the completed turn and does not alter inference input', async t => {
  let release, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let request;
  const f = await fixture(t, async body => { request = body; signalStarted(); await held; return completed(); });
  const folder = await (await f.call('/api/folders', 'POST', { name: 'During reply' })).json();
  const stream = await f.call('/api/chats/old/messages', 'POST', { text: 'Automatic title?' });
  await started;
  const edited = await (await f.call('/api/chats/old/organization', 'PATCH', { title: 'Keep this title', folderId: folder.id })).json();
  assert.equal(edited.title, 'Keep this title');
  assert.equal((await f.call(`/api/folders/${folder.id}`, 'PATCH', { name: 'Renamed during reply' })).status, 200);
  release(); const events = (await stream.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).chat.title, 'Keep this title'); assert.equal(events.at(-1).chat.folderId, folder.id);
  assert.deepEqual(request.input, [{ role: 'user', content: 'Automatic title?' }]);
  assert.equal(request.folderId, undefined);
  const saved = f.store.listChats()[0]; assert.equal(saved.title, 'Keep this title'); assert.equal(saved.messages.length, 2);
});

test('a failed folder write does not publish a rename in memory', async t => {
  const f = await fixture(t);
  const folder = await (await f.call('/api/folders', 'POST', { name: 'Original' })).json();
  f.store.db.exec("CREATE TRIGGER fail_folder_write BEFORE UPDATE ON folders BEGIN SELECT RAISE(ABORT, 'Synthetic write failure'); END;");
  assert.equal((await f.call(`/api/folders/${folder.id}`, 'PATCH', { name: 'Not saved' })).status, 400);
  const state = await (await f.call('/api/state')).json(); assert.equal(state.folders[0].name, 'Original');
});

test('move-only edits preserve automatic titles and delayed organization replies do not restore old settings or history', async t => {
  const f = await fixture(t, () => completed());
  const folder = await (await f.call('/api/folders', 'POST', { name: 'Destination' })).json();
  const original = (await (await f.call('/api/state')).json()).chats[0];
  const changes = organizationChanges('chat', original, original.title, folder.id);
  assert.deepEqual(changes, { folderId: folder.id });
  const delayedMove = await (await f.call('/api/chats/old/organization', 'PATCH', changes)).json();
  assert.deepEqual(Object.keys(delayedMove).sort(), ['archived', 'folderId', 'id', 'organizationVersion', 'title']);
  const settings = await (await f.call('/api/chats/old', 'PATCH', { model: 'gpt-6.1-sol', effort: 'high', fast: true })).json();
  assert.equal(mergeOrganization(settings, delayedMove).fast, true);
  const stream = await f.call('/api/chats/old/messages', 'POST', { text: 'Generated first title' });
  const done = (await stream.text()).trim().split('\n').map(JSON.parse).at(-1).chat;
  assert.equal(done.title, 'Generated first title'); assert.equal(done.folderId, folder.id);
  const merged = mergeOrganization(done, delayedMove);
  assert.equal(merged.title, done.title); assert.equal(merged.messages.length, 2); assert.equal(merged.fast, true);
  assert.equal(f.store.listChats()[0].titleEdited, undefined);
  // The dialog was opened before the first response arrived. Moving it after
  // completion must not submit its stale title as an intentional rename.
  const afterDoneChanges = organizationChanges('chat', original, original.title, null);
  assert.deepEqual(afterDoneChanges, {});
  const moveOut = organizationChanges('chat', { ...original, folderId: folder.id }, original.title, null);
  assert.deepEqual(moveOut, { folderId: null });
  await f.call('/api/chats/old/organization', 'PATCH', moveOut);
  assert.equal(f.store.listChats()[0].title, 'Generated first title');
});

test('organization merges preserve unrelated settings, newer conversation state and newer names in either response order', () => {
  const current = { id: 'chat', title: 'Old', folderId: null, organizationVersion: 0, model: 'new-model', effort: 'high', fast: true,
    messages: [{ text: 'New reply' }], contextUsage: { totalTokens: 50 }, compactionCount: 2 };
  const staleSnapshot = { ...current, model: 'old-model', effort: 'low', fast: false, messages: [], contextUsage: null, compactionCount: 0,
    title: 'Renamed', folderId: 'folder', organizationVersion: 1 };
  const merged = mergeOrganization(current, staleSnapshot);
  assert.equal(merged.title, 'Renamed'); assert.equal(merged.folderId, 'folder');
  assert.equal(merged.model, 'new-model'); assert.equal(merged.effort, 'high'); assert.equal(merged.fast, true);
  assert.deepEqual(merged.messages, current.messages); assert.deepEqual(merged.contextUsage, current.contextUsage); assert.equal(merged.compactionCount, 2);
  assert.equal(mergeOrganization(merged, { ...staleSnapshot, title: 'Earlier', organizationVersion: 0 }).title, 'Renamed');
  const beforeReply = { ...staleSnapshot, title: 'New chat' }, afterReply = { ...current, title: 'Generated title', folderId: 'folder', organizationVersion: 1 };
  for (const [a, b] of [[beforeReply, afterReply], [afterReply, beforeReply]]) assert.equal(mergeChat(a, b).title, 'Generated title');
  assert.deepEqual(organizationChanges('folder', { name: 'Same', parentId: null }, 'Renamed', null), { name: 'Renamed' });
  assert.deepEqual(organizationChanges('folder', { name: 'Same', parentId: 'original' }, 'Renamed', 'other'), { name: 'Renamed' });
  assert.deepEqual(organizationChanges('folder', { name: 'Same', parentId: 'original' }, 'Same', 'other'), {});
  assert.deepEqual(organizationChanges('chat', current, 'Renamed', null), { title: 'Renamed' });
});

test('move choices omit a folder and descendants; out-of-order organization and generation replies preserve both changes', () => {
  const folders = [{ id: 'a', name: 'A', parentId: null }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'b' }, { id: 'd', name: 'D', parentId: null }];
  assert.deepEqual(folderChoices(folders, 'a').map(item => item.id), ['', 'd']);
  assert.equal(folderChoices(folders)[3].name, 'A / B / C');
  const renamed = { title: 'New name', folderId: 'b', organizationVersion: 1, messages: [], compactionCount: 0 };
  const generation = { title: 'Old name', folderId: null, organizationVersion: 0, messages: [{ text: 'New reply' }], compactionCount: 1 };
  for (const [current, incoming] of [[renamed, generation], [generation, renamed]]) {
    const merged = mergeChat(current, incoming); assert.equal(merged.title, 'New name'); assert.equal(merged.folderId, 'b');
    assert.equal(merged.messages.length, 1); assert.equal(merged.compactionCount, 1);
  }
});

test('a delayed rename body uses the latest organization version and shares a reply that started meanwhile', async t => {
  const { request } = await import('node:http');
  let release;
  const f = await fixture(t, () => new Promise(resolve => { release = () => resolve(completed()); }));
  const page = await fetch(f.app.origin); await page.text();
  const cookie = page.headers.get('set-cookie').split(';')[0];
  let bodyReady;
  const ready = new Promise(resolve => { bodyReady = resolve; });
  f.app.server.on('request', request => { if (request.headers['x-fixture'] === 'slow-rename') bodyReady(); });
  const body = JSON.stringify({ title: 'Delayed custom name' });
  let slowRequest;
  const slowReply = new Promise((resolve, reject) => {
    slowRequest = request(f.app.origin + '/api/chats/old/organization', { method: 'PATCH', headers: {
      Cookie: cookie, Origin: f.app.origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Fixture': 'slow-rename',
    } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', value => { text += value; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) })); response.on('error', reject);
    });
    slowRequest.on('error', reject);
    slowRequest.write(body.slice(0, -1));
  });
  await ready;
  const fast = await (await f.call('/api/chats/old/organization', 'PATCH', { title: 'Earlier name' })).json();
  assert.equal(fast.organizationVersion, 1);
  const generation = await f.call('/api/chats/old/messages', 'POST', { text: 'Automatic title candidate' });
  slowRequest.end(body.slice(-1));
  const renamed = await slowReply;
  assert.equal(renamed.status, 200); assert.equal(renamed.body.organizationVersion, 2);
  release();
  const events = (await generation.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).chat.title, 'Delayed custom name');
  assert.equal(f.store.getChat('old').title, 'Delayed custom name');
});
