export function folderActivityCounts(folders, chats, activities) {
  const parents = new Map(folders.map(folder => [folder.id, folder.parentId ?? null]));
  const counts = new Map();
  for (const chat of chats) {
    if (!activities.get(chat.id)) continue;
    let folderId = chat.folderId;
    const seen = new Set();
    while (folderId && parents.has(folderId) && !seen.has(folderId)) {
      seen.add(folderId); counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
      folderId = parents.get(folderId);
    }
  }
  return counts;
}
