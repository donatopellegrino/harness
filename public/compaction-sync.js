// A missing stream acknowledgment does not prove that the server rolled back.
// Re-read durable state before deciding whether a manual compaction completed.
export async function reconcileCompaction({ chatId, previousCount, readState, onChat }) {
  const state = await readState();
  const chat = state.chats.find(chat => chat.id === chatId);
  if (!chat) throw new Error('The saved chat could not be found.');
  onChat(chat);
  return (chat.compactionCount ?? 0) > previousCount;
}
