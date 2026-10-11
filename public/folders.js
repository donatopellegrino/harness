import { folderActivityCounts } from './activity.js';

// Folder choices retain full paths so duplicate names remain distinguishable.
export function folderChoices(folders, exclude = null) {
  const blocked = new Set(exclude ? [exclude] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) if (blocked.has(folder.parentId) && !blocked.has(folder.id)) { blocked.add(folder.id); changed = true; }
  }
  const choices = [{ id: '', name: 'Top level' }], visited = new Set();
  const stack = folders.filter(folder => !folder.parentId).map(folder => ({ folder, path: '' })).reverse();
  while (stack.length) {
    const { folder, path } = stack.pop();
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);
    const name = path ? `${path} / ${folder.name}` : folder.name;
    if (!blocked.has(folder.id)) choices.push({ id: folder.id, name });
    stack.push(...folders.filter(item => item.parentId === folder.id).map(item => ({ folder: item, path: name })).reverse());
  }
  return choices;
}

export function mergeChat(current, incoming) {
  // A delayed generation acknowledgment must not undo a more recent rename/move.
  if (!current) return incoming;
  const conversation = current.messages.length > incoming.messages.length || (current.compactionCount ?? 0) > (incoming.compactionCount ?? 0)
    ? { ...incoming, ...current } : incoming;
  const currentVersion = current.organizationVersion ?? 0, incomingVersion = incoming.organizationVersion ?? 0;
  const organization = currentVersion === incomingVersion ? conversation : currentVersion > incomingVersion ? current : incoming;
  return { ...conversation, title: organization.title, folderId: organization.folderId, organizationVersion: organization.organizationVersion };
}

export function mergeOrganization(current, incoming) {
  if ((incoming.organizationVersion ?? 0) <= (current.organizationVersion ?? 0)) return current;
  return { ...current, title: incoming.title, folderId: incoming.folderId, organizationVersion: incoming.organizationVersion };
}

export function organizationChanges(kind, item, name, parentId) {
  if (kind === 'folder' && item) return name !== item.name ? { name } : {};
  const nameKey = kind === 'chat' ? 'title' : 'name', parentKey = kind === 'chat' ? 'folderId' : 'parentId';
  return { ...(!item || name !== item[nameKey] ? { [nameKey]: name } : {}),
    ...(!item || parentId !== (item[parentKey] ?? null) ? { [parentKey]: parentId } : {}) };
}

export function createFolders({ state, api, onOrganization, onFolder, onSelectChat, afterRender }) {
  const $ = id => document.getElementById(id);
  let selected = null, selection = null, editing = null, saving = false;
  const collapsed = new Set();
  function revealFolder(id) {
    const visited = new Set();
    while (id && !visited.has(id)) {
      visited.add(id); collapsed.delete(id);
      id = state().folders.find(folder => folder.id === id)?.parentId;
    }
  }
  function button(label, className, action, ariaLabel) {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.className = className;
    if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
    node.onclick = action; return node;
  }
  function edit(kind, item = null) {
    editing = { kind, item };
    const folder = kind !== 'chat';
    $('organize-heading').textContent = item ? `Edit ${folder ? 'folder' : 'chat'}` : 'New folder';
    $('organize-name').value = item ? (folder ? item.name : item.title) : '';
    $('organize-parent-label').firstChild.textContent = folder ? 'Parent folder ' : 'Folder ';
    $('organize-parent-label').hidden = folder && !!item;
    const choices = folderChoices(state().folders, folder ? item?.id : null);
    $('organize-parent').replaceChildren(...choices.map(choice => new Option(choice.name, choice.id)));
    $('organize-parent').value = (item ? folder ? item.parentId : item.folderId : selected) ?? '';
    $('organize-error').hidden = true; $('organize-save').textContent = item ? 'Save' : 'Create';
    $('organize-dialog').showModal(); $('organize-name').focus(); $('organize-name').select();
  }
  $('new-folder').onclick = () => edit('folder');
  $('organize-cancel').onclick = () => $('organize-dialog').close();
  $('organize-dialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('organize-form').onsubmit = async event => {
    event.preventDefault(); if (saving || !editing) return;
    const { kind, item } = editing, name = $('organize-name').value.trim(), parent = $('organize-parent').value || null;
    if (!name) { $('organize-error').textContent = 'Enter a name.'; $('organize-error').hidden = false; return; }
    const changes = organizationChanges(kind, item, name, parent);
    if (!Object.keys(changes).length) { $('organize-dialog').close(); return; }
    saving = true;
    for (const control of $('organize-form').querySelectorAll('input, select, button')) control.disabled = true;
    try {
      if (kind === 'chat') onOrganization(await api(`/api/chats/${item.id}/organization`, 'PATCH', changes));
      else {
        const folder = await api(item ? `/api/folders/${item.id}` : '/api/folders', item ? 'PATCH' : 'POST', changes);
        onFolder(folder);
        if (!item) { selected = folder.id; selection = { kind: 'folder', id: folder.id }; }
      }
      if (parent) revealFolder(parent);
      render(); afterRender(); $('organize-dialog').close();
    } catch (error) { $('organize-error').textContent = error.message; $('organize-error').hidden = false; }
    finally {
      saving = false;
      for (const control of $('organize-form').querySelectorAll('input, select, button')) control.disabled = false;
    }
  };
  function render() {
    const { folders, chats, activeId } = state();
    if (!selection && activeId) selection = { kind: 'chat', id: activeId };
    if (selected && !folders.some(folder => folder.id === selected)) selected = null;
    const nav = $('chats'); nav.replaceChildren();
    const root = button('Top level', 'folder-label', () => { selected = null; selection = { kind: 'root' }; render(); afterRender(); });
    root.setAttribute('aria-pressed', String(selection?.kind === 'root')); nav.append(root);
    const visited = new Set();
    function contents(parentId, container) {
      for (const folder of folders.filter(item => (item.parentId ?? null) === parentId)) {
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);
        const group = document.createElement('div'); group.className = 'folder-group';
        const row = document.createElement('div'); row.className = 'sidebar-row';
        const children = document.createElement('div'); children.className = 'folder-children'; children.hidden = collapsed.has(folder.id);
        const toggle = button(children.hidden ? '▸' : '▾', 'folder-toggle', () => {
          if (collapsed.has(folder.id)) collapsed.delete(folder.id); else collapsed.add(folder.id);
          children.hidden = collapsed.has(folder.id); toggle.textContent = children.hidden ? '▸' : '▾';
          toggle.setAttribute('aria-expanded', String(!children.hidden));
        }, `Expand or collapse ${folder.name}`);
        toggle.setAttribute('aria-expanded', String(!children.hidden));
        const label = button(folder.name, 'folder-label', () => {
          if (selection?.kind === 'folder' && selection.id === folder.id) { edit('folder', folder); return; }
          selected = folder.id; selection = { kind: 'folder', id: folder.id }; render(); afterRender();
        });
        label.title = `${folder.name} · Click again to rename`; label.setAttribute('aria-pressed', String(selection?.kind === 'folder' && selection.id === folder.id));
        row.append(toggle, label, indicator('folder', folder.id));
        group.append(row, children); container.append(group); contents(folder.id, children);
      }
      for (const chat of chats.filter(item => (item.folderId ?? null) === parentId)) {
        const row = document.createElement('div'); row.className = 'sidebar-row';
        const open = button(chat.title, 'chat-open', () => {
          if (selection?.kind === 'chat' && selection.id === chat.id) { edit('chat', chat); return; }
          const previous = { selected, selection };
          selected = chat.folderId ?? null; selection = { kind: 'chat', id: chat.id };
          if (onSelectChat(chat.id) === false) { selected = previous.selected; selection = previous.selection; }
        });
        open.dataset.chatOpen = ''; open.dataset.chatId = chat.id; open.title = `${chat.title} · Click again to rename or move`; open.setAttribute('aria-current', String(selection?.kind === 'chat' && chat.id === selection.id));
        row.append(open, indicator('chat', chat.id)); container.append(row);
      }
    }
    contents(null, nav); updateActivity();
  }
  function indicator(kind, id) {
    const node = document.createElement('span'); node.className = 'activity-indicator'; node.hidden = true;
    node.dataset[kind === 'chat' ? 'activityChat' : 'activityFolder'] = id;
    node.setAttribute('role', 'status'); return node;
  }
  function updateActivity() {
    const { folders, chats, activities = new Map() } = state();
    const counts = folderActivityCounts(folders, chats, activities);
    for (const node of $('chats').querySelectorAll('.activity-indicator')) {
      const count = node.dataset.activityFolder ? counts.get(node.dataset.activityFolder) ?? 0 : activities.has(node.dataset.activityChat) ? 1 : 0;
      const label = node.dataset.activityFolder ? `${count} ${count === 1 ? 'chat' : 'chats'} working` : activities.get(node.dataset.activityChat) === 'compacting' ? 'Compacting context' : 'Generating reply';
      node.hidden = count === 0;
      const text = count > 1 ? String(count) : '';
      if (node.textContent !== text) node.textContent = text;
      if (node.getAttribute('aria-label') !== label) { node.setAttribute('aria-label', label); node.title = label; }
    }
  }
  return { render, revealFolder, updateActivity, selectChat: (id, folderId) => { selected = folderId ?? null; selection = { kind: 'chat', id }; }, selectedFolder: () => selected };
}
