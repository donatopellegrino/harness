import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatNavigation, chatPath, chatIdFromPath } from '../public/chat-navigation.js';
import { createHarness } from '../server.mjs';
import { Store } from '../lib/store.mjs';

function navigation(pathname = '/') {
  const location = { pathname }, calls = [], selected = [];
  const chats = [{ id: 'first', folderId: 'child' }, { id: 'second', archived: true }, { id: 'private-fixture', private: true }];
  let locked = false, missing = 0;
  const history = Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (state, title, path) => {
    calls.push({ method, state, title, path }); location.pathname = path;
  }]));
  const controller = createChatNavigation({ location, history, findChat: id => chats.find(chat => chat.id === id),
    isLocked: () => locked, onSelect: chat => selected.push(chat), onMissing: () => missing++ });
  return { ...controller, location, calls, selected, chats, lock: value => { locked = value; }, missing: () => missing };
}

test('saved chat URLs are stable by ID, while private chat identity never enters URLs or history state', () => {
  const f = navigation();
  f.write(f.chats[0]); assert.deepEqual(f.calls[0], { method: 'pushState', state: null, title: '', path: '/chats/first' });
  f.write({ ...f.chats[0], title: 'Renamed' }); assert.equal(f.calls.length, 1);
  f.write(f.chats[2]); assert.equal(f.location.pathname, '/');
  assert.equal(JSON.stringify(f.calls).includes('private-fixture'), false);
  assert.equal(chatPath(null), '/'); assert.equal(chatPath(f.chats[2]), '/');
  assert.equal(chatIdFromPath('/chats/some-id_123'), 'some-id_123');
  for (const path of ['/', '/chats/', '/chats/a/extra', '/chats/%2F']) assert.equal(chatIdFromPath(path), null);
});

test('direct navigation selects archived or nested chats and treats unavailable/private IDs as missing', () => {
  const f = navigation('/chats/first'); f.openLocation();
  assert.equal(f.selected.at(-1).folderId, 'child');
  f.location.pathname = '/chats/second'; f.openLocation(); assert.equal(f.selected.at(-1).archived, true);
  for (const id of ['missing', 'private-fixture']) { f.location.pathname = `/chats/${id}`; f.openLocation(); }
  assert.equal(f.missing(), 2); assert.equal(f.selected.length, 2);
  f.location.pathname = '/'; f.openLocation(); assert.equal(f.selected.at(-1), null);
});

test('Back/Forward navigation waits for active work and applies only the final requested location', () => {
  const f = navigation('/chats/first'); f.openLocation(); f.lock(true);
  f.location.pathname = '/chats/second'; f.openLocation();
  assert.equal(f.selected.at(-1).id, 'first'); assert.equal(f.flush(), false);
  f.write(f.chats[0]); assert.equal(f.calls.length, 0);
  f.location.pathname = '/chats/missing'; f.openLocation();
  f.lock(false); assert.equal(f.flush(), true); assert.equal(f.missing(), 1);
  assert.equal(f.flush(), false); assert.equal(f.calls.length, 0);
});

test('automatic selection after deletion uses replacement history rather than pushing a new entry', () => {
  const f = navigation('/chats/deleted');
  f.write(f.chats[0], { replace: true });
  assert.equal(f.calls[0].method, 'replaceState'); assert.equal(f.location.pathname, '/chats/first');
});

test('chat URLs serve the app on direct entry and refresh, establish the session, and do not expose stored text in HTML', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-chat-urls-'));
  const store = new Store(directory);
  store.createChat({ id: 'saved', title: 'TITLE_FROM_DATABASE', model: '', effort: 'default', messages: [{ role: 'user', text: 'TEXT_FROM_DATABASE' }], input: [] });
  store.createChat({ id: 'archived', title: 'Archived fixture', archived: true, model: '', effort: 'default', messages: [], input: [] });
  const { server, origin } = await createHarness({ directory, auth: { status: () => ({ connected: false }) } });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  for (const id of ['saved', 'archived', 'missing']) {
    const page = await fetch(`${origin}/chats/${id}`), html = await page.text();
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(html, /src="\/app.js"/); assert.ok(!html.includes('FROM_DATABASE'));
    assert.equal(page.headers.get('cache-control'), 'no-store'); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const Cookie = page.headers.get('set-cookie').split(';')[0];
    const state = await fetch(origin + '/api/state', { headers: { Cookie } });
    assert.equal(state.status, 200); assert.equal((await state.json()).chats.length, 2);
    assert.equal((await fetch(origin + '/chats/invalid/extra', { headers: { Cookie } })).status, 404);
  }
  const script = await fetch(origin + '/chat-navigation.js'); assert.equal(script.status, 200);
});
