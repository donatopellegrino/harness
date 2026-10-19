import test from 'node:test';
import assert from 'node:assert/strict';
import { createFolders } from '../public/folders.js';

function fixture(t, privateMode = true) {
  const previousDocument = globalThis.document, previousOption = globalThis.Option;
  const nodes = new Map(), requests = [];
  const makeNode = tag => {
    const handlers = new Map();
    return { tag, children: [], dataset: {}, value: '', open: false, hidden: false, firstChild: {}, textContent: '',
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute() {}, querySelectorAll() { return []; }, focus() {}, select() {},
      addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
      showModal() { this.open = true; },
      close() { this.open = false; for (const handler of handlers.get('close') ?? []) handler(); },
    };
  };
  const node = id => { if (!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); };
  globalThis.document = { getElementById: node, createElement: makeNode };
  globalThis.Option = function(text, value) { return { text, value }; };
  t.after(() => { globalThis.document = previousDocument; globalThis.Option = previousOption; });
  const chat = { id: 'fixture-chat', private: privateMode, title: 'Private title', folderId: null, messages: [{ role: 'user', text: 'Private text' }] };
  const sidebar = createFolders({ state: () => ({ folders: [], chats: [chat], activeId: chat.id }),
    api: async (...args) => { requests.push(args); return { ...chat, title: args[2].title }; },
    onOrganization() {}, onFolder() {}, onSelectChat() {}, onLifecycle() {}, onAgents() {}, afterRender() {},
  });
  sidebar.selectChat(chat.id, null); sidebar.render();
  const find = root => root.tag === 'button' && root.textContent.includes(chat.title) ? root : root.children.map(find).find(Boolean);
  find(node('chats')).onclick();
  assert.equal(node('organize-dialog').open, true); assert.equal(node('organize-name').value, chat.title);
  return { sidebar, node, requests };
}

test('closing a private rename dialog clears its title and prevents reuse of the discarded chat reference', async t => {
  const f = fixture(t);
  f.node('organize-cancel').onclick();
  assert.equal(f.node('organize-name').value, '');
  f.node('organize-name').value = 'Attempted stale rename';
  await f.node('organize-form').onsubmit({ preventDefault() {} });
  assert.equal(f.requests.length, 0);
});

test('discarding private chats closes an open rename dialog and clears private fields', async t => {
  const f = fixture(t);
  f.node('organize-error').textContent = 'Private diagnostic';
  f.sidebar.clearPrivateEditor();
  assert.equal(f.node('organize-dialog').open, false);
  assert.equal(f.node('organize-name').value, ''); assert.equal(f.node('organize-error').textContent, '');
  f.node('organize-name').value = 'Attempted stale rename';
  await f.node('organize-form').onsubmit({ preventDefault() {} });
  assert.equal(f.requests.length, 0);
});

test('private cleanup preserves a normal chat rename dialog and its save operation', async t => {
  const f = fixture(t, false);
  f.sidebar.clearPrivateEditor();
  assert.equal(f.node('organize-dialog').open, true); assert.equal(f.node('organize-name').value, 'Private title');
  f.node('organize-name').value = 'Renamed saved chat';
  await f.node('organize-form').onsubmit({ preventDefault() {} });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][2].title, 'Renamed saved chat');
});
