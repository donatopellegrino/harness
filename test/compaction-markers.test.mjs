import test from 'node:test';
import assert from 'node:assert/strict';
import { compactionMarkers } from '../lib/compaction-markers.mjs';
import { Store } from '../lib/store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const time = second => `2026-10-13T10:00:${String(second).padStart(2, '0')}.000Z`;
const history = [
  { role: 'user', text: 'First question', metadata: { sent_at: time(1) } },
  { role: 'assistant', text: 'First reply', metadata: { finished_at: time(2), response: { id: 'r1' } } },
  { role: 'user', text: 'Second question', metadata: { sent_at: time(5) } },
  { role: 'assistant', text: 'Second reply', metadata: { finished_at: time(6), response: { id: 'r2' } } },
];

test('explicit message boundaries preserve repeated compactions and expose only marker fields', () => {
  const records = [
    { mode: 'automatic', after_message_count: 2, completed_at: time(2), previous_input: [{ encrypted_content: 'secret' }] },
    { mode: 'manual', after_message_count: 2, completed_at: time(3), metadata: { events: [{ encrypted_content: 'secret' }] } },
    { mode: 'manual', after_message_count: 4, completed_at: time(7) },
  ];
  assert.deepEqual(compactionMarkers(history, records), [
    { afterMessageCount: 2, mode: 'automatic', completedAt: time(2) },
    { afterMessageCount: 2, mode: 'manual', completedAt: time(3) },
    { afterMessageCount: 4, mode: 'manual', completedAt: time(7) },
  ]);
});

test('older automatic compactions match response IDs and older manual records use adjacent saved times', () => {
  assert.deepEqual(compactionMarkers(history, [
    { mode: 'automatic', response_id: 'r1', completed_at: time(2) },
    { mode: 'manual', completed_at: time(3) },
    { mode: 'manual', completed_at: time(7) },
  ]).map(marker => marker.afterMessageCount), [2, 2, 4]);
});

test('unknown legacy positions stay unknown rather than being inferred from input size or missing times', () => {
  const untimed = history.map(({ role, text }) => ({ role, text }));
  assert.equal(compactionMarkers(untimed, [{ previous_input: [1, 2], completed_at: time(3) }])[0].afterMessageCount, null);
  const gap = [{ ...history[0] }, { role: 'assistant', text: 'Untimed reply' }, ...history.slice(2)];
  assert.equal(compactionMarkers(gap, [{ completed_at: time(3) }])[0].afterMessageCount, null);
  assert.deepEqual(compactionMarkers(history, [null, { after_message_count: -1, completed_at: 'invalid' }]), [
    { afterMessageCount: null, mode: null, completedAt: null },
    { afterMessageCount: null, mode: null, completedAt: null },
  ]);
});

test('lightweight chat state has the same legacy markers as full chat state without reading encrypted history or stream archives', t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-marker-projection-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const encrypted = 'private-checkpoint'.repeat(100);
  const chat = { id: 'chat', messages: history, input: [], compactions: [
    { mode: 'automatic', response_id: 'r1', completed_at: time(2), previous_input: [{ type: 'compaction', encrypted_content: encrypted }] },
    { mode: 'manual', completed_at: time(3), metadata: { events: [{ type: 'response.future', diagnostic: 'private-stream-detail' }] } },
  ] };
  store.createChat(chat);
  const expected = compactionMarkers(chat.messages, chat.compactions);
  const select = store.payloads.select.get.bind(store.payloads.select);
  store.payloads.select.get = (...args) => {
    const row = select(...args);
    if (row?.data.includes(encrypted) || row?.data.includes('private-stream-detail')) throw new Error('Marker projection fetched hidden archives');
    return row;
  };
  try {
    const displayed = store.listChatsForDisplay()[0];
    assert.deepEqual(compactionMarkers(displayed.messages, displayed.compactions), expected);
  } finally { store.payloads.select.get = select; }
});
