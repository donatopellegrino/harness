export const chatPath = chat => chat && !chat.private ? `/chats/${encodeURIComponent(chat.id)}` : '/';

export function chatIdFromPath(pathname) {
  const match = pathname.match(/^\/chats\/([\w-]+)$/);
  return match ? match[1] : null;
}

export function createChatNavigation({ location, history, findChat, isLocked, onSelect, onMissing }) {
  let pending = false;
  function openLocation() {
    // Keep the generation's active chat stable until its request completes.
    if (isLocked()) { pending = true; return; }
    pending = false;
    const id = chatIdFromPath(location.pathname);
    if (id === null) { onSelect(null); return; }
    const chat = findChat(id);
    if (!chat || chat.private) onMissing();
    else onSelect(chat);
  }
  function write(chat, { replace = false } = {}) {
    if (pending) return;
    const path = chatPath(chat);
    if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  }
  function flush() {
    if (!pending || isLocked()) return false;
    openLocation(); return true;
  }
  return { openLocation, write, flush };
}
