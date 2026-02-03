import WebSocket from 'ws';
import {
  PORTS, TARGET_TYPES, TARGET_TITLE_KEYWORDS, TARGET_URL_KEYWORDS,
  PREFERRED_TITLE_KEYWORDS, PREFERRED_URL_KEYWORDS
} from './config.js';
import {
  hashString, normalize, getJson,
  connectCDP, extractMetadata, captureCSS, captureHTML
} from './cdp.js';
import { sendPushNotification, pushSubscriptions } from './push.js';

// --- Shared state ---
export let cascades = new Map();
export const lastSendByCascade = new Map();

let _broadcastCascadeList = () => {};
let _broadcastSnapshotUpdate = () => {};

export function initDiscovery(broadcastCascadeList, broadcastSnapshotUpdate) {
  _broadcastCascadeList = broadcastCascadeList;
  _broadcastSnapshotUpdate = broadcastSnapshotUpdate;
}

// --- Target matching ---

const keywordScore = (text, keywords) => {
  if (!text) return 0;
  const lowered = normalize(text);
  let score = 0;
  for (const keyword of keywords) {
    if (lowered.includes(keyword)) score += 1;
  }
  return score;
};

const matchesTarget = (target) => {
  const title = normalize(target.title);
  const url = normalize(target.url);
  const score = keywordScore(title, TARGET_TITLE_KEYWORDS) + keywordScore(url, TARGET_URL_KEYWORDS);
  return score > 0;
};

/**
 * FIX #4: Promise-based mutex instead of boolean flags.
 * Prevents race conditions between discover/updateSnapshots.
 */
let discoverPromise = null;
let updatePromise = null;

export async function discover() {
  if (discoverPromise) return discoverPromise;
  discoverPromise = _discover().finally(() => { discoverPromise = null; });
  return discoverPromise;
}

export async function updateSnapshots() {
  if (updatePromise || discoverPromise) return;
  updatePromise = _updateSnapshots().finally(() => { updatePromise = null; });
  return updatePromise;
}

async function _discover() {
  const allTargets = [];
  const targetProjectNames = new Map();

  await Promise.all(PORTS.map(async (port) => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);

    const pageProjectNames = new Map();
    for (const t of list) {
      const title = t.title || '';
      if (t.type === 'page' && (title.includes('Visual Studio Code') || title.includes('VSCodium') || title.includes('Code - OSS'))) {
        const parts = title.split(' - ');
        let projectName = '';
        if (parts.length >= 3) {
          projectName = parts[parts.length - 2].trim();
        } else if (parts.length === 2) {
          projectName = parts[0].trim();
        }
        if (projectName && t.id) {
          pageProjectNames.set(t.id, projectName);
        }
      }
    }

    const filtered = list.filter(t => TARGET_TYPES.includes(t.type || 'page'))
      .filter(t => matchesTarget(t));
    filtered.forEach(t => {
      if (t.parentId && pageProjectNames.has(t.parentId)) {
        targetProjectNames.set(t.id, pageProjectNames.get(t.parentId));
      } else {
        const firstProject = pageProjectNames.values().next().value;
        if (firstProject) targetProjectNames.set(t.id, firstProject);
      }
      allTargets.push({ ...t, port });
    });
  }));

  if (allTargets.length === 0) {
    await Promise.all(PORTS.map(async (port) => {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const fallback = list.filter(t => TARGET_TYPES.includes(t.type || 'page'))
        .filter(t => normalize(t.url).includes('workbench') || normalize(t.title).includes('workbench'));
      fallback.forEach(t => allTargets.push({ ...t, port }));
    }));
  }

  const newCascades = new Map();

  for (const target of allTargets) {
    const id = hashString(target.webSocketDebuggerUrl);

    if (cascades.has(id)) {
      const existing = cascades.get(id);
      if (existing.cdp.ws.readyState === WebSocket.OPEN) {
        const meta = await extractMetadata(existing.cdp);
        if (meta) {
          existing.metadata = { ...existing.metadata, ...meta };
          newCascades.set(id, existing);
          continue;
        }
      }
      // FIX #3: Explicitly close stale CDP connections
      try { existing.cdp.cleanup(); } catch {}
    }

    try {
      console.log(`[Discovery] Connecting to ${target.title || target.url}`);
      const cdp = await connectCDP(target.webSocketDebuggerUrl);
      const meta = await extractMetadata(cdp);

      if (meta) {
        if (meta.contextId) cdp.rootContextId = meta.contextId;
        const cascade = {
          id,
          cdp,
          metadata: {
            windowTitle: target.title,
            chatTitle: meta.chatTitle,
            isActive: meta.isActive,
            projectName: targetProjectNames.get(target.id) || ''
          },
          snapshot: null,
          css: await captureCSS(cdp),
          snapshotHash: null
        };
        newCascades.set(id, cascade);
        console.log(`[Discovery] Added Claude target: ${meta.chatTitle}`);
      } else {
        cdp.cleanup();
      }
    } catch (e) {
      // ignore connection errors
    }
  }

  const oldCascades = cascades;
  cascades = newCascades;
  // FIX #3: Clean up removed cascades and their associated state
  for (const [id, c] of oldCascades.entries()) {
    if (!cascades.has(id)) {
      try { c.cdp.cleanup(); } catch {}
      lastSendByCascade.delete(id);
    }
  }
  _broadcastCascadeList();
}

/**
 * FIX #4: Iterate over a snapshot of entries to avoid issues if
 * cascades Map is replaced by discover() mid-iteration.
 */
async function _updateSnapshots() {
  const entries = Array.from(cascades.entries());
  for (const [id, c] of entries) {
    // Verify cascade is still current (discover() may have replaced cascades)
    if (!cascades.has(id) || cascades.get(id) !== c) continue;
    if (c.cdp.ws.readyState !== WebSocket.OPEN) continue;
    try {
      const snap = await captureHTML(c.cdp);
      if (!snap || !snap.html) continue;
      const hash = hashString(snap.html);
      if (hash !== c.snapshotHash) {
        c.snapshotHash = hash;
        c.snapshot = snap;
        _broadcastSnapshotUpdate(id);
        c._lastChangeTime = Date.now();
        c._notifiedIdle = false;
      }
    } catch {}
  }

  // Check for idle cascades
  if (pushSubscriptions.size > 0) {
    const now = Date.now();
    const IDLE_THRESHOLD = 10000;
    for (const [id, c] of cascades.entries()) {
      if (c._lastChangeTime && !c._notifiedIdle &&
          (now - c._lastChangeTime) > IDLE_THRESHOLD) {
        c._notifiedIdle = true;
        const title = c.metadata?.chatTitle || 'Claude Agent';
        const project = c.metadata?.projectName || '';
        const body = project ? `[${project}] ${title}` : title;
        console.log(`[Push] Agent idle (no changes for ${IDLE_THRESHOLD / 1000}s) -> ${body}`);
        sendPushNotification('Agent ready', body, `cascade-${id}`);
      }
    }
  }
}

export async function refreshSnapshotOnce(cascadeId) {
  const c = cascades.get(cascadeId);
  if (!c || c.cdp.ws.readyState !== WebSocket.OPEN) return false;
  try {
    const snap = await captureHTML(c.cdp);
    if (!snap || !snap.html) return false;
    const hash = hashString(snap.html);
    if (hash !== c.snapshotHash) {
      c.snapshotHash = hash;
      c.snapshot = snap;
      _broadcastSnapshotUpdate(cascadeId);
    }
    return true;
  } catch {
    return false;
  }
}
