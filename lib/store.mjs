import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { folderParent } from './folders.mjs';

const collections = ['messages', 'input', 'compactions', 'failedAttempts'];
const encode = value => {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Storage values must be serializable.');
  return result;
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const extracted = (value, type) => type === 'object' || type === 'array' ? JSON.parse(value) : type === 'true' ? true : type === 'false' ? false : value;

export class Store {
  constructor(directory, { migrateLegacy = false } = {}) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const legacy = this.legacyFiles();
    if (legacy.length && !migrateLegacy) throw new Error('Legacy JSON storage found. Stop the server and run npm run migrate before starting this version.');
    this.path = join(directory, 'storage.sqlite');
    if (!existsSync(this.path)) writeFileSync(this.path, '', { flag: 'wx', mode: 0o600 });
    if (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink()) throw new Error('Storage database must be a regular file.');
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('Storage database was created by a newer harness version.');
      this.db.exec([
        'CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, position INTEGER NOT NULL, parent_id TEXT REFERENCES folders(id) DEFERRABLE INITIALLY DEFERRED, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
        'CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, position INTEGER NOT NULL, folder_id TEXT REFERENCES folders(id) DEFERRABLE INITIALLY DEFERRED, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
        "CREATE TABLE IF NOT EXISTS chat_items (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, collection TEXT NOT NULL CHECK(collection IN ('messages','input','compactions','failedAttempts')), ordinal INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(chat_id,collection,ordinal)) STRICT;",
        'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;',
        'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), backup_complete INTEGER NOT NULL DEFAULT 0) STRICT;',
        'CREATE INDEX IF NOT EXISTS chats_by_folder ON chats(folder_id,position DESC);',
        'CREATE INDEX IF NOT EXISTS folders_by_parent ON folders(parent_id,position);',
        'PRAGMA user_version=1;',
      ].join('\n'));
      if (migrateLegacy) this.migration = this.migrateLegacy(legacy);
    } catch (error) { this.close(); throw error; }
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
    const row = this.db.prepare('SELECT data FROM app_state WHERE key=?').get(key);
    return row ? JSON.parse(row.data) : fallback;
  }
  setState(key, value) {
    this.db.prepare('INSERT INTO app_state(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, encode(value));
  }
  listFolders() { return this.db.prepare('SELECT data FROM folders ORDER BY position').all().map(row => JSON.parse(row.data)); }
  insertFolder(folder, position) {
    if (!folder || typeof folder.id !== 'string' || !folder.id) throw new Error('Invalid folder record.');
    this.db.prepare('INSERT INTO folders(id,position,parent_id,data) VALUES (?,?,?,?)').run(folder.id, position, folder.parentId ?? null, encode(folder));
  }
  createFolder(folder) {
    this.transaction(() => {
      const position = this.db.prepare('SELECT coalesce(max(position),-1)+1 AS position FROM folders').get().position;
      this.insertFolder(folder, position);
    }); return folder;
  }
  updateFolder(id, changes) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM folders WHERE id=?').get(id);
      if (!row) throw new Error('Folder not found.');
      const folder = { ...JSON.parse(row.data), ...changes };
      if (folder.id !== id) throw new Error('Folder identity cannot change.');
      this.db.prepare('UPDATE folders SET parent_id=?,data=? WHERE id=?').run(folder.parentId ?? null, encode(folder), id);
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
  syncItems(id, collection, items) {
    if (!Array.isArray(items)) throw new Error('Invalid chat collection: ' + collection);
    const before = this.db.prepare('SELECT data FROM chat_items WHERE chat_id=? AND collection=? ORDER BY ordinal').all(id, collection);
    const after = items.map(encode);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix].data === after[prefix]) prefix++;
    if (prefix === before.length && prefix === after.length) return;
    this.db.prepare('DELETE FROM chat_items WHERE chat_id=? AND collection=? AND ordinal>=?').run(id, collection, prefix);
    const insert = this.db.prepare('INSERT INTO chat_items(chat_id,collection,ordinal,data) VALUES (?,?,?,?)');
    for (let index = prefix; index < after.length; index++) insert.run(id, collection, index, after[index]);
  }
  insertChat(chat, position) {
    const header = this.header(chat);
    this.db.prepare('INSERT INTO chats(id,position,folder_id,data) VALUES (?,?,?,?)').run(chat.id, position, chat.folderId ?? null, encode(header));
    for (const key of collections) if (Array.isArray(chat[key])) this.syncItems(chat.id, key, chat[key]);
  }
  createChat(chat) {
    this.transaction(() => {
      const position = this.db.prepare('SELECT coalesce(max(position),0)+1 AS position FROM chats').get().position;
      this.insertChat(chat, position);
    }); return this.getChat(chat.id);
  }
  updateChat(id, changes) {
    const patch = JSON.parse(encode(changes));
    this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM chats WHERE id=?').get(id);
      if (!row) throw new Error('Chat not found.');
      const header = this.header({ ...JSON.parse(row.data), ...patch });
      if (header.id !== id) throw new Error('Chat identity cannot change.');
      for (const key of collections) if (Object.hasOwn(patch, key)) this.syncItems(id, key, patch[key] ?? []);
      this.db.prepare('UPDATE chats SET folder_id=?,data=? WHERE id=?').run(header.folderId ?? null, encode(header), id);
    });
    return this.getChat(id);
  }
  listChatHeaders() { return this.db.prepare('SELECT data FROM chats ORDER BY position DESC').all().map(row => JSON.parse(row.data)); }
  listChatsForDisplay() {
    const chats = this.listChatHeaders(), byId = new Map(chats.map(chat => [chat.id, chat]));
    // The browser needs text and usage, not archived stream events, encrypted
    // context, or old checkpoints. SQLite extracts only those small fields.
    const rows = this.db.prepare("SELECT chat_id,json_extract(data,'$.role') AS role,json_type(data,'$.role') AS role_type,json_extract(data,'$.text') AS text,json_type(data,'$.text') AS text_type,json_extract(data,'$.metadata.response.usage') AS usage,json_type(data,'$.metadata.response.usage') AS usage_type,json_extract(data,'$.metadata.response.model') AS model,json_extract(data,'$.metadata.request.model') AS requested_model FROM chat_items WHERE collection='messages' ORDER BY chat_id,ordinal");
    for (const row of rows.iterate()) {
      const item = { ...(row.role_type !== null ? { role: extracted(row.role, row.role_type) } : {}), ...(row.text_type !== null ? { text: extracted(row.text, row.text_type) } : {}) };
      if (row.usage) item.metadata = { response: { model: row.model, usage: extracted(row.usage, row.usage_type) }, request: { model: row.requested_model } };
      byId.get(row.chat_id).messages.push(item);
    }
    // Preserve counts for the view without loading complete archived payloads.
    for (const row of this.db.prepare("SELECT chat_id,count(*) AS count FROM chat_items WHERE collection='compactions' GROUP BY chat_id").all()) byId.get(row.chat_id).compactions = { length: row.count };
    return chats;
  }
  getChat(id) {
    const row = this.db.prepare('SELECT data FROM chats WHERE id=?').get(id);
    if (!row) return null;
    const chat = JSON.parse(row.data);
    for (const item of this.db.prepare('SELECT collection,data FROM chat_items WHERE chat_id=? ORDER BY collection,ordinal').all(id)) chat[item.collection].push(JSON.parse(item.data));
    return chat;
  }
  listChats() {
    const chats = this.listChatHeaders(), byId = new Map(chats.map(chat => [chat.id, chat]));
    for (const item of this.db.prepare('SELECT chat_id,collection,data FROM chat_items ORDER BY chat_id,collection,ordinal').all()) byId.get(item.chat_id)[item.collection].push(JSON.parse(item.data));
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
    let marker = this.db.prepare('SELECT data,backup_complete FROM migrations WHERE version=1').get();
    if (!marker && !files.length) return { status: 'no legacy files', files: 0 };
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
        const populated = this.db.prepare('SELECT (SELECT count(*) FROM chats)+(SELECT count(*) FROM folders)+(SELECT count(*) FROM app_state) AS count').get().count;
        if (populated) throw new Error('Refusing to overwrite an existing SQLite store with legacy files.');
        folders.forEach((folder, index) => this.insertFolder(folder, index));
        chats.forEach((chat, index) => this.insertChat(chat, chats.length - index));
        for (const [name, value] of values) if (!['chats.json', 'folders.json'].includes(name)) this.setState(['auth.json', 'host.json'].includes(name) ? name.slice(0, -5) : 'legacy/' + name, value);
        if (!isDeepStrictEqual(this.listChats(), chats) || !isDeepStrictEqual(this.listFolders(), folders)) throw new Error('Migration verification failed.');
        for (const [name, value] of values) if (!['chats.json', 'folders.json'].includes(name) && !isDeepStrictEqual(this.getState(['auth.json', 'host.json'].includes(name) ? name.slice(0, -5) : 'legacy/' + name), value)) throw new Error('Migration state verification failed.');
        this.db.prepare('INSERT INTO migrations(version,data) VALUES (1,?)').run(encode(data));
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
      if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || backup.prepare('SELECT data FROM migrations WHERE version=1').get()?.data !== marker.data) throw new Error('Migration backup verification failed.');
      if (!marker.backup_complete) {
        for (const [table, order] of [['chats', 'id'], ['folders', 'id'], ['chat_items', 'chat_id,collection,ordinal'], ['app_state', 'key']]) {
          const query = 'SELECT * FROM ' + table + ' ORDER BY ' + order;
          if (!isDeepStrictEqual(this.db.prepare(query).all(), backup.prepare(query).all())) throw new Error('Migration backup content verification failed.');
        }
      }
    } finally { backup.close(); }
    this.db.prepare('UPDATE migrations SET backup_complete=1 WHERE version=1').run();
    verifySources();
    for (const name of files) unlinkSync(join(this.directory, name));
    return { status: files.length ? 'migrated' : 'already migrated', files: data.manifest.length, chats: data.chats, messages: data.messages, folders: data.folders, backup: backupPath };
  }
}
