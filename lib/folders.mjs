const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function itemName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw fail('Enter a name of 1–120 characters.');
  return value.trim();
}
export function folderParent(folders, parentId, id = null) {
  if (parentId === null) return null;
  if (typeof parentId !== 'string') throw fail('Choose a folder or the top level.');
  const visited = new Set(id ? [id] : []);
  let current = parentId;
  while (current !== null) {
    if (visited.has(current)) throw fail('A folder cannot contain itself or one of its parents.');
    visited.add(current);
    const folder = folders.find(item => item.id === current);
    if (!folder) throw fail('Folder not found.', 404);
    current = folder.parentId ?? null;
  }
  return parentId;
}
