(() => {
  const key = 'basic-harness-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = valid(localStorage.getItem(key)); } catch {}

  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    const select = document.getElementById('theme');
    if (select) select.value = preference;
  }
  // Run before styles load to avoid flashing the wrong saved appearance.
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = valid(event.newValue); apply(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme').addEventListener('change', event => {
      preference = valid(event.target.value);
      try { localStorage.setItem(key, preference); } catch {}
      apply();
    });
  });
})();
