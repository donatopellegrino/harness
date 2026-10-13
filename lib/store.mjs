import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { folderParent } from './folders.mjs';
import { ChatPayloads } from './chat-payloads.mjs';

const collections = ['messages', 'input', 'compactions', 'failedAttempts'];
const encode = value => {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Storage values must be serializable.');
  return result;
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const chatPayloadSchema = `
  CREATE TABLE IF NOT EXISTS chat_payloads (
    chat_id TEXT NOT NULL
      REFERENCES chats (id)
      ON DELETE CASCADE,
    id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('object', 'array', 'value')),
    data TEXT NOT NULL CHECK (json_valid(data)),
    UNIQUE (chat_id, id),
    UNIQUE (chat_id, fingerprint)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS chat_items (
    chat_id TEXT NOT NULL
      REFERENCES chats (id)
      ON DELETE CASCADE,
    collection TEXT NOT NULL CHECK (
      collection IN (
        'messages',
        'input',
        'compactions',
        'failedAttempts'
      )
    ),
    ordinal INTEGER NOT NULL,
    payload_id INTEGER NOT NULL,
    PRIMARY KEY (chat_id, collection, ordinal),
    FOREIGN KEY (chat_id, payload_id)
      REFERENCES chat_payloads (chat_id, id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
`;

export class Store {
  constructor(directory, { migrateLegacy = false } = {}) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    let legacy = this.legacyFiles();
    if (legacy.length && !migrateLegacy) throw new Error('Legacy JSON storage found. Stop the server and run npm run migrate before starting this version.');
    this.path = join(directory, 'storage.sqlite');
    if (!existsSync(this.path)) writeFileSync(this.path, '', { flag: 'wx', mode: 0o600 });
    if (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink()) throw new Error('Storage database must be a regular file.');
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
      `);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 3) throw new Error('Storage database was created by a newer harness version.');
      if (version === 1) {
        if (!migrateLegacy) throw new Error('Storage schema upgrade required. Stop the server and run npm run migrate before starting this version.');
        this.schemaUpgrade = this.upgradePayloads();
      }
      if (version === 2) {
        if (!migrateLegacy) throw new Error('Storage format upgrade required. Stop the server and run npm run migrate before starting this version.');
        this.payloads = new ChatPayloads(this.db);
        // Complete any interrupted JSON cleanup before changing its snapshot.
        this.migration = this.migrateLegacy(legacy);
        legacy = [];
        this.schemaUpgrade = this.upgradeEvents();
      }
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            position INTEGER NOT NULL,
            parent_id TEXT
              REFERENCES folders (id)
              DEFERRABLE INITIALLY DEFERRED,
            data TEXT NOT NULL CHECK (json_valid(data))
          ) STRICT;

          CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            position INTEGER NOT NULL,
            folder_id TEXT
              REFERENCES folders (id)
              DEFERRABLE INITIALLY DEFERRED,
            data TEXT NOT NULL CHECK (json_valid(data))
          ) STRICT;

          CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            data TEXT NOT NULL CHECK (json_valid(data))
          ) STRICT;

          CREATE TABLE IF NOT EXISTS migrations (
            version INTEGER PRIMARY KEY,
            data TEXT NOT NULL CHECK (json_valid(data)),
            backup_complete INTEGER NOT NULL DEFAULT 0
          ) STRICT;

          CREATE INDEX IF NOT EXISTS chats_by_folder
            ON chats (folder_id, position DESC);

          CREATE INDEX IF NOT EXISTS folders_by_parent
            ON folders (parent_id, position);
        `);
        this.db.exec(chatPayloadSchema);
        this.db.exec('PRAGMA user_version = 3');
      });
      this.payloads = new ChatPayloads(this.db);
      if (migrateLegacy && !this.migration) this.migration = this.migrateLegacy(legacy);
    } catch (error) { this.close(); throw error; }
  }
  upgradePayloads() {
    const pending = this.db.prepare(`
      SELECT backup_complete
      FROM migrations
      WHERE version = 1
    `).get();
    if (pending && !pending.backup_complete) throw new Error('Finish the earlier storage migration with the previous version before upgrading the schema.');
    const backupPath = this.schemaBackup('context', false);
    let count = 0;
    this.transaction(() => {
      this.db.exec('ALTER TABLE chat_items RENAME TO chat_items_v1');
      this.db.exec(chatPayloadSchema);
      const payloads = new ChatPayloads(this.db);
      const insert = this.db.prepare(`
        INSERT INTO chat_items (chat_id, collection, ordinal, payload_id)
        VALUES (?, ?, ?, ?)
      `);
      for (const chat of this.db.prepare('SELECT id FROM chats').all()) {
        const put = payloads.writer(chat.id), read = payloads.reader(chat.id);
        for (const item of this.db.prepare(`
          SELECT collection, ordinal, data
          FROM chat_items_v1
          WHERE chat_id = ?
          ORDER BY collection, ordinal
        `).all(chat.id)) {
          const original = JSON.parse(item.data), id = put(original);
          insert.run(chat.id, item.collection, item.ordinal, id);
          if (!isDeepStrictEqual(read.get(id), original)) throw new Error('Schema upgrade changed a saved chat item.');
          count++;
        }
      }
      if (count !== this.db.prepare('SELECT count(*) AS count FROM chat_items_v1').get().count) throw new Error('Schema upgrade lost saved chat items.');
      this.db.exec('DROP TABLE chat_items_v1');
      this.recordUpgrade(backupPath, count, 1);
    });
    this.db.exec('VACUUM');
    return { items: count, backup: backupPath };
  }
  schemaBackup(prefix, sharedPayloads = true) {
    const backupPath = join(this.directory, 'storage.' + prefix + '-backup-' + randomUUID() + '.sqlite');
    writeFileSync(backupPath, '', { flag: 'wx', mode: 0o600 });
    this.db.prepare('VACUUM INTO ?').run(backupPath);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Schema upgrade backup verification failed.');
      const tables = [['chats', 'id'], ['folders', 'id'], ['chat_items', 'chat_id,collection,ordinal'], ['app_state', 'key'], ['migrations', 'version']];
      if (sharedPayloads) tables.push(['chat_payloads', 'chat_id,id']);
      for (const [table, order] of tables) {
        const query = 'SELECT * FROM ' + table + ' ORDER BY ' + order;
        const source = this.db.prepare(query).iterate(), saved = backup.prepare(query).iterate();
        try {
          for (const row of source) {
            const copy = saved.next();
            if (copy.done || !isDeepStrictEqual(row, copy.value)) throw new Error('Schema upgrade backup content verification failed.');
          }
          if (!saved.next().done) throw new Error('Schema upgrade backup content verification failed.');
        } finally { source.return?.(); saved.return?.(); }
      }
    } finally { backup.close(); }
    return backupPath;
  }
  recordUpgrade(backupPath, count, fromVersion) {
    this.db.exec('PRAGMA user_version = 3');
    this.db.prepare(`
      INSERT INTO migrations (version, data, backup_complete)
      VALUES (3, ?, 1)
    `).run(encode({ backupFile: basename(backupPath), items: count, fromVersion }));
  }
  upgradeEvents() {
    const backupPath = this.schemaBackup('events');
    let count = 0;
    this.transaction(() => {
      const update = this.db.prepare(`
        UPDATE chat_items
        SET payload_id = ?
        WHERE chat_id = ?
          AND collection = ?
          AND ordinal = ?
      `);
      for (const chat of this.db.prepare('SELECT id FROM chats').all()) {
        const put = this.payloads.writer(chat.id), originalRead = this.payloads.reader(chat.id), newRead = this.payloads.reader(chat.id);
        for (const item of this.db.prepare(`
          SELECT collection, ordinal, payload_id
          FROM chat_items
          WHERE chat_id = ?
          ORDER BY collection, ordinal
        `).all(chat.id)) {
          const original = originalRead.get(item.payload_id), id = put(original);
          update.run(id, chat.id, item.collection, item.ordinal);
          if (!isDeepStrictEqual(newRead.get(id), original)) throw new Error('Event archive upgrade changed a saved chat item.');
          count++;
        }
        this.payloads.collect(chat.id);
      }
      if (count !== this.db.prepare('SELECT count(*) AS count FROM chat_items').get().count) throw new Error('Event archive upgrade lost saved chat items.');
      this.recordUpgrade(backupPath, count, 2);
    });
    // Reclaim pages that held the old duplicated records; explicit migration
    // runs offline, so this never blocks an active model reply.
    this.db.exec('VACUUM');
    return { items: count, backup: backupPath };
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) {
      // SQLITE_FULL/IOERR can already have rolled back the transaction.
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  getState(key, fallback = null) {
    const row = this.db.prepare(`
      SELECT data
      FROM app_state
      WHERE key = ?
    `).get(key);
    return row ? JSON.parse(row.data) : fallback;
  }
  setState(key, value) {
    this.db.prepare(`
      INSERT INTO app_state (key, data)
      VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE
        SET data = excluded.data
    `).run(key, encode(value));
  }
  listFolders() {
    return this.db.prepare(`
      SELECT data
      FROM folders
      ORDER BY position
    `).all().map(row => JSON.parse(row.data));
  }
  insertFolder(folder, position) {
    if (!folder || typeof folder.id !== 'string' || !folder.id) throw new Error('Invalid folder record.');
    this.db.prepare(`
      INSERT INTO folders (id, position, parent_id, data)
      VALUES (?, ?, ?, ?)
    `).run(folder.id, position, folder.parentId ?? null, encode(folder));
  }
  createFolder(folder) {
    this.transaction(() => {
      const position = this.db.prepare(`
        SELECT coalesce(max(position), -1) + 1 AS position
        FROM folders
      `).get().position;
      this.insertFolder(folder, position);
    }); return folder;
  }
  updateFolder(id, changes) {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT data
        FROM folders
        WHERE id = ?
      `).get(id);
      if (!row) throw new Error('Folder not found.');
      const folder = { ...JSON.parse(row.data), ...changes };
      if (folder.id !== id) throw new Error('Folder identity cannot change.');
      this.db.prepare(`
        UPDATE folders
        SET parent_id = ?,
            data = ?
        WHERE id = ?
      `).run(folder.parentId ?? null, encode(folder), id);
      return folder;
    });
  }
  replaceFolders(folders) { this.transaction(() => { this.db.exec('DELETE FROM folders'); folders.forEach((folder, index) => this.insertFolder(folder, index)); }); }
  header(chat) {
    if (!chat || typeof chat.id !== 'string' || !chat.id) throw new Error('Invalid chat record.');
    const header = { ...chat };
    for (const key of collections) if (Object.hasOwn(header, key)) {
      if (header[key] === null && ['compactions', 'failedAttempts'].includes(key)) continue;
      if (!Array.isArray(header[key])) throw new Error('Invalid chat collection: ' + key);
      header[key] = [];
    }
    return header;
  }
  syncItems(id, collection, items, put = this.payloads.writer(id)) {
    if (!Array.isArray(items)) throw new Error('Invalid chat collection: ' + collection);
    const before = this.db.prepare(`
      SELECT payload_id
      FROM chat_items
      WHERE chat_id = ?
        AND collection = ?
      ORDER BY ordinal
    `).all(id, collection);
    const after = items.map(item => put(JSON.parse(encode(item))));
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix].payload_id === after[prefix]) prefix++;
    if (prefix === before.length && prefix === after.length) return;
    this.db.prepare(`
      DELETE FROM chat_items
      WHERE chat_id = ?
        AND collection = ?
        AND ordinal >= ?
    `).run(id, collection, prefix);
    const insert = this.db.prepare(`
      INSERT INTO chat_items (chat_id, collection, ordinal, payload_id)
      VALUES (?, ?, ?, ?)
    `);
    for (let index = prefix; index < after.length; index++) insert.run(id, collection, index, after[index]);
  }
  insertChat(chat, position) {
    const header = this.header(chat);
    this.db.prepare(`
      INSERT INTO chats (id, position, folder_id, data)
      VALUES (?, ?, ?, ?)
    `).run(chat.id, position, chat.folderId ?? null, encode(header));
    const put = this.payloads.writer(chat.id);
    for (const key of collections) if (Array.isArray(chat[key])) this.syncItems(chat.id, key, chat[key], put);
  }
  createChat(chat) {
    this.transaction(() => {
      const position = this.db.prepare(`
        SELECT coalesce(max(position), 0) + 1 AS position
        FROM chats
      `).get().position;
      this.insertChat(chat, position);
    }); return this.getChat(chat.id);
  }
  updateChat(id, changes) {
    const patch = JSON.parse(encode(changes));
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT data
        FROM chats
        WHERE id = ?
      `).get(id);
      if (!row) throw new Error('Chat not found.');
      const header = this.header({ ...JSON.parse(row.data), ...patch });
      if (header.id !== id) throw new Error('Chat identity cannot change.');
      const put = this.payloads.writer(id);
      for (const key of collections) if (Object.hasOwn(patch, key)) this.syncItems(id, key, patch[key] ?? [], put);
      this.db.prepare(`
        UPDATE chats
        SET folder_id = ?,
            data = ?
        WHERE id = ?
      `).run(header.folderId ?? null, encode(header), id);
      if (collections.some(key => Object.hasOwn(patch, key))) this.payloads.collect(id);
    });
    return this.getChat(id);
  }
  listChatHeaders() {
    return this.db.prepare(`
      SELECT data
      FROM chats
      ORDER BY position DESC
    `).all().map(row => JSON.parse(row.data));
  }
  listChatsForDisplay() {
    const chats = this.listChatHeaders(), byId = new Map(chats.map(chat => [chat.id, chat]));
    // Follow just the needed paths through shared records. Do not decode full
    // stream archives or model context to build the ordinary browser payload.
    const rows = this.db.prepare(`
      SELECT chat_id, payload_id
      FROM chat_items
      WHERE collection = 'messages'
      ORDER BY chat_id, ordinal
    `);
    const readers = new Map();
    for (const row of rows.iterate()) {
      if (!readers.has(row.chat_id)) readers.set(row.chat_id, this.payloads.reader(row.chat_id));
      const read = (...keys) => readers.get(row.chat_id).path(row.payload_id, keys);
      const role = read('role'), text = read('text');
      const item = { ...(role !== undefined ? { role } : {}), ...(text !== undefined ? { text } : {}) };
      const usage = read('metadata', 'response', 'usage');
      if (usage) item.metadata = { response: { model: read('metadata', 'response', 'model') ?? null, usage }, request: { model: read('metadata', 'request', 'model') ?? null } };
      byId.get(row.chat_id).messages.push(item);
    }
    // Preserve counts for the view without loading complete archived payloads.
    for (const row of this.db.prepare(`
      SELECT chat_id, count(*) AS count
      FROM chat_items
      WHERE collection = 'compactions'
      GROUP BY chat_id
    `).all()) byId.get(row.chat_id).compactions = { length: row.count };
    return chats;
  }
  getChat(id) {
    const row = this.db.prepare(`
      SELECT data
      FROM chats
      WHERE id = ?
    `).get(id);
    if (!row) return null;
    const chat = JSON.parse(row.data);
    const read = this.payloads.reader(id);
    for (const item of this.db.prepare(`
      SELECT collection, payload_id
      FROM chat_items
      WHERE chat_id = ?
      ORDER BY collection, ordinal
    `).all(id)) chat[item.collection].push(read.get(item.payload_id));
    return chat;
  }
  listChats() {
    const chats = this.listChatHeaders(), byId = new Map(chats.map(chat => [chat.id, chat]));
    const readers = new Map(chats.map(chat => [chat.id, this.payloads.reader(chat.id)]));
    for (const item of this.db.prepare(`
      SELECT chat_id, collection, payload_id
      FROM chat_items
      ORDER BY chat_id, collection, ordinal
    `).all()) byId.get(item.chat_id)[item.collection].push(readers.get(item.chat_id).get(item.payload_id));
    return chats;
  }
  replaceChats(chats) { this.transaction(() => { this.db.exec('DELETE FROM chats'); chats.forEach((chat, index) => this.insertChat(chat, chats.length - index)); }); }
  legacyFiles() {
    return readdirSync(this.directory, { withFileTypes: true }).filter(entry => entry.name.endsWith('.json')).map(entry => {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Legacy storage must contain regular files.');
      return entry.name;
    }).sort();
  }
  migrateLegacy(files) {
    let marker = this.db.prepare(`
      SELECT data, backup_complete
      FROM migrations
      WHERE version = 1
    `).get();
    if (!marker && !files.length) return { status: 'no legacy files', files: 0 };
    // Once source cleanup is complete, upgrades/restored databases need not
    // carry an older migration snapshot just to run this command again.
    if (marker?.backup_complete && !files.length) {
      const data = JSON.parse(marker.data), backup = join(this.directory, data.backupFile);
      return { status: 'already migrated', files: 0, chats: data.chats, messages: data.messages, folders: data.folders,
        ...(existsSync(backup) ? { backup } : {}) };
    }
    if (!marker) {
      const values = new Map(), manifest = [];
      for (const name of files) {
        const bytes = readFileSync(join(this.directory, name));
        let value;
        try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Cannot migrate ' + name + ': invalid JSON.'); }
        values.set(name, value); manifest.push({ name, sha256: digest(bytes) });
      }
      const chats = values.has('chats.json') ? values.get('chats.json') : [];
      const folders = values.has('folders.json') ? values.get('folders.json') : [];
      if (!Array.isArray(chats) || !Array.isArray(folders)) throw new Error('Legacy chats and folders must be arrays.');
      for (const folder of folders) folderParent(folders, folder.parentId ?? null, folder.id);
      const data = { manifest, chats: chats.length, messages: chats.reduce((count, chat) => count + (chat.messages?.length ?? 0), 0), folders: folders.length,
        backupFile: 'storage.migration-backup-' + randomUUID() + '.sqlite' };
      this.transaction(() => {
        const populated = this.db.prepare(`
          SELECT
            (SELECT count(*) FROM chats)
            + (SELECT count(*) FROM folders)
            + (SELECT count(*) FROM app_state) AS count
        `).get().count;
        if (populated) throw new Error('Refusing to overwrite an existing SQLite store with legacy files.');
        folders.forEach((folder, index) => this.insertFolder(folder, index));
        chats.forEach((chat, index) => this.insertChat(chat, chats.length - index));
        for (const [name, value] of values) if (!['chats.json', 'folders.json'].includes(name)) this.setState(['auth.json', 'host.json'].includes(name) ? name.slice(0, -5) : 'legacy/' + name, value);
        if (!isDeepStrictEqual(this.listChats(), chats) || !isDeepStrictEqual(this.listFolders(), folders)) throw new Error('Migration verification failed.');
        for (const [name, value] of values) if (!['chats.json', 'folders.json'].includes(name) && !isDeepStrictEqual(this.getState(['auth.json', 'host.json'].includes(name) ? name.slice(0, -5) : 'legacy/' + name), value)) throw new Error('Migration state verification failed.');
        this.db.prepare(`
          INSERT INTO migrations (version, data)
          VALUES (1, ?)
        `).run(encode(data));
      });
      marker = { data: encode(data), backup_complete: 0 };
    }
    const data = JSON.parse(marker.data), expected = new Map(data.manifest.map(file => [file.name, file.sha256]));
    // Verify all remaining sources before removing any. A committed manifest
    // makes interrupted cleanup resumable without re-importing old state.
    const verifySources = () => {
      for (const name of files) if (expected.get(name) !== digest(readFileSync(join(this.directory, name)))) throw new Error('Legacy files changed after import; migration cleanup was not performed.');
    };
    verifySources();
    const backupPath = join(this.directory, data.backupFile);
    if (!marker.backup_complete) {
      if (existsSync(backupPath)) unlinkSync(backupPath);
      writeFileSync(backupPath, '', { flag: 'wx', mode: 0o600 });
      this.db.prepare('VACUUM INTO ?').run(backupPath);
    }
    if (!existsSync(backupPath)) throw new Error('Migration backup is missing; legacy files were kept.');
    chmodSync(backupPath, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || backup.prepare(`
        SELECT data
        FROM migrations
        WHERE version = 1
      `).get()?.data !== marker.data) throw new Error('Migration backup verification failed.');
      if (!marker.backup_complete) {
        for (const [table, order] of [['chats', 'id'], ['folders', 'id'], ['chat_items', 'chat_id,collection,ordinal'], ['chat_payloads', 'chat_id,id'], ['app_state', 'key']]) {
          const query = 'SELECT * FROM ' + table + ' ORDER BY ' + order;
          if (!isDeepStrictEqual(this.db.prepare(query).all(), backup.prepare(query).all())) throw new Error('Migration backup content verification failed.');
        }
      }
    } finally { backup.close(); }
    this.db.prepare(`
      UPDATE migrations
      SET backup_complete = 1
      WHERE version = 1
    `).run();
    verifySources();
    for (const name of files) unlinkSync(join(this.directory, name));
    return { status: files.length ? 'migrated' : 'already migrated', files: data.manifest.length, chats: data.chats, messages: data.messages, folders: data.folders, backup: backupPath };
  }
}
