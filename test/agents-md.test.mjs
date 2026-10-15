import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { createHarness } from '../server.mjs';
import { agentsInstructions, MAX_AGENTS_MD_LENGTH } from '../lib/agents-md.mjs';

const complete = (checkpoint = false) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
  ...(checkpoint ? [{ type: 'compaction', encrypted_content: 'opaque-checkpoint' }] : []),
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture reply' }] },
] } })}\n\n`);

async function fixture(t, respond = () => complete()) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-agents-'));
  const store = new Store(directory), sent = [];
  for (const [id, parentId] of [['parent', null], ['child', 'parent'], ['grandchild', 'child'], ['sibling', 'parent'], ['empty', 'parent']])
    store.createFolder({ id, name: id, parentId });
  for (const folderId of [null, 'parent', 'child', 'grandchild', 'sibling', 'empty']) store.createChat({
    id: folderId ?? 'root', title: 'Existing chat', folderId, model: 'gpt-6.1-sol', effort: 'high', messages: [], input: [],
  });
  const auth = { status: () => ({ connected: false }), accessToken: async () => 'fixture-token' };
  const fetcher = async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', supported_reasoning_efforts: ['high'], max_context_window: 872000 }] });
    const request = JSON.parse(options.body); sent.push(request); return respond(request);
  };
  const app = await createHarness({ directory, auth, fetcher });
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const page = await fetch(app.origin); await page.text();
  const headers = { Cookie: page.headers.get('set-cookie').split(';')[0], Origin: app.origin, 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body) => fetch(app.origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const save = (folderId, content, revision = 0) => call(folderId === null ? '/api/agents-md/global' : `/api/folders/${folderId}/agents-md`, 'PUT', { content, revision });
  const turn = async (id, compact = false) => {
    const response = await call(`/api/chats/${id}/${compact ? 'compact' : 'messages'}`, 'POST', compact ? {} : { text: 'Continue' });
    assert.equal(response.status, 200);
    return (await response.text()).trim().split('\n').map(JSON.parse);
  };
  return { directory, store, app, call, save, turn, sent, headers };
}

test('model requests get exactly global plus immediate folder instructions, never ancestors, descendants or siblings', async t => {
  const f = await fixture(t);
  for (const scope of [null, 'parent', 'child', 'grandchild', 'sibling'])
    assert.equal((await f.save(scope, `RULE_${scope ?? 'GLOBAL'}_ONLY`)).status, 200);
  for (const id of ['root', 'parent', 'child', 'grandchild', 'sibling', 'empty']) {
    assert.equal((await f.turn(id)).at(-1).type, 'done');
    const request = f.sent.at(-1);
    assert.ok(request.instructions.includes('RULE_GLOBAL_ONLY'));
    for (const folder of ['parent', 'child', 'grandchild', 'sibling'])
      assert.equal(request.instructions.includes(`RULE_${folder}_ONLY`), id === folder, `${id} must not inherit ${folder}`);
    assert.equal(request.input.length, 1); assert.deepEqual(request.input[0], { role: 'user', content: 'Continue' });
  }
  // The ordinary browser state is not an instruction-file catalog.
  assert.equal(JSON.stringify(await (await f.call('/api/state')).json()).includes('RULE_'), false);
});

test('empty scopes do not inherit parents, and no instructions parameter is sent when both applicable scopes are empty', async t => {
  const f = await fixture(t);
  await f.save('parent', 'PARENT_RULE_NOT_INHERITED');
  await f.turn('child'); assert.equal(f.sent.at(-1).instructions, undefined);
  await f.save('child', 'DIRECT_RULE');
  await f.turn('child'); assert.ok(f.sent.at(-1).instructions.includes('DIRECT_RULE')); assert.ok(!f.sent.at(-1).instructions.includes('PARENT_RULE'));
  await f.save('child', '', 1);
  await f.turn('child'); assert.equal(f.sent.at(-1).instructions, undefined);
  assert.equal((await (await f.call('/api/folders/child/agents-md')).json()).revision, 2);
  assert.equal(agentsInstructions([{ folderId: null, content: '\n  ' }]), undefined);
});

test('instruction edits persist in SQLite and conflict checks preserve the saved version and existing conversations', async t => {
  const f = await fixture(t), before = f.store.listChats();
  const empty = await (await f.call('/api/agents-md/global')).json();
  assert.deepEqual(empty, { folderId: null, content: '', revision: 0, updatedAt: null });
  const content = '# Rules\n\nUse concise explanations.\n';
  const saved = await (await f.save(null, content)).json();
  assert.equal(saved.content, content); assert.equal(saved.revision, 1); assert.ok(saved.updatedAt);
  assert.equal((await f.save(null, 'Stale replacement', 0)).status, 409);
  const reopened = new Store(f.directory);
  try {
    assert.deepEqual(reopened.getAgentsMd(), saved);
    assert.deepEqual(reopened.listChats(), before);
    assert.equal(reopened.db.prepare('SELECT content FROM agents_md WHERE scope = ?').get('global').content, content);
  } finally { reopened.close(); }
  assert.equal((await f.save('child', 'Own rules')).status, 200);
  assert.equal((await f.save(null, '', 1)).status, 200);
  assert.equal(f.store.getAgentsMd('child').content, 'Own rules');
  assert.equal((await f.call('/api/chats/child', 'DELETE', { confirmed: true })).status, 200);
  assert.equal(f.store.getAgentsMd('child').content, 'Own rules');
});

test('editor endpoints validate requests and enforce session/origin and existing-folder boundaries', async t => {
  const f = await fixture(t);
  for (const body of [{ content: 12, revision: 0 }, { content: 'x' }, { content: 'x', revision: -1 }, { content: 'x', revision: 0.5 }, { content: 'x'.repeat(MAX_AGENTS_MD_LENGTH + 1), revision: 0 }, []])
    assert.equal((await f.call('/api/agents-md/global', 'PUT', body)).status, 400);
  assert.equal((await f.call('/api/folders/missing/agents-md')).status, 404);
  assert.equal((await f.save('missing', 'No orphan')).status, 404);
  assert.equal((await f.call('/api/agents-md/global', 'POST', {})).status, 405);
  assert.equal((await fetch(f.app.origin + '/api/agents-md/global')).status, 403);
  assert.equal((await fetch(f.app.origin + '/api/agents-md/global', { method: 'PUT', headers: { ...f.headers, Origin: 'https://other.example' }, body: '{"content":"x","revision":0}' })).status, 403);
  assert.equal(f.store.getAgentsMd().revision, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agents_md').get().n, 0);
});

test('fresh instructions apply after automatic and manual compaction without becoming visible messages or replay input', async t => {
  const f = await fixture(t, () => complete(true));
  await f.save(null, 'GLOBAL_OLD_RULE'); await f.save('child', 'CHILD_OLD_RULE');
  await f.turn('child');
  let chat = f.store.getChat('child');
  assert.equal(chat.messages.length, 2); assert.equal(chat.input[0].type, 'compaction');
  const first = chat.messages.at(-1).metadata;
  assert.equal(first.request.instructions, f.sent[0].instructions);
  assert.deepEqual(first.agents_md.map(({ folderId, revision }) => ({ folderId, revision })), [{ folderId: null, revision: 1 }, { folderId: 'child', revision: 1 }]);
  await f.save(null, 'GLOBAL_NEW_RULE', 1); await f.save('child', 'CHILD_NEW_RULE', 1);
  await f.turn('child', true);
  assert.ok(f.sent[1].instructions.includes('GLOBAL_NEW_RULE')); assert.ok(f.sent[1].instructions.includes('CHILD_NEW_RULE'));
  assert.ok(!f.sent[1].instructions.includes('OLD_RULE'));
  chat = f.store.getChat('child');
  assert.equal(chat.messages.length, 2); assert.equal(chat.input.length, 1);
  assert.equal(JSON.stringify(chat.input).includes('RULE'), false);
  assert.equal(chat.compactions.at(-1).metadata.request.instructions, f.sent[1].instructions);
  assert.equal(chat.compactions.at(-1).metadata.agents_md[1].revision, 2);
  await f.turn('child');
  assert.equal(f.sent[2].input[0].type, 'compaction'); assert.equal(f.sent[2].instructions, f.sent[1].instructions);
  assert.equal(f.store.getChat('child').messages[1].metadata.request.instructions, first.request.instructions);
  const readable = await (await f.call('/api/chats/child/messages/1/metadata')).json();
  assert.equal(readable.metadata.request.instructions, first.request.instructions);
});

test('an in-flight request keeps its snapshot while edits apply to subsequent requests', async t => {
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  let count = 0;
  const f = await fixture(t, async () => { if (!count++) { started(); await held; } return complete(); });
  await f.save(null, 'BEFORE_EDIT');
  const pending = f.turn('child'); await ready;
  try { assert.equal((await f.save(null, 'AFTER_EDIT', 1)).status, 200); }
  finally { release(); }
  assert.equal((await pending).at(-1).type, 'done');
  const saved = f.store.getChat('child').messages[1].metadata;
  assert.ok(saved.request.instructions.includes('BEFORE_EDIT')); assert.equal(saved.agents_md[0].revision, 1);
  await f.turn('child'); assert.ok(f.sent[1].instructions.includes('AFTER_EDIT')); assert.ok(!f.sent[1].instructions.includes('BEFORE_EDIT'));
});

test('existing format-3 databases gain empty instruction storage without changing saved chats or hierarchy', async t => {
  const f = await fixture(t), chats = f.store.listChats(), folders = f.store.listFolders();
  f.store.db.exec('DROP TABLE agents_md');
  const reopened = new Store(f.directory);
  try {
    assert.deepEqual(reopened.listChats(), chats); assert.deepEqual(reopened.listFolders(), folders);
    assert.equal(reopened.getAgentsMd().revision, 0);
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.throws(() => reopened.saveAgentsMd('missing', 'Orphan', 0), /FOREIGN KEY/);
  } finally { reopened.close(); }
});
