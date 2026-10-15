export function createAgentsEditor({ api }) {
  const $ = id => document.getElementById(id);
  const dialog = $('agents-dialog');
  let target = null, revision = 0, epoch = 0, saving = false;
  const error = message => { $('agents-error').textContent = message; $('agents-error').hidden = !message; };
  dialog.addEventListener('close', () => { epoch++; target = null; });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('agents-cancel').onclick = () => { if (!saving) dialog.close(); };
  $('agents-form').onsubmit = async event => {
    event.preventDefault();
    if (saving || !target || $('agents-save').disabled) return;
    const current = epoch;
    saving = true; error('');
    $('agents-content').disabled = true; $('agents-save').disabled = true; $('agents-cancel').disabled = true;
    try {
      await api(target.path, 'PUT', { content: $('agents-content').value, revision });
      if (current === epoch) dialog.close();
    } catch (failure) { if (current === epoch) error(failure.message); }
    finally {
      saving = false;
      $('agents-content').disabled = false; $('agents-save').disabled = false; $('agents-cancel').disabled = false;
    }
  };
  async function open({ folderId = null, name = '' } = {}) {
    if (saving || dialog.open) return;
    const current = ++epoch;
    target = { path: folderId === null ? '/api/agents-md/global' : `/api/folders/${folderId}/agents-md` };
    $('agents-heading').textContent = folderId === null ? 'Global AGENTS.md' : `AGENTS.md · ${name}`;
    $('agents-description').textContent = folderId === null
      ? 'Applies to every chat. Each chat also receives its immediate folder’s instructions, if any. Folder instructions take precedence in conflicts.'
      : 'Applies only to chats directly in this folder, together with Global AGENTS.md. Parent, child, and other folders’ instructions are not included.';
    $('agents-status').textContent = 'Loading…'; error('');
    $('agents-content').value = ''; $('agents-content').disabled = true; $('agents-save').disabled = true;
    dialog.showModal(); $('agents-cancel').focus();
    try {
      const document = await api(target.path);
      if (current !== epoch || !dialog.open) return;
      revision = document.revision;
      $('agents-content').value = document.content; $('agents-content').disabled = false; $('agents-save').disabled = false;
      $('agents-status').textContent = 'Saved changes apply to new requests, including existing chats. Running requests keep their current instructions. Empty text clears this scope.';
      $('agents-content').focus();
    } catch (failure) {
      if (current !== epoch || !dialog.open) return;
      $('agents-status').textContent = ''; error(failure.message);
    }
  }
  return { open };
}
