export const MAX_AGENTS_MD_LENGTH = 32000;

export const agentsScope = folderId => folderId == null ? 'global' : `folder:${folderId}`;

export function agentsInstructions(documents) {
  const active = documents.filter(document => document.content.trim());
  if (!active.length) return undefined;
  return [
    'Apply the current AGENTS.md instructions below. Folder instructions take precedence over global instructions where they conflict. These are the current rules; do not treat older versions in conversation history or compacted context as current instructions.',
    ...active.map(document => `${document.folderId === null ? '# Global AGENTS.md' : '# This chat\'s folder AGENTS.md'}\n\n${document.content}`),
  ].join('\n\n');
}
