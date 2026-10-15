import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentsEditor } from '../public/agents-md.js';

function editor(t, api) {
  const previous = globalThis.document, nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const handlers = new Map();
      nodes.set(id, { value: '', disabled: false, open: false, hidden: false, textContent: '',
        addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
        showModal() { this.open = true; },
        close() { this.open = false; for (const handler of handlers.get('close') ?? []) handler(); },
        focus() {},
      });
    }
    return nodes.get(id);
  };
  globalThis.document = { getElementById: node };
  t.after(() => { globalThis.document = previous; });
  return { ...createAgentsEditor({ api }), node };
}

test('closing a loading editor prevents its late response from replacing another scope or draft', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = editor(t, path => path.includes('/first/') ? held : Promise.resolve({ content: 'Second scope', revision: 3 }));
  const first = f.open({ folderId: 'first', name: 'First' });
  f.node('agents-cancel').onclick();
  await f.open({ folderId: 'second', name: 'Second' });
  f.node('agents-content').value = 'Unsaved second draft';
  release({ content: 'Late first scope', revision: 1 }); await first;
  assert.equal(f.node('agents-content').value, 'Unsaved second draft');
  assert.equal(f.node('agents-heading').textContent, 'AGENTS.md · Second');
  assert.equal(f.node('agents-save').disabled, false);
});

test('a conflicting save retains the draft and editor scope; successful empty save clears the selected scope', async t => {
  const requests = [];
  let conflict = true;
  const f = editor(t, async (path, method, body) => {
    if (!method) return { content: 'Saved rules', revision: 7 };
    requests.push({ path, body });
    if (conflict) throw new Error('Instructions changed in another editor');
    return { ...body, revision: 8 };
  });
  await f.open();
  f.node('agents-content').value = 'My unsaved revision';
  await f.node('agents-form').onsubmit({ preventDefault() {} });
  assert.equal(f.node('agents-dialog').open, true); assert.equal(f.node('agents-content').value, 'My unsaved revision');
  assert.match(f.node('agents-error').textContent, /changed in another editor/);
  assert.equal(f.node('agents-content').disabled, false); assert.equal(f.node('agents-cancel').disabled, false);
  assert.deepEqual(requests[0], { path: '/api/agents-md/global', body: { content: 'My unsaved revision', revision: 7 } });
  conflict = false; f.node('agents-content').value = '';
  await f.node('agents-form').onsubmit({ preventDefault() {} });
  assert.equal(requests[1].body.content, ''); assert.equal(f.node('agents-dialog').open, false);
});
