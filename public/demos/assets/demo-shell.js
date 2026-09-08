(function () {
  const tabs = [...document.querySelectorAll('.demo-tab')];
  const panels = [...document.querySelectorAll('[data-screen-panel]')];

  function showScreen(screen) {
    if (!screen) return;
    for (const tab of tabs) {
      const active = tab.dataset.screen === screen;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const panel of panels) {
      const active = panel.dataset.screenPanel === screen;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', active ? 'false' : 'true');
    }
    const url = new URL(window.location.href);
    url.hash = screen;
    window.history.replaceState(null, '', url);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => showScreen(tab.dataset.screen));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const nextIndex =
        event.key === 'Home' ? 0 :
        event.key === 'End' ? tabs.length - 1 :
        event.key === 'ArrowRight' ? (current + 1) % tabs.length :
        (current - 1 + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      showScreen(tabs[nextIndex].dataset.screen);
    });
  }

  for (const jump of document.querySelectorAll('[data-jump]')) {
    jump.addEventListener('click', () => showScreen(jump.dataset.jump));
  }

  const initial = window.location.hash.replace('#', '');
  if (initial && panels.some((panel) => panel.dataset.screenPanel === initial)) {
    showScreen(initial);
  }

  for (const button of document.querySelectorAll('.loading-action')) {
    button.addEventListener('click', () => {
      const oldText = button.textContent;
      button.textContent = '模拟登录中…';
      button.disabled = true;
      window.setTimeout(() => {
        button.textContent = oldText;
        button.disabled = false;
      }, 900);
    });
  }
})();
