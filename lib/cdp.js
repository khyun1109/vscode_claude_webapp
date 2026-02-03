import http from 'http';
import crypto from 'crypto';
import WebSocket from 'ws';
import {
  ROOT_SELECTORS, INPUT_SELECTORS, SEND_SELECTORS,
  MIN_TEXT_LEN, CASCADE_WRAPPER_ID, MAX_HTTP_RESPONSE_BYTES, CDP_CALL_TIMEOUT
} from './config.js';

// --- Helpers ---

export function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function safeJSString(text) {
  return JSON.stringify(String(text));
}

export const normalize = (value) => (value || '').toString().toLowerCase();

export function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_HTTP_RESPONSE_BYTES) {
          req.destroy();
          resolve([]);
          return;
        }
        data += chunk;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve([]);
    });
  });
}

// --- CDP Connection ---

function isLocalWebSocketUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Connect to a CDP target via WebSocket.
 * FIX #2: Added timeout to call() and explicit cleanup() method.
 */
export async function connectCDP(url) {
  if (!isLocalWebSocketUrl(url)) {
    throw new Error(`Refused non-local WebSocket URL: ${url}`);
  }
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const onOpen = () => { ws.off('error', onErr); resolve(); };
    const onErr = (e) => { ws.off('open', onOpen); reject(e); };
    ws.once('open', onOpen);
    ws.once('error', onErr);
  });

  let idCounter = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = idCounter++;
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.off('message', handler);
      reject(new Error(`CDP call timeout: ${method}`));
    }, CDP_CALL_TIMEOUT);

    const handler = (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.id === id) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          ws.off('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const contexts = [];
  const contextHandler = (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.method === 'Runtime.executionContextCreated') {
        contexts.push(data.params.context);
      } else if (data.method === 'Runtime.executionContextDestroyed') {
        const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
        if (idx !== -1) contexts.splice(idx, 1);
      }
    } catch {}
  };
  ws.on('message', contextHandler);

  const cleanup = () => {
    ws.off('message', contextHandler);
    ws.removeAllListeners();
    try { ws.close(); } catch {}
  };

  ws.on('close', cleanup);

  await call('Runtime.enable', {});
  await new Promise(r => setTimeout(r, 300));

  return { ws, call, contexts, rootContextId: null, cleanup };
}

// --- Context Evaluation ---

function getContextIds(cdp) {
  const ids = new Set();
  const ordered = [];
  if (cdp.rootContextId) {
    ids.add(cdp.rootContextId);
    ordered.push(cdp.rootContextId);
  }
  for (const ctx of cdp.contexts) {
    if (!ids.has(ctx.id)) {
      ids.add(ctx.id);
      ordered.push(ctx.id);
    }
  }
  return ordered;
}

export async function evaluateInContexts(cdp, expression, options = {}) {
  const { awaitPromise = false, validator } = options;
  const baseParams = { expression, returnByValue: true };
  if (awaitPromise) baseParams.awaitPromise = true;

  const tryEval = async (contextId) => {
    const params = { ...baseParams };
    if (contextId !== null && contextId !== undefined) params.contextId = contextId;
    return cdp.call('Runtime.evaluate', params);
  };

  const contexts = getContextIds(cdp);
  for (const contextId of contexts) {
    try {
      const res = await tryEval(contextId);
      const value = res?.result?.value;
      if (!validator || validator(value)) {
        return { value, contextId };
      }
    } catch {}
  }

  try {
    const res = await tryEval(null);
    const value = res?.result?.value;
    if (!validator || validator(value)) {
      return { value, contextId: null };
    }
  } catch {}

  return null;
}

// --- Capture Functions ---

export async function extractMetadata(cdp) {
  const SCRIPT = `(() => {
    const selectors = ${JSON.stringify(ROOT_SELECTORS)};
    const minTextLen = ${MIN_TEXT_LEN};
    const isWorkbench = !!document.querySelector('.monaco-workbench, #workbench')
      || (document.body && document.body.className && document.body.className.includes('monaco-workbench'));

    if (isWorkbench) return { found: false };

    const findRoot = () => {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch (e) { }
      }
      return document.body || document.documentElement;
    };

    const root = findRoot();
    if (!root) return { found: false };
    const text = (root.innerText || '').trim();
    if (text.length < minTextLen) return { found: false };

    let title = document.title || null;
    const titleSelectors = ['h1', 'h2', '[data-testid*="title" i]', '[class*="title" i]'];
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length > 2) {
        title = el.textContent.trim();
        break;
      }
    }

    return {
      found: true,
      chatTitle: title || 'Claude',
      isActive: document.hasFocus()
    };
  })()`;

  const result = await evaluateInContexts(cdp, SCRIPT, {
    validator: (value) => value && value.found
  });

  if (!result) return null;
  if (result.contextId !== null && result.contextId !== undefined) {
    cdp.rootContextId = result.contextId;
  }
  return { ...result.value, contextId: result.contextId };
}

export async function captureCSS(cdp) {
  const SCRIPT = `(() => {
    const isWorkbench = !!document.querySelector('.monaco-workbench, #workbench')
      || (document.body && document.body.className && document.body.className.includes('monaco-workbench'));
    if (isWorkbench) return { css: '' };

    let css = '';
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          let text = rule.cssText;
          text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1#${CASCADE_WRAPPER_ID}');
          text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1#${CASCADE_WRAPPER_ID}');
          text = text.replace(/(^|[\\s,}]):root(?=[\\s,{])/gi, '$1#${CASCADE_WRAPPER_ID}');
          css += text + '\\n';
        }
      } catch (e) { }
    }
    return { css };
  })()`;

  const result = await evaluateInContexts(cdp, SCRIPT, {
    validator: (value) => value && typeof value.css === 'string'
  });
  if (!result) return '';
  if (result.contextId !== null && result.contextId !== undefined) {
    cdp.rootContextId = result.contextId;
  }
  return result.value?.css || '';
}

export async function captureHTML(cdp, options = {}) {
  const keepInputs = !!options.keepInputs;
  const SCRIPT = `(() => {
    const keepInputs = ${keepInputs ? 'true' : 'false'};
    const isWorkbench = !!document.querySelector('.monaco-workbench, #workbench')
      || (document.body && document.body.className && document.body.className.includes('monaco-workbench'));
    if (isWorkbench) return { error: 'workbench' };

    const selectors = ${JSON.stringify(ROOT_SELECTORS)};
    const removeSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const removeContainerSelectors = [
      'form',
      '[role="form"]',
      '[data-testid*="composer" i]',
      '[data-testid*="prompt" i]',
      '[data-testid*="input" i]',
      '[data-testid*="chat-input" i]',
      '[aria-label*="prompt" i]',
      '[aria-label*="message" i]',
      '[class*="composer" i]',
      '[class*="prompt" i]',
      '[class*="input" i]',
      '[class*="chat-input" i]',
      'footer'
    ];

    const findRoot = () => {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch (e) { }
      }
      return document.body || document.documentElement;
    };

    const root = findRoot();
    if (!root) return { error: 'root not found' };

    // --- Detect user message turns in original DOM and mark them ---
    const findTurnsContainer = (startEl) => {
      let cur = startEl;
      for (let d = 0; d < 15; d++) {
        const kids = Array.from(cur.children).filter(c => c.tagName === 'DIV');
        if (kids.length === 0) break;
        let best = kids[0], bestLen = (best.innerText || '').length;
        let totalLen = bestLen;
        for (let j = 1; j < kids.length; j++) {
          const len = (kids[j].innerText || '').length;
          totalLen += len;
          if (len > bestLen) { bestLen = len; best = kids[j]; }
        }
        if (kids.length <= 2 || (bestLen > totalLen * 0.7)) {
          cur = best;
        } else {
          break;
        }
      }
      return cur;
    };

    root.querySelectorAll('[data-user-turn]').forEach(el => el.removeAttribute('data-user-turn'));

    const origTurns = findTurnsContainer(root);
    const origChildren = Array.from(origTurns.children).filter(c => c.tagName === 'DIV');
    const markedElements = [];

    // --- User turn detection: Find elements with "Message actions" button ---
    // In Claude IDE, user messages have a "Message actions" button.
    // We find these buttons and mark the direct child of origTurns container as user turns.
    const markUser = (el) => {
      if (!markedElements.includes(el)) {
        el.setAttribute('data-user-turn', 'true');
        markedElements.push(el);
      }
    };

    // Build a Set of direct children for quick lookup
    const turnsChildrenSet = new Set(origChildren);

    // Find all "Message actions" buttons
    const messageActionButtons = root.querySelectorAll('button[aria-label="Message actions"], button[title="Message actions"]');

    messageActionButtons.forEach(btn => {
      // Walk up to find a direct child of origTurns container
      let current = btn;
      for (let i = 0; i < 20 && current && current !== root; i++) {
        if (turnsChildrenSet.has(current)) {
          // Found a direct child of the turns container
          markUser(current);
          break;
        }
        current = current.parentElement;
      }
    });

    console.log('[captureHTML] User turn detection: message-actions-button, marked=' + markedElements.length + ', turnsChildren=' + origChildren.length);

    // --- Clone the DOM ---
    const wrapper = document.createElement('div');
    wrapper.id = '${CASCADE_WRAPPER_ID}';
    const container = document.body || document.documentElement;
    if (container && container.children && container.children.length) {
      Array.from(container.children).forEach((child) => {
        try {
          wrapper.appendChild(child.cloneNode(true));
        } catch (e) { }
      });
    } else {
      wrapper.appendChild(root.cloneNode(true));
    }

    markedElements.forEach(el => el.removeAttribute('data-user-turn'));

    // --- Set data-msg-type on cloned DOM ---
    const clonedUserTurns = wrapper.querySelectorAll('[data-user-turn="true"]');
    clonedUserTurns.forEach(el => {
      el.setAttribute('data-msg-type', 'user');
      el.setAttribute('data-msg-styled', 'true');
    });
    clonedUserTurns.forEach(el => {
      const parent = el.parentElement;
      if (!parent) return;
      Array.from(parent.children).forEach(sibling => {
        if (sibling === el) return;
        if (sibling.tagName !== 'DIV') return;
        if (sibling.getAttribute('data-user-turn') === 'true') return;
        if (sibling.getAttribute('data-msg-styled') === 'true') return;
        const text = (sibling.innerText || sibling.textContent || '').trim();
        if (text.length < 2) return;
        sibling.setAttribute('data-msg-type', 'assistant');
        sibling.setAttribute('data-msg-styled', 'true');
      });
    });

    // --- Clean up the clone ---
    const removeMatches = (sel) => {
      try {
        wrapper.querySelectorAll(sel).forEach(el => el.remove());
      } catch (e) { }
    };

    if (!keepInputs) {
      removeSelectors.forEach(removeMatches);
      removeContainerSelectors.forEach(removeMatches);
    }
    removeMatches('script');
    removeMatches('noscript');
    removeMatches('link[rel="stylesheet"]');
    removeMatches('style');

    // --- Convert Monaco diff editors to plain-text diffs ---
    const monacoTargets = new Map();
    wrapper.querySelectorAll('.monaco-diff-editor').forEach(diffEl => {
      let target = diffEl;
      let p = diffEl.parentElement;
      while (p && p !== wrapper) {
        if (p.classList && p.classList.contains('W')) { target = p; break; }
        p = p.parentElement;
      }
      if (!monacoTargets.has(target)) {
        monacoTargets.set(target, diffEl);
      }
    });

    monacoTargets.forEach((diffEl, wParent) => {
      try {
        const modEditor = diffEl.querySelector('.editor.modified');
        const origEditor = diffEl.querySelector('.editor.original');

        const modInsertIndices = new Set();
        if (modEditor) {
          const overlays = modEditor.querySelector('.view-overlays');
          if (overlays) {
            Array.from(overlays.children).forEach((child, idx) => {
              const cls = (child.className || '').toString();
              if (cls.includes('line-insert') || cls.includes('char-insert')) {
                modInsertIndices.add(idx);
              }
              if (child.querySelector && child.querySelector('[class*="line-insert"], [class*="char-insert"]')) {
                modInsertIndices.add(idx);
              }
            });
          }
          if (modInsertIndices.size === 0) {
            const insertTops = new Set();
            modEditor.querySelectorAll('[class*="line-insert"], [class*="char-insert"]').forEach(el => {
              const st = el.getAttribute('style') || '';
              const m = st.match(/top:\\s*(\\d+(?:\\.\\d+)?px)/);
              if (m) insertTops.add(m[1]);
            });
            if (insertTops.size > 0) {
              modEditor.querySelectorAll('.view-line').forEach((vl, idx) => {
                const st = vl.getAttribute('style') || '';
                const m = st.match(/top:\\s*(\\d+(?:\\.\\d+)?px)/);
                if (m && insertTops.has(m[1])) modInsertIndices.add(idx);
              });
            }
          }
        }

        const deletedLines = [];
        if (origEditor) {
          const origDeleteIndices = new Set();
          const origOverlays = origEditor.querySelector('.view-overlays');
          if (origOverlays) {
            Array.from(origOverlays.children).forEach((child, idx) => {
              const cls = (child.className || '').toString();
              if (cls.includes('line-delete') || cls.includes('char-delete')) {
                origDeleteIndices.add(idx);
              }
              if (child.querySelector && child.querySelector('[class*="line-delete"], [class*="char-delete"]')) {
                origDeleteIndices.add(idx);
              }
            });
          }
          if (origDeleteIndices.size === 0) {
            const deleteTops = new Set();
            origEditor.querySelectorAll('[class*="line-delete"], [class*="char-delete"]').forEach(el => {
              const st = el.getAttribute('style') || '';
              const m = st.match(/top:\\s*(\\d+(?:\\.\\d+)?px)/);
              if (m) deleteTops.add(m[1]);
            });
            if (deleteTops.size > 0) {
              origEditor.querySelectorAll('.view-line').forEach((vl, idx) => {
                const st = vl.getAttribute('style') || '';
                const m = st.match(/top:\\s*(\\d+(?:\\.\\d+)?px)/);
                if (m && deleteTops.has(m[1])) origDeleteIndices.add(idx);
              });
            }
          }
          origEditor.querySelectorAll('.view-line').forEach((vl, idx) => {
            if (origDeleteIndices.has(idx)) {
              deletedLines.push((vl.textContent || '').replace(/\\u00a0/g, ' '));
            }
          });
        }

        const modLines = [];
        if (modEditor) {
          modEditor.querySelectorAll('.view-line').forEach((vl, idx) => {
            const text = (vl.textContent || '').replace(/\\u00a0/g, ' ');
            const isInsert = modInsertIndices.has(idx);
            modLines.push({ text, status: isInsert ? 'add' : 'ctx' });
          });
        }

        if (modLines.length === 0) {
          const editor = modEditor || origEditor;
          if (editor) {
            const t = (editor.textContent || '').trim().replace(/\\u00a0/g, ' ');
            if (t) t.split('\\n').forEach(l => modLines.push({ text: l, status: 'ctx' }));
          }
        }

        const diffLines = [];
        let deletesEmitted = false;
        for (const ml of modLines) {
          if (ml.status === 'add' && !deletesEmitted && deletedLines.length > 0) {
            deletedLines.forEach(l => diffLines.push('- ' + l));
            deletesEmitted = true;
          }
          diffLines.push((ml.status === 'add' ? '+ ' : '  ') + ml.text);
        }
        if (!deletesEmitted && deletedLines.length > 0) {
          deletedLines.forEach(l => diffLines.push('- ' + l));
        }
        if (diffLines.length === 0 && modLines.length > 0) {
          modLines.forEach(ml => diffLines.push('  ' + ml.text));
        }

        if (diffLines.length === 0) {
          const t = (wParent.textContent || '').trim().replace(/\\u00a0/g, ' ');
          if (t) t.split('\\n').forEach(l => diffLines.push('  ' + l));
        }

        const pre = document.createElement('pre');
        pre.className = 'vsc-diff-block';
        const code = document.createElement('code');
        code.textContent = diffLines.length > 0 ? diffLines.join('\\n') : '(empty diff)';
        pre.appendChild(code);
        wParent.replaceWith(pre);
      } catch (e) {
        try {
          const pre = document.createElement('pre');
          pre.className = 'vsc-diff-block';
          const code = document.createElement('code');
          code.textContent = (wParent.textContent || '(diff)').replace(/\\u00a0/g, ' ');
          pre.appendChild(code);
          wParent.replaceWith(pre);
        } catch (e2) {}
      }
    });

    // 2nd pass: remaining Monaco editors
    Array.from(wrapper.querySelectorAll('.monaco-diff-editor, .monaco-editor')).forEach(el => {
      try {
        const text = (el.textContent || '').trim().replace(/\\u00a0/g, ' ');
        const pre = document.createElement('pre');
        pre.className = 'vsc-diff-block';
        const code = document.createElement('code');
        code.textContent = text || '(diff)';
        pre.appendChild(code);
        let target = el;
        let p = el.parentElement;
        while (p && p !== wrapper) {
          if (p.classList && p.classList.contains('W')) { target = p; break; }
          p = p.parentElement;
        }
        target.replaceWith(pre);
      } catch (e) {
        try { el.remove(); } catch (e2) {}
      }
    });

    const bodyStyles = window.getComputedStyle(document.body || document.documentElement);
    const rootStyles = window.getComputedStyle(root);
    const docStyles = window.getComputedStyle(document.documentElement);
    const codeEl = document.querySelector('pre code, code, .monaco-editor, .monaco-editor .view-lines');
    const codeStyles = codeEl ? window.getComputedStyle(codeEl) : null;

    const themeVars = [
      '--vscode-editor-background',
      '--vscode-editor-foreground',
      '--vscode-panel-background',
      '--vscode-sideBar-background',
      '--vscode-titleBar-activeBackground',
      '--vscode-tab-activeBackground',
      '--vscode-tab-inactiveBackground',
      '--vscode-input-background',
      '--vscode-input-foreground',
      '--vscode-input-border',
      '--vscode-button-background',
      '--vscode-button-hoverBackground',
      '--vscode-focusBorder',
      '--vscode-widget-border',
      '--vscode-editorWidget-background',
      '--vscode-editorWidget-border'
    ];

    const vscodeTheme = {};
    themeVars.forEach((key) => {
      const value = docStyles.getPropertyValue(key);
      if (value && value.trim()) vscodeTheme[key] = value.trim();
    });

    return {
      html: wrapper.outerHTML,
      bodyBg: bodyStyles.backgroundColor,
      bodyColor: bodyStyles.color,
      textColor: rootStyles.color,
      fontFamily: rootStyles.fontFamily,
      fontSize: rootStyles.fontSize,
      lineHeight: rootStyles.lineHeight,
      codeFontFamily: codeStyles ? codeStyles.fontFamily : null,
      codeFontSize: codeStyles ? codeStyles.fontSize : null,
      vscodeTheme
    };
  })()`;

  const result = await evaluateInContexts(cdp, SCRIPT, {
    validator: (value) => value && !value.error && value.html
  });
  if (!result) return null;
  if (result.contextId !== null && result.contextId !== undefined) {
    cdp.rootContextId = result.contextId;
  }
  const data = result.value;
  if (data && data.html) {
    data.html = stripRemainingMonaco(data.html);
  }
  return data;
}

function stripRemainingMonaco(html) {
  const marker = '<div class="W"';
  const monacoMarker = 'monaco-diff-editor';
  let result = '';
  let i = 0;

  while (i < html.length) {
    const wPos = html.indexOf(marker, i);
    if (wPos === -1) {
      result += html.slice(i);
      break;
    }

    result += html.slice(i, wPos);

    let depth = 0;
    let j = wPos;
    let blockEnd = -1;
    while (j < html.length) {
      if (html.startsWith('<div', j)) {
        depth++;
        j = html.indexOf('>', j) + 1;
        if (j === 0) break;
      } else if (html.startsWith('</div>', j)) {
        depth--;
        j += 6;
        if (depth === 0) {
          blockEnd = j;
          break;
        }
      } else {
        j++;
      }
    }

    if (blockEnd === -1) {
      result += html.slice(wPos, wPos + 1);
      i = wPos + 1;
      continue;
    }

    const block = html.slice(wPos, blockEnd);

    if (block.includes(monacoMarker)) {
      const text = block.replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ').trim();
      if (text) {
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        result += '<pre class="vsc-diff-block"><code>' + escaped + '</code></pre>';
      }
    } else {
      result += block;
    }

    i = blockEnd;
  }

  return result;
}

// --- Inject / Click Functions ---

export async function injectMessage(cdp, text) {
  const safeText = safeJSString(text);

  const SCRIPT = `(async () => {
    const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(SEND_SELECTORS)};

    const deepQueryAll = (root, selector) => {
      const results = [];
      const seen = new Set();
      const walk = (node) => {
        if (!node) return;
        try {
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(selector)) {
              if (!seen.has(el)) {
                seen.add(el);
                results.push(el);
              }
            }
          }
        } catch (e) { }
        const children = node.children ? Array.from(node.children) : [];
        for (const child of children) {
          if (child.shadowRoot) walk(child.shadowRoot);
        }
      };
      walk(root);
      return results;
    };

    const isEditable = (el) => {
      if (!el) return false;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
      if (el.isContentEditable) return true;
      const attr = el.getAttribute && el.getAttribute('contenteditable');
      return attr === '' || attr === 'true';
    };

    const isVisible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
    };

    const findNestedEditable = (el) => {
      if (!el || !el.querySelectorAll) return null;
      const nested = el.querySelectorAll('textarea, input[type="text"], input[role="textbox"], [contenteditable="true"], [contenteditable=""], [role="textbox"]');
      for (const candidate of nested) {
        if (isEditable(candidate) && isVisible(candidate)) return candidate;
      }
      return null;
    };

    const scoreInput = (el) => {
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const distanceFromBottom = Math.abs(window.innerHeight - rect.bottom);
      let score = area - (distanceFromBottom * 5);
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (placeholder.includes('message') || placeholder.includes('prompt')) score += 5000;
      if (aria.includes('message') || aria.includes('prompt')) score += 5000;
      return score;
    };

    const pickBest = (elements) => {
      let best = null;
      let bestScore = -Infinity;
      for (const el of elements) {
        if (!isVisible(el)) continue;
        const score = scoreInput(el);
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best;
    };

    const collect = (selectors) => {
      const items = [];
      for (const sel of selectors) {
        items.push(...deepQueryAll(document, sel));
      }
      return items;
    };

    const normalizeCandidates = (elements) => {
      const output = [];
      const seen = new Set();
      for (const el of elements) {
        let candidate = el;
        if (!isEditable(candidate)) {
          candidate = findNestedEditable(candidate);
        }
        if (candidate && !seen.has(candidate)) {
          seen.add(candidate);
          output.push(candidate);
        }
      }
      return output;
    };

    const editor = pickBest(normalizeCandidates(collect(inputSelectors)));
    if (!editor) return { ok: false, reason: 'no editor found' };

    const textToInject = ${safeText};

    editor.focus();

    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (valueSetter) valueSetter.call(editor, textToInject);
      else editor.value = textToInject;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      try {
        document.execCommand('insertText', false, textToInject);
      } catch (e) {
        return { ok: true, method: 'cdp', useCdpInsert: true, useCdpEnter: true };
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const verifyInserted = () => {
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        return (editor.value || '') === textToInject;
      }
      const content = (editor.innerText || editor.textContent || '');
      return content.includes(textToInject);
    };

    if (!verifyInserted()) {
      return { ok: true, method: 'cdp', useCdpInsert: true, useCdpEnter: true };
    }

    await new Promise(r => setTimeout(r, 120));

    const sendCandidates = collect(sendSelectors);
    let sendBtn = null;
    for (const btn of sendCandidates) {
      if (!isVisible(btn)) continue;
      sendBtn = btn;
      break;
    }

    if (sendBtn) {
      sendBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      sendBtn.click();
      return { ok: true, method: 'button' };
    }

    const enterEvent = new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true,
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13
    });
    editor.dispatchEvent(enterEvent);
    editor.dispatchEvent(new KeyboardEvent('keyup', {
      bubbles: true, cancelable: true,
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13
    }));
    return { ok: true, method: 'enter' };
  })()`;

  const result = await evaluateInContexts(cdp, SCRIPT, {
    awaitPromise: true,
    validator: (value) => value && value.ok
  });

  if (result) {
    if (result.contextId !== null && result.contextId !== undefined) {
      cdp.rootContextId = result.contextId;
    }

    const value = result.value || { ok: false, reason: 'No result' };

    if (value.useCdpInsert) {
      try {
        await cdp.call('Input.insertText', { text });
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }

    if (value.useCdpEnter) {
      try {
        await cdp.call('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter',
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
        });
        await cdp.call('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter',
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
        });
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }

    return value;
  }

  return { ok: false, reason: 'No editor found' };
}

export async function clickBack(cdp) {
  const SCRIPT = `(() => {
    const selectors = [
      'button[aria-label="Back"]',
      'button[aria-label^="Back"]',
      '[role="button"][aria-label="Back"]',
      '[role="button"][aria-label^="Back"]',
      'button[title="Back"]',
      '[role="button"][title="Back"]'
    ];
    let btn = null;
    for (const sel of selectors) {
      btn = document.querySelector(sel);
      if (btn) break;
    }
    if (!btn) return { ok: false, reason: 'Back button not found' };

    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    btn.click();
    return { ok: true };
  })()`;

  const result = await evaluateInContexts(cdp, SCRIPT, {
    awaitPromise: false,
    validator: (value) => value && value.ok
  });

  if (result) {
    if (result.contextId !== null && result.contextId !== undefined) {
      cdp.rootContextId = result.contextId;
    }
    return result.value || { ok: true };
  }

  return { ok: false, reason: 'Back button not found' };
}

export async function clickByText(cdp, text) {
  const safeText = safeJSString(text);
  const SCRIPT = `(() => {
    const wanted = ${safeText}.trim().toLowerCase().replace(/\\s+/g, ' ');
    if (!wanted) return { ok: false, reason: 'empty text' };

    const isVisible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
      return rect.bottom >= 0 && rect.top <= window.innerHeight;
    };

    const normalize = (s) => (s || '').trim().toLowerCase().replace(/\\s+/g, ' ');
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex], li'));
    let best = null;
    let bestScore = -Infinity;

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = normalize(el.innerText || el.textContent || '');
      if (!text) continue;
      let score = -Math.abs(text.length - wanted.length);
      if (text === wanted) score += 1000;
      if (text.includes(wanted)) score += 500;
      if (wanted.includes(text)) score += 200;
      if (score > bestScore) {
        bestScore = score;
        best = { el, text };
      }
    }

    if (!best) return { ok: false, reason: 'no match' };
    best.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    best.el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    best.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    best.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    best.el.click();
    return { ok: true, matched: best.text };
  })()`;

  const result = await evaluateInContexts(cdp, SCRIPT, {
    awaitPromise: false,
    validator: (value) => value && value.ok
  });

  if (result) {
    if (result.contextId !== null && result.contextId !== undefined) {
      cdp.rootContextId = result.contextId;
    }
    return result.value || { ok: true };
  }

  return { ok: false, reason: 'no match' };
}

export async function clickViewAll(cdp) {
  const SCRIPT = `(() => {
    const normalize = (s) => (s || '').trim().toLowerCase().replace(/\\s+/g, ' ');
    const wanted = normalize('view all');
    const deepQueryAll = (root, selector) => {
      const results = [];
      const seen = new Set();
      const walk = (node) => {
        if (!node) return;
        try {
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(selector)) {
              if (!seen.has(el)) {
                seen.add(el);
                results.push(el);
              }
            }
          }
        } catch (e) { }
        const children = node.children ? Array.from(node.children) : [];
        for (const child of children) {
          if (child.shadowRoot) walk(child.shadowRoot);
        }
      };
      walk(root);
      return results;
    };
    const isVisible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
      return true;
    };

    const selectors = [
      'button', '[role="button"]', '[role="menuitem"]', 'a', 'li', 'div',
      '[aria-label*="view all" i]', '[title*="view all" i]'
    ];
    const candidates = selectors.flatMap((sel) => deepQueryAll(document, sel));
    let best = null;
    let bestScore = -Infinity;

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = normalize(el.innerText || el.textContent || '');
      const aria = normalize(el.getAttribute && el.getAttribute('aria-label'));
      const title = normalize(el.getAttribute && el.getAttribute('title'));
      const combined = [text, aria, title].filter(Boolean).join(' ');
      if (!combined) continue;
      if (!combined.includes(wanted) && !combined.includes('view all tasks') && !combined.includes('view all task')) continue;

      let score = 0;
      if (combined === wanted) score += 1000;
      if (combined.includes(wanted)) score += 600;
      if (combined.includes('view all tasks') || combined.includes('view all task')) score += 400;
      if (el.tagName === 'BUTTON') score += 50;
      if (el.getAttribute && el.getAttribute('role') === 'button') score += 30;
      if (text.length) score += Math.max(0, 80 - text.length);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (!best) {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const text = normalize(node.innerText || node.textContent || '');
        if (text && text.includes(wanted)) {
          const clickable = node.closest && node.closest('button, [role="button"], [role="menuitem"], a');
          if (clickable && isVisible(clickable)) {
            best = clickable;
            break;
          }
        }
        node = walker.nextNode();
      }
    }

    if (!best) return { ok: false, reason: 'View all not found' };
    try { best.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { }
    best.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    best.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    best.click();
    return { ok: true };
  })()`;

  const result = await evaluateInContexts(cdp, SCRIPT, {
    awaitPromise: false,
    validator: (value) => value && value.ok
  });

  if (result) {
    if (result.contextId !== null && result.contextId !== undefined) {
      cdp.rootContextId = result.contextId;
    }
    return result.value || { ok: true };
  }

  return { ok: false, reason: 'View all not found' };
}

/**
 * Diagnostic: Check for "Message actions" buttons to debug user turn detection.
 */
export async function diagnoseTurnDetection(cdp) {
  const SCRIPT = `(() => {
    const selectors = ${JSON.stringify(ROOT_SELECTORS)};

    const findRoot = () => {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) return { el, selector: sel };
        } catch (e) {}
      }
      const body = document.body || document.documentElement;
      return body ? { el: body, selector: 'body' } : null;
    };

    const rootInfo = findRoot();
    if (!rootInfo) return { error: 'root not found' };
    const root = rootInfo.el;

    // Find all "Message actions" buttons
    const messageActionButtons = root.querySelectorAll('button[aria-label="Message actions"], button[title="Message actions"]');

    const buttonInfos = Array.from(messageActionButtons).map((btn, idx) => {
      // Find parent message container
      let parent = btn.parentElement;
      let parentInfo = null;
      for (let i = 0; i < 10 && parent && parent !== root; i++) {
        const text = (parent.innerText || '').trim();
        if (text.length > 5 && parent.tagName === 'DIV') {
          parentInfo = {
            depth: i,
            tagName: parent.tagName,
            className: (parent.className || '').toString().trim().substring(0, 100),
            textPreview: text.substring(0, 80) + (text.length > 80 ? '...' : ''),
            textLength: text.length
          };
          break;
        }
        parent = parent.parentElement;
      }

      return {
        index: idx,
        ariaLabel: btn.getAttribute('aria-label'),
        title: btn.getAttribute('title'),
        parentInfo
      };
    });

    return {
      rootSelector: rootInfo.selector,
      messageActionButtonCount: messageActionButtons.length,
      buttons: buttonInfos,
      childCount: buttonInfos.length
    };
  })()`;

  const result = await evaluateInContexts(cdp, SCRIPT, {
    awaitPromise: false,
    validator: (value) => value && !value.error && value.childCount !== undefined
  });

  if (result) {
    if (result.contextId !== null && result.contextId !== undefined) {
      cdp.rootContextId = result.contextId;
    }
    return result.value;
  }
  return { error: 'Could not evaluate diagnostic script' };
}
