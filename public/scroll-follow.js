export function createScrollFollow(container) {
  let following = true, position, viewport, height;
  const remember = () => {
    position = container.scrollTop; viewport = container.clientHeight; height = container.scrollHeight;
  };
  remember();
  const observe = () => {
    const current = container.scrollTop;
    const atBottom = container.scrollHeight - container.clientHeight - current <= 2;
    const layoutChanged = container.clientHeight !== viewport || container.scrollHeight < height;
    if (current < position - 0.5 && !(following && layoutChanged && atBottom)) following = false;
    else if (current > position + 0.5 && atBottom) following = true;
    remember();
  };
  container.addEventListener('scroll', observe);
  function update(change, reset = false) {
    // Read before changing the DOM: a user's scroll event may still be queued.
    observe();
    const previous = container.scrollTop;
    if (reset) following = true;
    change();
    container.scrollTop = following ? container.scrollHeight : previous;
    remember();
  }
  return { update, reset: change => update(change, true) };
}
