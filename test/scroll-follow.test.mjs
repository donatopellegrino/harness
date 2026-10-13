import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrollFollow } from '../public/scroll-follow.js';

function fixture() {
  let top = 0;
  const handlers = new Map();
  const container = {
    scrollHeight: 1000, clientHeight: 200,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    addEventListener(type, handler) { handlers.set(type, handler); },
  };
  const scroll = createScrollFollow(container);
  const notify = () => handlers.get('scroll')();
  const move = value => { container.scrollTop = value; notify(); };
  scroll.reset(() => {});
  return { container, scroll, move, notify };
}

test('new text follows the bottom until the user scrolls away', () => {
  const { container, scroll, move } = fixture();
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 900);
  move(400);
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 400);
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 400);
});

test('a queued upward scroll detaches before a delta, even within the bottom tolerance', () => {
  const { container, scroll, notify } = fixture();
  container.scrollTop = 799; // The browser has moved, but has not dispatched scroll.
  scroll.update(() => {}); // A text delta that does not add another line.
  notify(); // The delayed scroll event must not turn following back on.
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 799);
});

test('scrolling down resumes following only when the user reaches the bottom', () => {
  const { container, scroll, move } = fixture();
  move(100);
  move(500);
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 500);
  move(899);
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 1000);
});

test('completion rerender preserves position across clearing and rebuilding messages', () => {
  const { container, scroll, move } = fixture();
  move(300);
  scroll.update(() => {
    container.scrollHeight = 0;
    container.scrollTop = 0;
    container.scrollHeight = 1200;
  });
  assert.equal(container.scrollTop, 300);
});

test('opening a chat or sending a new message resets following', () => {
  const { container, scroll, move } = fixture();
  move(200);
  scroll.reset(() => { container.scrollHeight = 2000; });
  assert.equal(container.scrollTop, 1800);
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 1900);
});

test('short initial content begins following when it becomes scrollable', () => {
  const { container, scroll } = fixture();
  scroll.reset(() => { container.scrollHeight = 100; });
  assert.equal(container.scrollTop, 0);
  scroll.update(() => { container.scrollHeight = 700; });
  assert.equal(container.scrollTop, 500);
});

test('a layout resize at the bottom keeps following without reattaching a reader who scrolled up', () => {
  const { container, scroll, move, notify } = fixture();
  container.clientHeight = 300;
  container.scrollTop = 800; // Browser clamps the old bottom to the new bottom.
  notify();
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 800);
  move(100);
  container.clientHeight = 400;
  scroll.update(() => { container.scrollHeight += 100; });
  assert.equal(container.scrollTop, 100);
});
