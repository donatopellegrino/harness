import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { ChatPayloads } from '../lib/chat-payloads.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-shared-context-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const text = 'Hello from the assistant. '.repeat(1000);
  const user = { role: 'user', content: 'Hello from me' };
  const reasoning = { id: 'rs1', type: 'reasoning', summary: [], encrypted_content: 'opaque-reasoning'.repeat(1000), future: { nullable: null } };
  const reply = { id: 'msg1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [{ type: 'future', value: false }] }] };
  const output = [reasoning, reply];
  const metadata = {
    request: { model: 'test', store: false },
    response: { id: 'r1', model: 'test', output, usage: { input_tokens: 12, output_tokens: 30 } },
    events: output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
  };
  const chat = { id: 'a', title: 'Shared test', messages: [{ role: 'user', text: user.content }, { role: 'assistant', text, metadata }], input: [user, ...output] };
  store.createChat(chat);
  return { directory, store, chat, user, reasoning, reply, metadata, text };
}

function copies(store, value) {
  return store.db.prepare(`
    SELECT count(*) AS count
    FROM chat_payloads
    WHERE kind = 'value'
      AND data = ?
  `).get(JSON.stringify(value)).count;
}

test('messages, metadata and active input share exact provider objects and message text', t => {
  const { store, chat, user, reasoning, text } = fixture(t);
  assert.deepEqual(store.getChat('a'), chat);
  assert.equal(copies(store, user.content), 1);
  assert.equal(copies(store, text), 1);
  assert.equal(copies(store, reasoning.encrypted_content), 1);
  const inputId = store.db.prepare("SELECT payload_id FROM chat_items WHERE chat_id='a' AND collection='input' AND ordinal=2").get().payload_id;
  const assistantId = store.db.prepare("SELECT payload_id FROM chat_items WHERE chat_id='a' AND collection='messages' AND ordinal=1").get().payload_id;
  const reader = store.payloads.reader('a');
  assert.equal(reader.path(assistantId, ['metadata', 'response', 'output', 1]), reader.get(inputId));
  assert.equal(reader.path(assistantId, ['metadata', 'events', 1, 'item']), reader.get(inputId));
  assert.deepEqual(store.listChatsForDisplay()[0].messages, [
    { role: 'user', text: user.content },
    { role: 'assistant', text, metadata: { response: { model: 'test', usage: { input_tokens: 12, output_tokens: 30 } }, request: { model: 'test' } } },
  ]);
  assert.deepEqual(store.listChats(), [chat]);
});

test('compaction archives reference old input, preserve full messages, and replay the checkpoint in order after restart', t => {
  const { store, directory, chat, text, reasoning } = fixture(t);
  const checkpoint = { type: 'compaction', encrypted_content: 'opaque-checkpoint'.repeat(1000), id: 'cp1' };
  const updated = { ...chat, input: [checkpoint], compactions: [{ previous_input: chat.input, mode: 'manual', metadata: { response: { output: [checkpoint] } } }] };
  store.updateChat('a', { input: updated.input, compactions: updated.compactions });
  assert.deepEqual(store.getChat('a'), updated);
  assert.equal(copies(store, text), 1);
  assert.equal(copies(store, reasoning.encrypted_content), 1);
  assert.equal(copies(store, checkpoint.encrypted_content), 1);
  const next = { role: 'user', content: 'Second question' };
  store.updateChat('a', { input: [checkpoint, next] });
  store.close();
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.getChat('a').input, [checkpoint, next]);
    assert.deepEqual(reopened.getChat('a').messages, chat.messages);
    assert.deepEqual(reopened.getChat('a').compactions, updated.compactions);
  } finally { reopened.close(); }
});

test('unknown provider fields cannot collide with internal references; edits collect only unreachable records', t => {
  const { store, chat, text } = fixture(t);
  const strange = JSON.parse('{"ref":"pretend-id","$ref":123,"$literal":{"$ref":456},"__proto__":{"keep":true},"pair":[1,"pretend-id"],"content":"","null":null,"false":false,"zero":0}');
  store.updateChat('a', { failedAttempts: [{ metadata: strange }] });
  assert.deepEqual(store.getChat('a').failedAttempts[0].metadata, strange);
  // Drop the active context, but metadata and visible messages still own text.
  store.updateChat('a', { input: [] });
  assert.equal(copies(store, text), 1);
  const stale = 'Temporary failure details'.repeat(1000);
  store.updateChat('a', { failedAttempts: [{ text: stale, metadata: { item: chat.input[2] } }] });
  assert.equal(copies(store, stale), 1);
  const oldId = store.db.prepare('SELECT id FROM chat_payloads WHERE kind=? AND data=?').get('value', JSON.stringify(stale)).id;
  store.updateChat('a', { failedAttempts: [{ metadata: { ref: oldId, $ref: oldId } }] });
  assert.equal(store.getChat('a').failedAttempts[0].metadata.ref, oldId);
  assert.equal(store.getChat('a').failedAttempts[0].metadata.$ref, oldId);
  assert.equal(copies(store, stale), 0); // A provider's literal ref is not an internal reference.
  store.updateChat('a', { failedAttempts: [] });
  assert.equal(copies(store, stale), 0);
  assert.equal(copies(store, text), 1);
  store.updateChat('a', { messages: [] });
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM chat_payloads').get().count, 0);
});

function downgradeToV1(store) {
  const decoded = store.listChats();
  store.transaction(() => {
    store.db.exec(`
      DROP TABLE chat_items;
      DROP TABLE chat_payloads;
      CREATE TABLE chat_items (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        collection TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data)),
        PRIMARY KEY (chat_id, collection, ordinal)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    const insert = store.db.prepare('INSERT INTO chat_items VALUES (?, ?, ?, ?)');
    for (const chat of decoded) for (const key of ['messages', 'input', 'compactions', 'failedAttempts']) {
      chat[key]?.forEach((item, index) => insert.run(chat.id, key, index, JSON.stringify(item)));
    }
  });
  store.close();
}

test('SQLite v1 upgrade verifies every decoded item, preserves private state and backup, and is idempotent', t => {
  const { store, directory, chat, text } = fixture(t);
  store.setState('auth', { access_token: 'fixture-secret' });
  store.createFolder({ id: 'f', name: 'Nested', parentId: null });
  // Restoring a fully migrated database need not include its historical backup.
  store.db.prepare('INSERT INTO migrations (version, data, backup_complete) VALUES (1, ?, 1)').run(JSON.stringify({
    manifest: [], backupFile: 'missing-old-migration-snapshot.sqlite', chats: 1, messages: 2, folders: 1,
  }));
  downgradeToV1(store);
  assert.throws(() => new Store(directory), /schema upgrade required/);
  const upgraded = new Store(directory, { migrateLegacy: true });
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(upgraded.migration.status, 'already migrated');
    assert.deepEqual(upgraded.getChat('a'), chat);
    assert.equal(copies(upgraded, text), 1);
    assert.deepEqual(upgraded.getState('auth'), { access_token: 'fixture-secret' });
    assert.deepEqual(upgraded.listFolders(), [{ id: 'f', name: 'Nested', parentId: null }]);
    assert.equal(statSync(upgraded.schemaUpgrade.backup).mode & 0o777, 0o600);
    const backup = new DatabaseSync(upgraded.schemaUpgrade.backup, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(JSON.parse(backup.prepare("SELECT data FROM chat_items WHERE collection='messages' AND ordinal=1").get().data), chat.messages[1]);
    } finally { backup.close(); }
    assert.equal(readdirSync(directory).some(name => /\.jsonl?$/.test(name)), false);
  } finally { upgraded.close(); }
  const again = new Store(directory, { migrateLegacy: true });
  try {
    assert.equal(again.schemaUpgrade, undefined);
    assert.deepEqual(again.getChat('a'), chat);
  } finally { again.close(); }
});

test('failed SQLite schema conversion rolls back every table and leaves the verified original backup', t => {
  const { store, directory, chat } = fixture(t);
  downgradeToV1(store);
  const original = ChatPayloads.prototype.writer;
  ChatPayloads.prototype.writer = function(id) {
    const put = original.call(this, id);
    let count = 0;
    return value => {
      const result = put(value);
      if (++count === 3) throw new Error('Synthetic failure during conversion');
      return result;
    };
  };
  try { assert.throws(() => new Store(directory, { migrateLegacy: true }), /during conversion/); }
  finally { ChatPayloads.prototype.writer = original; }
  const after = new DatabaseSync(join(directory, 'storage.sqlite'));
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(after.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='chat_payloads'").get().count, 0);
    assert.deepEqual(JSON.parse(after.prepare("SELECT data FROM chat_items WHERE collection='messages' AND ordinal=1").get().data), chat.messages[1]);
    assert.equal(readdirSync(directory).filter(name => name.startsWith('storage.context-backup-')).length, 1);
  } finally { after.close(); }
  const retry = new Store(directory, { migrateLegacy: true });
  try { assert.deepEqual(retry.getChat('a'), chat); }
  finally { retry.close(); }
});

test('shared records stay scoped to their chat and deleting one chat cannot remove another chat context', t => {
  const { store, chat } = fixture(t);
  store.createChat({ ...chat, id: 'b' });
  store.db.prepare('DELETE FROM chats WHERE id = ?').run('a');
  assert.deepEqual(store.getChat('b'), { ...chat, id: 'b' });
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM chat_payloads WHERE chat_id='a'").get().count, 0);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
