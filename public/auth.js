(function () {
  const TOKEN_KEY = 'agentx.auth.token';
  const USER_KEY = 'agentx.auth.user';
  const apiBase = window.location.origin.replace(/\/$/, '');
  const memoryStorage = new Map();

  function safeStorageGet(key) {
    try {
      const value = window.localStorage.getItem(key);
      if (value !== null) memoryStorage.set(key, value);
      return value ?? memoryStorage.get(key) ?? null;
    } catch {
      return memoryStorage.get(key) ?? null;
    }
  }

  function safeStorageSet(key, value) {
    memoryStorage.set(key, String(value));
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // In-memory fallback keeps the current page usable when storage is blocked.
    }
  }

  function safeStorageRemove(key) {
    memoryStorage.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage may be unavailable in strict privacy contexts.
    }
  }

  function getToken() {
    return safeStorageGet(TOKEN_KEY);
  }

  function getUser() {
    const raw = safeStorageGet(USER_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function setToken(token) {
    safeStorageSet(TOKEN_KEY, token);
  }

  function setSession(payload) {
    setToken(payload.token);
    safeStorageSet(USER_KEY, JSON.stringify(payload.user));
  }

  function setUser(user) {
    if (!user || typeof user !== 'object') {
      safeStorageRemove(USER_KEY);
      return;
    }
    safeStorageSet(USER_KEY, JSON.stringify(user));
  }

  function clearToken() {
    safeStorageRemove(TOKEN_KEY);
    safeStorageRemove(USER_KEY);
  }

  function loginUrlForCurrentPage() {
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (!current || current === '/login' || current.startsWith('/login?')) {
      return '/login';
    }
    return `/login?next=${encodeURIComponent(current)}`;
  }

  async function authFetch(path, options = {}) {
    const token = getToken();
    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${apiBase}${path}`, { ...options, headers });
    if (response.status === 401) {
      // keepTokenOn401: in --no-auth mode the server's /auth/me may return 401
      // because the auth endpoint is disabled, but the user's stored JWT/role
      // is still valid for UI navigation. Allow the caller to opt out of the
      // clearToken() side-effect so renderPortalAuth can keep the admin link.
      if (!options.keepTokenOn401) {
        clearToken();
      }
      if (!options.skipAuthRedirect) {
        window.location.assign(loginUrlForCurrentPage());
      }
    }
    return response;
  }

  async function login(username, password) {
    const response = await fetch(`${apiBase}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      throw new Error('Login failed');
    }
    const payload = await response.json();
    setSession(payload);
    return payload;
  }

  function requireLogin(redirectTarget = '/login') {
    if (!getToken()) {
      window.location.replace(redirectTarget === '/login' ? loginUrlForCurrentPage() : redirectTarget);
      return false;
    }
    return true;
  }

  function logout() {
    clearToken();
    window.location.assign('/login');
  }

  function openAuthorizedEventStream(sessionId) {
    if (!getToken()) {
      throw new Error('Missing token');
    }
    const controller = new AbortController();
    const listeners = new Map();
    let closed = false;
    const stream = {
      onerror: null,
      addEventListener(type, listener) {
        const registered = listeners.get(type) || new Set();
        registered.add(listener);
        listeners.set(type, registered);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      close() {
        if (closed) return;
        closed = true;
        controller.abort();
        listeners.clear();
      }
    };

    function dispatch(type, event) {
      for (const listener of listeners.get(type) || []) {
        listener.call(stream, event);
      }
      if (type === 'error' && typeof stream.onerror === 'function') {
        stream.onerror.call(stream, event);
      }
    }

    function dispatchEventBlock(block) {
      let eventType = 'message';
      const data = [];
      for (const line of block.split(/\r\n|\r|\n/)) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        let value = separator === -1 ? '' : line.slice(separator + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventType = value || 'message';
        if (field === 'data') data.push(value);
      }
      if (data.length > 0) {
        dispatch(eventType, { type: eventType, data: data.join('\n') });
      }
    }

    void (async () => {
      try {
        const response = await authFetch(`/sessions/${encodeURIComponent(sessionId)}/stream`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`Event stream request failed (${response.status})`);
        }
        if (!response.body) {
          throw new Error('Event stream response has no body');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          // Keep raw line endings in the shared buffer. A CRLF pair may be
          // split across network chunks, so normalizing each chunk separately
          // can lose the blank line that terminates an SSE event.
          buffer += decoder.decode(value, { stream: true });
          // Normalize only complete line endings. A trailing CR is retained
          // until the next chunk so one CRLF can never be misread as the two
          // line endings that terminate an event block.
          buffer = buffer.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            dispatchEventBlock(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
          }
        }
        if (!closed) {
          throw new Error('Event stream ended before it was closed');
        }
      } catch (error) {
        if (!closed && error?.name !== 'AbortError') {
          dispatch('error', { type: 'error', error });
        }
      }
    })();

    return stream;
  }

  window.AgentXAuth = {
    apiBase,
    authFetch,
    clearToken,
    getToken,
    getUser,
    login,
    logout,
    openAuthorizedEventStream,
    requireLogin,
    setSession,
    setToken,
    setUser
  };
})();
