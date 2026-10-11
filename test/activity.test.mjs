import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { createHarness } from '../server.mjs';
import { folderActivityCounts } from '../public/activity.js';

const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply' }] };
const sse = event => new Response(`data: ${JSON.stringify(event)}\n\n`);

test('activity follows reply and compaction lifecycle, clears after errors, and requires the normal session protections', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-activity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  store.write('chats.json', [{ id: 'chat', title: 'Existing', model: 'gpt-6.1-sol', effort: 'high', input: [{ role: 'user', content: 'Remember this' }, answer], messages: [{ role: 'user', text: 'Remember this' }, { role: 'assistant', text: 'Reply' }] }]);
  let release;
  const app = await createHarness({ directory, auth: { status: () => ({}), accessToken: async () => 'fixture-token' }, fetcher: async url => {
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', supported_reasoning_efforts: ['high'] }] });
    return new Promise(resolve => { release = resolve; });
  } });
  t.after(() => { app.server.close(); app.server.closeAllConnections(); });
  const page = await fetch(app.origin); await page.text();
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const call = (path, method = 'GET', body) => fetch(app.origin + path, { method, headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(app.origin + '/api/activity')).status, 403);
  assert.equal((await fetch(app.origin + '/api/activity', { headers: { Cookie: cookie, Origin: 'https://other.example' } })).status, 403);
  let revision = 0;
  for (const mode of ['replying', 'compacting', 'failure']) {
    const stream = await call(`/api/chats/chat/${mode === 'compacting' ? 'compact' : 'messages'}`, 'POST', mode === 'compacting' ? {} : { text: 'Continue' });
    const status = await (await call('/api/activity')).json();
    assert.equal(status.chats[0].activity, mode === 'compacting' ? 'compacting' : 'replying');
    assert.ok(status.revision > revision);
    assert.deepEqual(Object.keys(status.chats[0]).sort(), ['activity', 'id']);
    assert.equal((await (await call('/api/state')).json()).activity.chats[0].activity, status.chats[0].activity);
    release(mode === 'failure' ? Response.json({ error: { message: 'Synthetic failure' } }, { status: 500 }) : sse({ type: 'response.completed', response: { status: 'completed', output: mode === 'compacting' ? [{ type: 'compaction', encrypted_content: 'synthetic-checkpoint' }, answer] : [answer] } }));
    const events = (await stream.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, mode === 'failure' ? 'error' : 'done');
    const after = await (await call('/api/activity')).json();
    assert.equal(after.chats[0].activity, null); assert.ok(after.revision > status.revision); revision = after.revision;
    assert.equal(store.read('chats.json')[0].activity, undefined);
  }
});

test('activity counts reach every ancestor once, include collapsed descendants, and clear when work ends', () => {
  const folders = [{ id: 'parent', parentId: null }, { id: 'child', parentId: 'parent' }, { id: 'nested', parentId: 'child' }, { id: 'unrelated', parentId: null }];
  const chats = [{ id: 'a', folderId: 'nested' }, { id: 'b', folderId: 'child' }, { id: 'c', folderId: null }, { id: 'idle', folderId: 'unrelated' }];
  const counts = folderActivityCounts(folders, chats, new Map([['a', 'replying'], ['b', 'compacting'], ['c', 'replying']]));
  assert.equal(counts.get('parent'), 2); assert.equal(counts.get('child'), 2); assert.equal(counts.get('nested'), 1); assert.equal(counts.has('unrelated'), false);
  assert.equal(folderActivityCounts(folders, chats, new Map()).size, 0);
  assert.equal(folderActivityCounts([{ id: 'loop', parentId: 'loop' }], [{ id: 'a', folderId: 'loop' }], new Map([['a', 'replying']])).get('loop'), 1);
});
