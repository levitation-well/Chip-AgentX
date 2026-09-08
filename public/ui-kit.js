(function () {
  'use strict';

  const TOAST_DURATION_MS = 2600;

  function ensureToastHost() {
    let host = document.querySelector('.agentx-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'agentx-toast-host';
      host.setAttribute('aria-live', 'polite');
      document.body.append(host);
    }
    return host;
  }

  function toast(options) {
    const { kind = 'info', title = '', detail = '' } = options || {};
    const card = document.createElement('div');
    card.className = `agentx-toast agentx-toast-${kind}`;
    const titleEl = document.createElement('strong');
    titleEl.textContent = title;
    card.append(titleEl);
    if (detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'agentx-toast-detail';
      detailEl.textContent = detail;
      card.append(detailEl);
    }
    let removed = false;
    const dismiss = () => {
      if (removed) {
        return;
      }
      removed = true;
      card.classList.remove('show');
      window.setTimeout(() => card.remove(), 320);
    };
    card.addEventListener('click', dismiss);
    ensureToastHost().append(card);
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => card.classList.add('show'));
    } else {
      card.classList.add('show');
    }
    window.setTimeout(dismiss, TOAST_DURATION_MS);
    return card;
  }

  function openModal(config) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const backdrop = document.createElement('div');
      backdrop.className = 'agentx-modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'agentx-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      const heading = document.createElement('h3');
      heading.textContent = config.title || '';
      modal.append(heading);

      if (config.body) {
        const body = document.createElement('div');
        body.className = 'agentx-modal-body';
        body.textContent = config.body;
        modal.append(body);
      }

      let input = null;
      if (config.withInput) {
        const label = document.createElement('label');
        label.textContent = config.label || '';
        input = document.createElement('input');
        input.type = 'text';
        input.value = config.value || '';
        if (config.placeholder) {
          input.placeholder = config.placeholder;
        }
        label.append(input);
        modal.append(label);
      }

      const actions = document.createElement('div');
      actions.className = 'agentx-modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'secondary-button';
      cancelBtn.textContent = window.AgentXI18n?.t?.('common.cancel') || 'Cancel';
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = config.danger ? 'danger-button' : 'primary-button';
      confirmBtn.textContent = config.confirmText || window.AgentXI18n?.t?.('common.confirm') || 'Confirm';
      actions.append(cancelBtn, confirmBtn);
      modal.append(actions);
      backdrop.append(modal);

      const close = (confirmed) => {
        document.removeEventListener('keydown', onKeydown, true);
        backdrop.remove();
        if (previousFocus && typeof previousFocus.focus === 'function') {
          previousFocus.focus();
        }
        resolve({ confirmed, value: input ? input.value : '' });
      };

      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close(false);
          return;
        }
        if (event.key === 'Enter' && input && event.target === input) {
          event.preventDefault();
          close(true);
          return;
        }
        if (event.key === 'Tab') {
          const focusables = modal.querySelectorAll('button, input');
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (event.shiftKey && event.target === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && event.target === last) {
            event.preventDefault();
            first.focus();
          }
        }
      };

      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
          close(false);
        }
      });
      cancelBtn.addEventListener('click', () => close(false));
      confirmBtn.addEventListener('click', () => close(true));
      document.addEventListener('keydown', onKeydown, true);

      document.body.append(backdrop);
      (input || confirmBtn).focus();
    });
  }

  function confirmDialog(options) {
    return openModal({ ...(options || {}), withInput: false }).then((result) => result.confirmed);
  }

  function promptDialog(options) {
    return openModal({ ...(options || {}), withInput: true }).then((result) => (
      result.confirmed ? result.value : null
    ));
  }

  function splitChipValues(raw) {
    return String(raw || '')
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index);
  }

  function chipInput(inputEl, options) {
    const opts = options || {};
    const suggestions = typeof opts.suggestions === 'function' ? opts.suggestions : () => [];

    const field = document.createElement('div');
    field.className = 'agentx-chip-field';
    inputEl.insertAdjacentElement('afterend', field);
    inputEl.type = 'hidden';

    const editor = document.createElement('input');
    editor.type = 'text';
    editor.placeholder = opts.placeholder || inputEl.placeholder || '';
    editor.setAttribute('autocomplete', 'off');

    const suggest = document.createElement('div');
    suggest.className = 'agentx-chip-suggest';
    suggest.hidden = true;

    let chips = splitChipValues(inputEl.value);

    function commit() {
      inputEl.value = chips.join(', ');
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function renderChips() {
      field.querySelectorAll('.agentx-chip').forEach((chip) => chip.remove());
      for (const value of chips) {
        const chip = document.createElement('span');
        chip.className = 'agentx-chip';
        const text = document.createElement('span');
        text.textContent = value;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', `移除 ${value}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          chips = chips.filter((item) => item !== value);
          commit();
          renderChips();
        });
        chip.append(text, remove);
        field.insertBefore(chip, editor);
      }
    }

    function addChip(value) {
      const cleaned = String(value || '').trim();
      if (!cleaned || chips.includes(cleaned)) {
        return;
      }
      chips.push(cleaned);
      commit();
      renderChips();
    }

    function renderSuggestions() {
      const query = editor.value.trim().toLowerCase();
      const matches = suggestions()
        .filter((item) => item && !chips.includes(item))
        .filter((item) => !query || String(item).toLowerCase().includes(query))
        .slice(0, 8);
      suggest.replaceChildren();
      if (matches.length === 0) {
        suggest.hidden = true;
        return;
      }
      for (const match of matches) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = match;
        button.addEventListener('mousedown', (event) => {
          event.preventDefault();
          addChip(match);
          editor.value = '';
          renderSuggestions();
        });
        suggest.append(button);
      }
      suggest.hidden = false;
    }

    editor.addEventListener('input', renderSuggestions);
    editor.addEventListener('focus', renderSuggestions);
    editor.addEventListener('blur', () => {
      window.setTimeout(() => {
        suggest.hidden = true;
      }, 120);
      if (editor.value.trim()) {
        addChip(editor.value);
        editor.value = '';
      }
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        addChip(editor.value);
        editor.value = '';
        renderSuggestions();
      } else if (event.key === 'Backspace' && !editor.value && chips.length > 0) {
        chips = chips.slice(0, -1);
        commit();
        renderChips();
      }
    });

    field.append(editor, suggest);
    renderChips();

    return {
      sync() {
        chips = splitChipValues(inputEl.value);
        renderChips();
      }
    };
  }

  window.AgentXUI = {
    toast,
    confirm: confirmDialog,
    prompt: promptDialog,
    chipInput
  };
})();
