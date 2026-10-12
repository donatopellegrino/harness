import { createHash } from 'node:crypto';

// Shared children use {$ref: ID}. Small diagnostics keep their original shape.
// Provider objects with reserved keys get their own record, and literal $ref
// fields are escaped, so neither decoding nor reachability can confuse them
// with generated references.
const sharedText = key => /^(text|content|refusal)$/.test(key) || /^encrypted_/i.test(key);
const sharedObject = (value, key) => ['item', 'response', 'request'].includes(key) ||
  typeof value.role === 'string' && Object.hasOwn(value, 'content') ||
  key !== 'stream-event' && typeof value.type === 'string' && !value.type.startsWith('response.') ||
  Object.hasOwn(value, '$ref') || Object.hasOwn(value, '$literal');

export class ChatPayloads {
  constructor(db) {
    this.db = db;
    this.insert = db.prepare(`
      INSERT INTO chat_payloads (chat_id, fingerprint, kind, data)
      VALUES (?, ?, ?, ?)
    `);
    this.byFingerprint = db.prepare(`
      SELECT id
      FROM chat_payloads
      WHERE chat_id = ?
        AND fingerprint = ?
    `);
    this.select = db.prepare(`
      SELECT kind, data
      FROM chat_payloads
      WHERE chat_id = ?
        AND id = ?
    `);
  }

  writer(chatId) {
    const written = new Map();
    const encode = (value, key) => {
      if (Array.isArray(value)) return value.map(item => encode(item, key === 'events' ? 'stream-event' : ''));
      if (value !== null && typeof value === 'object') return sharedObject(value, key) ? { $ref: put(value) }
        : Object.fromEntries(Object.entries(value).map(([key, value]) => [key, encode(value, key)]));
      if (typeof value === 'string' && (sharedText(key) || value.length >= 256)) return { $ref: put(value) };
      return key === '$ref' ? { $literal: value } : value;
    };
    const put = value => {
      const kind = Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : 'value';
      const data = JSON.stringify(kind === 'array' ? value.map(value => encode(value, '')) : kind === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, encode(value, key)])) : value);
      const fingerprint = createHash('sha256').update(kind).update('\0').update(data).digest('hex');
      if (!written.has(fingerprint)) {
        const row = this.byFingerprint.get(chatId, fingerprint);
        const id = row?.id ?? Number(this.insert.run(chatId, fingerprint, kind, data).lastInsertRowid);
        written.set(fingerprint, id);
      }
      return written.get(fingerprint);
    };
    return put;
  }

  reader(chatId) {
    const records = new Map(), decoded = new Map();
    const node = id => {
      if (!records.has(id)) {
        const row = this.select.get(chatId, id);
        if (!row) throw new Error('Missing saved chat payload.');
        records.set(id, { kind: row.kind, data: JSON.parse(row.data) });
      }
      return records.get(id);
    };
    const contents = (kind, data) => kind === 'value' ? data : kind === 'array' ? data.map(edge)
      : Object.fromEntries(Object.entries(data).map(([key, value]) => [key, edge(value)]));
    const edge = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? contents('array', value)
      : Object.hasOwn(value, '$ref') ? get(value.$ref) : Object.hasOwn(value, '$literal') ? value.$literal : contents('object', value);
    const get = id => {
      if (!decoded.has(id)) {
        const { kind, data } = node(id);
        decoded.set(id, contents(kind, data));
      }
      return decoded.get(id);
    };
    const navigate = ({ kind, data }, keys) => {
      if (!keys.length) return contents(kind, data);
      if (kind === 'value' || !Object.hasOwn(data, keys[0])) return undefined;
      const value = data[keys[0]];
      if (value === null || typeof value !== 'object') return keys.length === 1 ? value : undefined;
      if (!Array.isArray(value) && Object.hasOwn(value, '$ref')) return path(value.$ref, keys.slice(1));
      if (!Array.isArray(value) && Object.hasOwn(value, '$literal')) return keys.length === 1 ? value.$literal : undefined;
      return navigate({ kind: Array.isArray(value) ? 'array' : 'object', data: value }, keys.slice(1));
    };
    const path = (id, keys) => keys.length ? navigate(node(id), keys) : get(id);
    return { get, path };
  }

  collect(chatId) {
    // Context replacement removes references, not messages. Retain everything
    // reachable from visible history, active context, archives or failed turns.
    this.db.prepare(`
      WITH RECURSIVE reachable (id) AS (
        SELECT payload_id
        FROM chat_items
        WHERE chat_id = ?

        UNION

        SELECT child.atom
        FROM reachable
        JOIN chat_payloads AS payload
          ON payload.chat_id = ?
          AND payload.id = reachable.id
        JOIN json_tree(
          CASE WHEN payload.kind = 'value' THEN '[]' ELSE payload.data END
        ) AS child
        WHERE child.key = '$ref'
          AND child.type = 'integer'
      )
      DELETE FROM chat_payloads
      WHERE chat_id = ?
        AND id NOT IN (SELECT id FROM reachable)
    `).run(chatId, chatId, chatId);
  }
}
