export function resizeComposer(textarea) {
  const style = getComputedStyle(textarea);
  const maximum = Number.parseFloat(style.maxHeight) || 220;
  const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight + border, maximum)}px`;
  textarea.style.overflowY = textarea.scrollHeight > textarea.clientHeight + 1 ? 'auto' : 'hidden';
}
