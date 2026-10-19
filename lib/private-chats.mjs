import { folderParent } from './folders.mjs';

// A private turn carries its context from browser memory. Never register this
// object with Store or with the persistent/in-flight chat lookup.
export function privateChatSnapshot(value, id, folders) {
  if (!value || typeof value !== 'object' || value.id !== id ||
      typeof value.model !== 'string' || typeof value.effort !== 'string' ||
      !Array.isArray(value.input) || !Array.isArray(value.messages) ||
      !value.messages.every(message => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string') ||
      !Array.isArray(value.compactions ?? [])) throw new Error('Invalid private chat context.');
  return {
    id, private: true, folderId: folderParent(folders, value.folderId ?? null),
    title: typeof value.title === 'string' ? value.title.slice(0, 120) : 'Private chat', titleEdited: true, model: value.model, effort: value.effort,
    fast: value.fast === true, input: value.input, messages: value.messages,
    compactions: value.compactions ?? [], contextUsage: value.contextUsage ?? null,
    contextUsageSource: value.contextUsageSource ?? 'reply',
  };
}
