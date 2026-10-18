// Parser blocking, dependency free: apply the saved theme before styles paint.
(() => {
  let theme = 'light';
  try { if (localStorage.getItem('bedrock-theme') === 'dark') theme = 'dark'; } catch {}
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = theme === 'dark' ? '#161422' : '#eeedf8';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#232133' : '#eeedf8');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
})();
