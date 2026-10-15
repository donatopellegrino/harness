import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'harness-sqlite-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function open(t, path, options) {
  const store = new Store(path, options);
  t.after(() => store.close());
  return store;
}
const chat = (id = 'chat') => ({ id, title: 'Original', model: 'test', effort: 'high', messages: [], input: [] });
function legacy(path) {
  const folders = [{ id: 'child', name: 'Nested', parentId: 'parent', future: null }, { id: 'parent', name: 'Root', parentId: null }];
  const chats = [{
    ...chat(), folderId: 'child', titleEdited: true, organizationVersion: 4, future_header: { enabled: false },
    messages: [
      { role: 'user', text: 'Saved question', metadata: { request: { model: 'test', store: false } } },
      { role: 'assistant', text: 'Saved answer', metadata: { response: { id: 'r1', unknown: null }, events: [{ type: 'future.event', values: [0, null, false] }] } },
    ],
    input: [{ type: 'compaction', encrypted_content: 'opaque-checkpoint' }, { type: 'reasoning', encrypted_content: 'opaque-reasoning' }],
    compactions: [{ previous_input: [{ role: 'user', content: 'Old input' }], metadata: { future: 'keep' } }],
    failedAttempts: [{ text: 'Failed question', error: 'Synthetic failure', metadata: { events: [] } }],
  }, { ...chat('older'), compactions: null, failedAttempts: null }];
  const values = { 'chats.json': chats, 'folders.json': folders, 'auth.json': { access_token: 'fixture-access', refresh_token: 'fixture-refresh', client_id: 'fixture-client' },
    'host.json': { id: 'fixture-host' }, 'probe-results.json': { data: [1, 2, null], extra: false } };
  for (const [name, value] of Object.entries(values)) writeFileSync(join(path, name), JSON.stringify(value));
  return values;
}

test('migration preserves all legacy data and ordering, creates a verified SQLite backup, removes JSON files, and resumes cleanup without replaying old state', t => {
  const path = directory(t), values = legacy(path);
  assert.throws(() => new Store(path), /Stop the server/);
  const store = open(t, path, { migrateLegacy: true });
  assert.deepEqual(store.listChats(), values['chats.json']);
  assert.deepEqual(store.listFolders(), values['folders.json']);
  assert.deepEqual(store.getState('auth'), values['auth.json']);
  assert.deepEqual(store.getState('host'), values['host.json']);
  assert.deepEqual(store.getState('legacy/probe-results.json'), values['probe-results.json']);
  assert.equal(readdirSync(path).some(name => name.endsWith('.json')), false);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.equal(statSync(store.migration.backup).mode & 0o777, 0o600);
  assert.equal(statSync(path).mode & 0o777, 0o700);
  const backup = new DatabaseSync(store.migration.backup, { readOnly: true });
  assert.equal(backup.prepare('SELECT count(*) AS count FROM chats').get().count, 2);
  assert.equal(backup.prepare('SELECT data FROM app_state WHERE key=?').get('auth').data, JSON.stringify(values['auth.json']));
  backup.close();
  store.updateChat('chat', { title: 'Newer title' });
  // Emulate interruption before the final source file was removed.
  writeFileSync(join(path, 'chats.json'), JSON.stringify(values['chats.json']));
  store.close();
  const reopened = open(t, path, { migrateLegacy: true });
  assert.equal(reopened.getChat('chat').title, 'Newer title');
  assert.equal(reopened.listChats().length, 2);
  assert.equal(readdirSync(path).some(name => name.endsWith('.json')), false);
  assert.equal(open(t, path, { migrateLegacy: true }).migration.status, 'already migrated');
});

test('a committed import recovers an interrupted or partial backup before removing source files', t => {
  const path = directory(t), values = legacy(path), first = open(t, path, { migrateLegacy: true });
  const backupPath = first.migration.backup;
  first.db.exec('UPDATE migrations SET backup_complete=0');
  first.close();
  unlinkSync(backupPath); writeFileSync(backupPath, 'partial backup');
  for (const [name, value] of Object.entries(values)) writeFileSync(join(path, name), JSON.stringify(value));
  const recovered = open(t, path, { migrateLegacy: true });
  assert.deepEqual(recovered.listChats(), values['chats.json']);
  assert.equal(readdirSync(path).some(name => name.endsWith('.json')), false);
  assert.equal(readFileSync(backupPath).subarray(0, 16).toString(), 'SQLite format 3\0');
});

test('changed legacy data and new legacy files are never silently deleted or reimported', t => {
  const path = directory(t), values = legacy(path), first = open(t, path, { migrateLegacy: true });
  first.close();
  writeFileSync(join(path, 'chats.json'), JSON.stringify([{ ...chat(), title: 'Changed source' }]));
  assert.throws(() => new Store(path, { migrateLegacy: true }), /changed after import/);
  assert.equal(JSON.parse(readFileSync(join(path, 'chats.json')))[0].title, 'Changed source');
  writeFileSync(join(path, 'chats.json'), JSON.stringify(values['chats.json']));
  writeFileSync(join(path, 'unexpected.json'), '{"new":true}');
  assert.throws(() => new Store(path, { migrateLegacy: true }), /changed after import/);
  assert.equal(readdirSync(path).filter(name => name.endsWith('.json')).length, 2);
});

test('invalid JSON, invalid collections and an existing SQLite store leave sources intact and imports atomic', async t => {
  for (const mode of ['malformed', 'null', 'duplicate', 'orphan', 'populated']) await t.test(mode, t => {
    const path = directory(t), values = legacy(path);
    if (mode === 'malformed') writeFileSync(join(path, 'auth.json'), '{"secret":"fixture');
    if (mode === 'null') writeFileSync(join(path, 'chats.json'), 'null');
    if (mode === 'duplicate') writeFileSync(join(path, 'chats.json'), JSON.stringify([chat(), chat()]));
    if (mode === 'orphan') writeFileSync(join(path, 'chats.json'), JSON.stringify([{ ...chat(), folderId: 'missing' }]));
    if (mode === 'populated') {
      for (const name of Object.keys(values)) unlinkSync(join(path, name));
      const store = open(t, path); store.createChat(chat('existing')); store.close();
      for (const [name, value] of Object.entries(values)) writeFileSync(join(path, name), JSON.stringify(value));
    }
    assert.throws(() => new Store(path, { migrateLegacy: true }));
    assert.equal(readdirSync(path).filter(name => name.endsWith('.json')).length, Object.keys(values).length);
    const db = new DatabaseSync(join(path, 'storage.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS count FROM chats').get().count, mode === 'populated' ? 1 : 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM migrations').get().count, 0);
    db.close();
  });
});

test('chat updates are transactional across messages, active context, header fields and archives; disk-full failure remains retryable', t => {
  const path = directory(t), store = open(t, path);
  store.createChat(chat());
  const original = store.getChat('chat');
  // A deferred FK violation happens at COMMIT, after item updates were executed.
  store.db.exec(`
    CREATE TRIGGER invalid_context_reference AFTER UPDATE ON chats BEGIN
      UPDATE chat_items SET payload_id = -1 WHERE chat_id = NEW.id AND collection = 'input';
    END;
  `);
  assert.throws(() => store.updateChat('chat', { title: 'Unsaved', messages: [{ role: 'user', text: 'Unsaved' }], input: [{ role: 'user', content: 'Unsaved' }], compactions: [{ previous_input: [] }] }), /FOREIGN KEY/);
  store.db.exec('DROP TRIGGER invalid_context_reference');
  assert.deepEqual(store.getChat('chat'), original);
  const limit = store.db.prepare('PRAGMA page_count').get().page_count;
  store.db.exec('PRAGMA max_page_count=' + limit);
  assert.throws(() => store.updateChat('chat', { messages: [{ role: 'assistant', text: 'x'.repeat(2000000) }] }), /full/i);
  assert.deepEqual(store.getChat('chat'), original);
  store.db.exec('PRAGMA max_page_count=1000000');
  store.updateChat('chat', { messages: [{ role: 'assistant', text: 'Saved' }], input: [{ role: 'assistant', content: 'Saved' }] });
  assert.equal(store.getChat('chat').messages[0].text, 'Saved');
  assert.equal(readdirSync(path).some(name => name.endsWith('.json')), false);
});

test('independent connections patch current chat state without overwriting other fields or unrelated histories', t => {
  const path = directory(t), one = open(t, path), two = open(t, path);
  one.createChat(chat('a')); one.createChat(chat('b'));
  one.updateChat('a', { title: 'Renamed' });
  two.updateChat('a', { model: 'new-model', messages: [{ role: 'assistant', text: 'Saved' }] });
  assert.equal(one.getChat('a').title, 'Renamed');
  assert.equal(one.getChat('a').model, 'new-model');
  assert.deepEqual(one.getChat('b').messages, []);
  assert.deepEqual(one.listChatHeaders()[1].messages, []);
});

test('migration command refuses to touch legacy files while the backend port is occupied', async t => {
  const path = directory(t); legacy(path);
  const guard = createServer(); await new Promise(resolve => guard.listen(0, '127.0.0.1', resolve));
  t.after(() => guard.close());
  const result = spawnSync(process.execPath, ['scripts/migrate-storage.mjs', path], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(guard.address().port) }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Stop the running harness/);
  assert.equal(readdirSync(path).filter(name => name.endsWith('.json')).length, 5);
  assert.equal(readdirSync(path).some(name => name.endsWith('.sqlite')), false);
});

test('fixed parentage survives reopen and blocks both storage updates and direct SQL column/header changes', t => {
  const path = directory(t), store = open(t, path);
  store.createFolder({ id: 'a', name: 'A', parentId: null });
  store.createFolder({ id: 'b', name: 'B', parentId: null });
  store.createFolder({ id: 'child', name: 'Child', parentId: 'a' });
  store.createChat(chat('root'));
  store.createChat({ ...chat('nested'), folderId: 'a' });
  const before = store.listChats(), folders = store.listFolders();
  for (const id of ['root', 'nested']) for (const folderId of [null, 'a', 'b']) {
    const current = store.getChat(id);
    if ((current.folderId ?? null) === folderId) continue;
    assert.throws(() => store.updateChat(id, { folderId, title: 'Not saved', messages: [{ role: 'user', text: 'Not saved' }] }), /fixed at creation/);
    assert.throws(() => store.db.prepare('UPDATE chats SET folder_id = ? WHERE id = ?').run(folderId, id), /fixed at creation/);
    assert.throws(() => store.db.prepare("UPDATE chats SET data = json_set(data, '$.folderId', ?) WHERE id = ?").run(folderId, id), /fixed at creation/);
  }
  assert.throws(() => store.updateFolder('child', { parentId: 'b', name: 'Not saved' }), /fixed at creation/);
  assert.throws(() => store.db.prepare("UPDATE folders SET parent_id = NULL WHERE id = 'child'").run(), /fixed at creation/);
  assert.throws(() => store.db.prepare("UPDATE folders SET data = json_set(data, '$.parentId', NULL) WHERE id = 'child'").run(), /fixed at creation/);
  assert.deepEqual(store.listChats(), before); assert.deepEqual(store.listFolders(), folders);
  // Older installations have the same tables but lack these protections.
  store.db.exec('DROP TRIGGER chats_keep_container; DROP TRIGGER folders_keep_parent;');
  const reopened = open(t, path);
  assert.deepEqual(reopened.listChats(), before); assert.deepEqual(reopened.listFolders(), folders);
  assert.throws(() => reopened.db.prepare("UPDATE chats SET folder_id = 'b' WHERE id = 'root'").run(), /fixed at creation/);
  assert.throws(() => reopened.db.prepare("UPDATE folders SET parent_id = 'b' WHERE id = 'child'").run(), /fixed at creation/);
  reopened.updateChat('nested', { title: 'Renamed', archived: true });
  reopened.updateChat('nested', { archived: false });
  assert.equal(reopened.getChat('nested').folderId, 'a');
});
