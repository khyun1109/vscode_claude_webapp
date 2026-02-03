// ═══════════════════════════════════════════
// VSClaude WebApp - Client Application
// ═══════════════════════════════════════════

const tabsContainer = document.getElementById('tabsContainer');
const chatContent = document.getElementById('chatContent');
const chatContainer = document.getElementById('chatContainer');
const connectionStatus = document.getElementById('connectionStatus');
const connectionText = document.getElementById('connectionText');
const messageInput = document.getElementById('messageInput');
const scrollBottomBtn = document.getElementById('scrollBottomBtn');

let cascades = [];
let currentCascadeId = null;
let ws = null;
let isSending = false;
let followBottom = true;
let updatePending = false;
let lastHtml = '';
let forceBottomOnNextUpdate = false;

const SCROLL_THRESHOLD = 24;
const COLLAPSE_HEIGHT = 150;
const CODE_COLLAPSE_HEIGHT = 150;

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function isAtBottom() {
  return chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - SCROLL_THRESHOLD;
}

function updateScrollButtonVisibility() {
  if (isAtBottom()) {
    scrollBottomBtn.classList.add('at-bottom');
  } else {
    scrollBottomBtn.classList.remove('at-bottom');
  }
}

// --- Textarea auto-resize ---

messageInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
});

// --- Message decoration ---

/**
 * FIX #9: Removed duplicated 5-strategy user turn detection.
 * The server (captureHTML in cdp.js) already marks user turns with
 * data-user-turn="true" and data-msg-type="user"/"assistant".
 * The client now only handles:
 *  - Styling server-marked turns
 *  - Collapse/expand toggle for long messages
 *  - Class-based recovery for lost attributes (DOM patching)
 */
function decorateMessages() {
  const root = chatContent.querySelector('#claude-root');
  if (!root) return;

  // Server marks user turns with data-user-turn="true" during HTML capture
  const userTurns = root.querySelectorAll('[data-user-turn="true"]');

  userTurns.forEach(el => {
    if (!el.getAttribute('data-msg-styled')) {
      el.setAttribute('data-msg-type', 'user');
      el.setAttribute('data-msg-styled', 'true');
    }

    // Ensure content wrapper exists for collapse functionality (direct children only)
    let contentWrapper = el.querySelector(':scope > .user-msg-content');
    let toggleBtn = el.querySelector(':scope > .user-msg-toggle');

    if (!contentWrapper) {
      contentWrapper = document.createElement('div');
      contentWrapper.className = 'user-msg-content';
      while (el.firstChild) {
        contentWrapper.appendChild(el.firstChild);
      }
      el.appendChild(contentWrapper);
    }

    if (!toggleBtn) {
      requestAnimationFrame(() => {
        if (el.querySelector('.user-msg-toggle')) return;

        const wasCollapsed = el.getAttribute('data-collapsed') === 'true';
        if (wasCollapsed) el.removeAttribute('data-collapsed');

        const fullHeight = contentWrapper.scrollHeight;
        if (fullHeight > COLLAPSE_HEIGHT + 40) {
          el.setAttribute('data-collapsed', 'true');
          const btn = document.createElement('button');
          btn.className = 'user-msg-toggle';
          btn.textContent = 'Show more';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const isCollapsed = el.getAttribute('data-collapsed') === 'true';
            if (isCollapsed) {
              el.removeAttribute('data-collapsed');
              btn.textContent = 'Show less';
            } else {
              el.setAttribute('data-collapsed', 'true');
              btn.textContent = 'Show more';
            }
          });
          el.appendChild(btn);
        } else if (wasCollapsed) {
          el.removeAttribute('data-collapsed');
        }
      });
    }
  });

  // Mark non-user turns as assistant (siblings of user turns)
  userTurns.forEach(el => {
    const parent = el.parentElement;
    if (!parent) return;
    Array.from(parent.children).forEach(sibling => {
      if (sibling === el) return;
      if (sibling.tagName !== 'DIV') return;
      if (sibling.getAttribute('data-msg-styled')) return;
      if (sibling.getAttribute('data-user-turn') === 'true') return;
      const text = (sibling.innerText || '').trim();
      if (text.length < 2) return;
      sibling.setAttribute('data-msg-type', 'assistant');
      sibling.setAttribute('data-msg-styled', 'true');
    });
  });

}

// Debug helper
window.debugTurns = function() {
  const root = chatContent.querySelector('#claude-root');
  if (!root) return { error: 'No #claude-root' };
  const userTurns = root.querySelectorAll('[data-user-turn="true"]');
  const allStyled = root.querySelectorAll('[data-msg-type]');
  return {
    userTurns: userTurns.length,
    totalStyled: allStyled.length,
    users: Array.from(userTurns).map(el => ({
      text: (el.innerText || '').trim().substring(0, 80),
      class: (el.className || '').toString().substring(0, 50)
    }))
  };
};

// --- Diff colorization ---

function colorizeDiffs() {
  const root = chatContent.querySelector('#claude-root');
  if (!root) return;
  root.querySelectorAll('.vsc-diff-block code').forEach(codeEl => {
    if (codeEl.getAttribute('data-diff-colored')) return;
    codeEl.setAttribute('data-diff-colored', 'true');
    const text = codeEl.textContent || '';
    const lines = text.split('\n');
    codeEl.textContent = '';
    lines.forEach((line, i) => {
      const span = document.createElement('span');
      if (line.startsWith('+ ')) {
        span.className = 'diff-add';
      } else if (line.startsWith('- ')) {
        span.className = 'diff-del';
      } else {
        span.className = 'diff-ctx';
      }
      span.textContent = line;
      codeEl.appendChild(span);
      if (i < lines.length - 1) codeEl.appendChild(document.createTextNode('\n'));
    });
  });
}

// --- Collapsible code blocks ---

function collapseOverflows() {
  const root = chatContent.querySelector('#claude-root');
  if (!root) return;

  const targets = [];
  root.querySelectorAll('.vsc-diff-block').forEach(el => targets.push(el));
  root.querySelectorAll('.Fo pre, .Fo.Wo pre').forEach(el => targets.push(el));

  targets.forEach(el => {
    if (el.getAttribute('data-collapse-init')) return;
    el.setAttribute('data-collapse-init', 'true');

    requestAnimationFrame(() => {
      if (el.scrollHeight <= CODE_COLLAPSE_HEIGHT + 40) return;

      el.setAttribute('data-code-collapsed', 'true');
      const btn = document.createElement('button');
      btn.className = 'code-collapse-toggle';
      btn.textContent = 'Show more';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const collapsed = el.getAttribute('data-code-collapsed') === 'true';
        if (collapsed) {
          el.removeAttribute('data-code-collapsed');
          btn.textContent = 'Show less';
        } else {
          el.setAttribute('data-code-collapsed', 'true');
          btn.textContent = 'Show more';
        }
      });
      el.parentElement.insertBefore(btn, el.nextSibling);
    });
  });
}

function cleanupDom() {
  const root = chatContent.querySelector('#claude-root');
  if (!root) return;
  root.querySelectorAll('[class*="group-hover:opacity-100"], [class*="opacity-0"][class*="group-hover:opacity-100"]').forEach(el => el.remove());
}

// --- DOM Patching ---

const PRESERVE_ATTRS = ['data-msg-type', 'data-msg-styled', 'data-collapsed', 'data-user-turn', 'data-code-collapsed', 'data-collapse-init', 'data-diff-colored'];

function patchNode(oldNode, newNode) {
  if (!oldNode || !newNode) return;
  if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
    oldNode.replaceWith(newNode.cloneNode(true));
    return;
  }

  if (oldNode.nodeType === Node.TEXT_NODE) {
    if (oldNode.textContent !== newNode.textContent) {
      oldNode.textContent = newNode.textContent;
    }
    return;
  }

  if (oldNode.nodeType === Node.ELEMENT_NODE) {
    const saved = {};
    for (const a of PRESERVE_ATTRS) {
      const v = oldNode.getAttribute(a);
      if (v !== null) saved[a] = v;
    }

    const oldAttrs = oldNode.attributes;
    const newAttrs = newNode.attributes;
    for (let i = oldAttrs.length - 1; i >= 0; i--) {
      const name = oldAttrs[i].name;
      if (!newNode.hasAttribute(name) && !PRESERVE_ATTRS.includes(name)) {
        oldNode.removeAttribute(name);
      }
    }
    for (let i = 0; i < newAttrs.length; i++) {
      const attr = newAttrs[i];
      if (oldNode.getAttribute(attr.name) !== attr.value) {
        oldNode.setAttribute(attr.name, attr.value);
      }
    }

    for (const [a, v] of Object.entries(saved)) {
      if (!newNode.hasAttribute(a)) {
        oldNode.setAttribute(a, v);
      }
    }

    const oldWrapper = oldNode.querySelector(':scope > .user-msg-content');
    const effectiveOld = oldWrapper || oldNode;

    const oldChildren = Array.from(effectiveOld.childNodes).filter(c => {
      if (c.nodeType !== Node.ELEMENT_NODE || !c.classList) return true;
      if (c.classList.contains('user-msg-toggle')) return false;
      if (c.classList.contains('user-msg-label')) return false;
      if (c.classList.contains('code-collapse-toggle')) return false;
      if (!oldWrapper && c.classList.contains('user-msg-content')) return false;
      return true;
    });
    const newChildren = Array.from(newNode.childNodes);
    const max = Math.max(oldChildren.length, newChildren.length);
    for (let i = 0; i < max; i++) {
      const oldChild = oldChildren[i];
      const newChild = newChildren[i];
      if (!oldChild && newChild) {
        const toggle = oldNode.querySelector(':scope > .user-msg-toggle');
        if (toggle) {
          if (oldWrapper) {
            oldWrapper.appendChild(newChild.cloneNode(true));
          } else {
            oldNode.insertBefore(newChild.cloneNode(true), toggle);
          }
        } else {
          effectiveOld.appendChild(newChild.cloneNode(true));
        }
      } else if (oldChild && !newChild) {
        oldChild.remove();
      } else if (oldChild && newChild) {
        patchNode(oldChild, newChild);
      }
    }
  }
}

function applyDomDiff(html) {
  if (!html || html === lastHtml) return;
  lastHtml = html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const newRoot = doc.querySelector('#claude-root');
  const oldRoot = chatContent.querySelector('#claude-root');
  if (!newRoot) return;
  if (!oldRoot) {
    chatContent.textContent = '';
    chatContent.appendChild(newRoot.cloneNode(true));
    return;
  }
  patchNode(oldRoot, newRoot);
}

// --- Connection ---

function setConnectionState(state, label) {
  connectionStatus.classList.remove('connected', 'error');
  if (state === 'connected') connectionStatus.classList.add('connected');
  if (state === 'error') connectionStatus.classList.add('error');
  connectionText.textContent = label;
}

function connect() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProto}//${location.host}`);
  setConnectionState('connecting', 'Connecting...');

  ws.onopen = () => {
    setConnectionState('connected', 'Live');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'cascade_list') {
        cascades = data.cascades || [];
        renderTabs();
        if (!currentCascadeId && cascades.length > 0) {
          selectCascade(cascades[0].id);
        }
      }

      if (data.type === 'snapshot_update') {
        if (data.cascadeId === currentCascadeId) {
          updateContentOnly(currentCascadeId);
        }
      }
    } catch (e) {
      console.error('WebSocket message parse error:', e);
    }
  };

  ws.onerror = () => {
    setConnectionState('error', 'Offline');
  };

  ws.onclose = () => {
    setConnectionState('error', 'Offline');
    setTimeout(connect, 2000);
  };
}

// --- Tabs ---

function renderTabs() {
  if (cascades.length === 0) {
    tabsContainer.innerHTML = '<div class="tab tab-empty">No AI chat targets found</div>';
    return;
  }

  tabsContainer.innerHTML = '';
  cascades.forEach((c) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (c.id === currentCascadeId ? ' active' : '') + (c.active ? ' active-window' : '');
    tab.addEventListener('click', () => selectCascade(c.id));
    const dot = document.createElement('div');
    dot.className = 'tab-dot';

    const project = c.projectName || '';
    const title = c.title || 'AI Chat';

    if (project) {
      const projSpan = document.createElement('span');
      projSpan.className = 'tab-project';
      projSpan.textContent = project;
      const sep = document.createElement('span');
      sep.className = 'tab-sep';
      sep.textContent = '/';
      const titleSpan = document.createElement('span');
      titleSpan.textContent = title;
      tab.appendChild(dot);
      tab.appendChild(projSpan);
      tab.appendChild(sep);
      tab.appendChild(titleSpan);
    } else {
      const span = document.createElement('span');
      span.textContent = title;
      tab.appendChild(dot);
      tab.appendChild(span);
    }
    tabsContainer.appendChild(tab);
  });
}

function selectCascade(id) {
  currentCascadeId = id;
  renderTabs();
  loadCascade(id);
  fetchMode();
}

// --- Content loading ---

async function loadCascade(id) {
  try {
    const styleRes = await fetch(`/styles/${id}`);
    if (styleRes.ok) {
      const styleData = await styleRes.json();
      document.getElementById('cascade-dynamic-style').textContent = styleData.css || '';
    }
    await updateContentOnly(id);
  } catch (e) {
    console.error(e);
  }
}

async function updateContentOnly(id) {
  if (updatePending) return;
  updatePending = true;
  try {
    const res = await fetch(`/snapshot/${id}`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();

    requestAnimationFrame(() => {
      const prevScrollTop = chatContainer.scrollTop;
      const prevScrollHeight = chatContainer.scrollHeight;
      const wasAtBottom = prevScrollHeight > 0 && isAtBottom();

      const html = data.html || '';
      applyDomDiff(html);
      cleanupDom();
      decorateMessages();
      colorizeDiffs();
      collapseOverflows();

      const shouldStick = forceBottomOnNextUpdate || followBottom || wasAtBottom;
      if (shouldStick) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      } else {
        const delta = chatContainer.scrollHeight - prevScrollHeight;
        chatContainer.scrollTop = Math.max(0, prevScrollTop + delta);
      }
      forceBottomOnNextUpdate = false;
      updateScrollButtonVisibility();
      updatePending = false;
    });
  } catch (e) {
    updatePending = false;
  }
}

// --- Send message ---

async function sendMessage() {
  const text = messageInput.value;
  if (!text || !currentCascadeId || isSending) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';
  isSending = true;

  try {
    const res = await fetch(`/send/${currentCascadeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    if (!res.ok) {
      let reason = 'Send failed';
      try {
        const data = await res.json();
        reason = data.reason || data.error || reason;
      } catch (e) {}
      throw new Error(reason);
    }
    forceBottomOnNextUpdate = true;
    updateContentOnly(currentCascadeId);
  } catch (e) {
    console.error('Send failed', e);
    messageInput.value = text;
  } finally {
    setTimeout(() => { isSending = false; }, 200);
  }
}

document.getElementById('sendBtn').onclick = sendMessage;

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// --- Scroll handling ---

chatContainer.addEventListener('scroll', () => {
  followBottom = isAtBottom();
  updateScrollButtonVisibility();
});

scrollBottomBtn.addEventListener('click', () => {
  followBottom = true;
  forceBottomOnNextUpdate = true;
  chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
  updateScrollButtonVisibility();
});

// --- Click forwarding ---

chatContent.addEventListener('click', async (e) => {
  if (!currentCascadeId) return;

  const target = e.target;
  const clickable = target.closest('button, [role="button"], [role="option"], [role="menuitem"], input[type="radio"], input[type="checkbox"], label, [tabindex="0"], [data-state]');
  if (!clickable) return;

  const getText = (el) => {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    const title = el.getAttribute('title');
    if (title) return title.trim();
    const innerText = (el.innerText || el.textContent || '').trim();
    if (innerText && innerText.length < 100) return innerText;
    const value = el.getAttribute('value');
    if (value) return value.trim();
    return null;
  };

  const text = getText(clickable);
  if (!text || text.length < 1) return;

  if (clickable.classList.contains('user-msg-toggle')) return;
  if (clickable.classList.contains('code-collapse-toggle')) return;
  const lowerText = text.toLowerCase();
  if (lowerText.includes('copy') || lowerText.includes('copied')) return;

  console.log(`[Click] Forwarding click: "${text}"`);

  try {
    const res = await fetch(`/click/${currentCascadeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (res.ok) {
      forceBottomOnNextUpdate = true;
      setTimeout(() => updateContentOnly(currentCascadeId), 200);
      setTimeout(() => updateContentOnly(currentCascadeId), 600);
    }
  } catch (err) {
    console.error('Click forward failed:', err);
  }
});

// --- Mode switch ---

const modeBtn = document.getElementById('modeBtn');
const modeLabel = document.getElementById('modeLabel');

async function fetchMode() {
  if (!currentCascadeId) return;
  try {
    const res = await fetch(`/mode/${currentCascadeId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.mode) modeLabel.textContent = data.mode;
    }
  } catch {}
}

modeBtn.addEventListener('click', async () => {
  if (!currentCascadeId) return;
  modeLabel.textContent = '...';
  try {
    const res = await fetch(`/mode/${currentCascadeId}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.mode) modeLabel.textContent = data.mode;
    }
  } catch {}
});

// --- Past conversations ---

const historyBtn = document.getElementById('historyBtn');
const convPanel = document.getElementById('convPanel');
let convPanelOpen = false;

function closeConvPanel() {
  convPanelOpen = false;
  convPanel.classList.remove('open');
  historyBtn.classList.remove('active');
}

historyBtn.addEventListener('click', async () => {
  if (convPanelOpen) { closeConvPanel(); return; }
  if (!currentCascadeId) return;

  convPanelOpen = true;
  convPanel.classList.add('open');
  historyBtn.classList.add('active');
  convPanel.innerHTML = '<div class="conv-loading">Loading...</div>';

  try {
    const res = await fetch(`/conversations/${currentCascadeId}`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    const items = data.items || [];

    if (items.length === 0) {
      convPanel.innerHTML = '<div class="conv-loading">No conversations</div>';
      return;
    }

    convPanel.innerHTML = '';
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'conv-item' + (item.active ? ' active-conv' : '');
      const titleSpan = document.createElement('span');
      titleSpan.className = 'conv-title';
      titleSpan.textContent = item.title;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'conv-time';
      timeSpan.textContent = item.time;
      btn.appendChild(titleSpan);
      btn.appendChild(timeSpan);
      btn.addEventListener('click', async () => {
        closeConvPanel();
        try {
          await fetch(`/conversations/${currentCascadeId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: item.title })
          });
          forceBottomOnNextUpdate = true;
          setTimeout(() => updateContentOnly(currentCascadeId), 500);
          setTimeout(() => updateContentOnly(currentCascadeId), 1500);
        } catch (e) {
          console.error('Switch conversation failed:', e);
        }
      });
      convPanel.appendChild(btn);
    });
  } catch (e) {
    convPanel.innerHTML = '<div class="conv-loading">Failed to load</div>';
  }
});

document.addEventListener('click', (e) => {
  if (convPanelOpen && !convPanel.contains(e.target) && e.target !== historyBtn) {
    closeConvPanel();
  }
});

// --- Push notifications ---

let VAPID_PUBLIC_KEY = null;
const notifBtn = document.getElementById('notifBtn');
let pushSubscription = null;

async function fetchVapidKey() {
  try {
    const res = await fetch('/vapid-public-key');
    const data = await res.json();
    VAPID_PUBLIC_KEY = data.publicKey;
  } catch (e) {
    console.error('Failed to fetch VAPID key:', e);
  }
}
fetchVapidKey();

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function setNotifState(on) {
  if (on) {
    notifBtn.textContent = '\u{1F514} On';
    notifBtn.classList.add('active');
    notifBtn.title = 'Push notifications enabled (tap to disable)';
  } else {
    notifBtn.textContent = '\u{1F515} Off';
    notifBtn.classList.remove('active');
    notifBtn.title = 'Push notifications disabled (tap to enable)';
    pushSubscription = null;
  }
}

async function togglePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    notifBtn.textContent = '\u{1F515} N/A';
    notifBtn.title = 'Push notifications not supported';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    const existing = await reg.pushManager.getSubscription();
    if (existing && pushSubscription) {
      await fetch('/push-unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existing.toJSON())
      }).catch(() => {});
      await existing.unsubscribe();
      setNotifState(false);
      return;
    }

    if (!VAPID_PUBLIC_KEY) await fetchVapidKey();
    if (!VAPID_PUBLIC_KEY) throw new Error('VAPID key not available');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      notifBtn.textContent = '\u{1F515} Denied';
      notifBtn.title = 'Notification permission denied';
      return;
    }
    if (existing) {
      try { await existing.unsubscribe(); } catch {}
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    pushSubscription = sub;
    await fetch('/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON())
    });
    setNotifState(true);
  } catch (err) {
    console.error('Push toggle failed:', err);
    notifBtn.textContent = '\u{1F515} Error';
    notifBtn.title = (err.message || String(err));
  }
}

notifBtn.addEventListener('click', togglePush);

// Auto-check if already subscribed
(async () => {
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        pushSubscription = sub;
        setNotifState(true);
        fetch('/push-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON())
        }).catch(() => {});
      }
    } catch {}
  }
})();

// --- Init ---

connect();
setTimeout(fetchMode, 3000);
