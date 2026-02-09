#!/usr/bin/env node
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import WebSocket from 'ws';
import { join } from 'path';

import {
  PROJECT_DIR, DISCOVERY_INTERVAL, POLL_INTERVAL, DUP_SEND_WINDOW_MS,
  ROOT_SELECTORS
} from './lib/config.js';
import { VAPID_PUBLIC_KEY, pushSubscriptions } from './lib/push.js';
import {
  evaluateInContexts, captureHTML, diagnoseTurnDetection,
  injectMessage, clickBack, clickByText, clickViewAll
} from './lib/cdp.js';
import {
  cascades, lastSendByCascade, initDiscovery,
  discover, updateSnapshots, refreshSnapshotOnce
} from './lib/discovery.js';

// --- Broadcast helpers ---

const allWsClients = new Set();

function broadcastCascadeList() {
  const cascadesList = Array.from(cascades.values()).map(c => ({
    id: c.id,
    title: c.metadata?.chatTitle || c.metadata?.windowTitle || 'Claude',
    projectName: c.metadata?.projectName || '',
    active: !!c.metadata?.isActive
  }));
  const msg = JSON.stringify({ type: 'cascade_list', cascades: cascadesList });
  allWsClients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function broadcastSnapshotUpdate(cascadeId) {
  const msg = JSON.stringify({ type: 'snapshot_update', cascadeId });
  allWsClients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// --- Main ---

function main() {
  initDiscovery(broadcastCascadeList, broadcastSnapshotUpdate);

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(join(PROJECT_DIR, 'public')));

  // --- Routes: Styles & Snapshots ---

  app.get('/styles/:id', (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json({ css: c.css || '' });
  });

  app.get('/snapshot/:id', (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (req.query?.mode === 'tasks') {
      captureHTML(c.cdp, { keepInputs: true }).then((snap) => {
        if (!snap || !snap.html) return res.status(404).json({ error: 'No snapshot' });
        res.json(snap);
      });
      return;
    }
    if (!c.snapshot) return res.status(404).json({ error: 'No snapshot' });
    res.json(c.snapshot);
  });

  // --- Routes: Debug ---

  app.get('/debug-dom/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    try {
      const result = await diagnoseTurnDetection(c.cdp);
      if (result && !result.error) {
        res.json(result);
      } else {
        res.status(500).json({ error: result?.error || 'Failed to analyze DOM' });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/cascades', (req, res) => {
    const list = Array.from(cascades.values()).map(c => ({
      id: c.id,
      title: c.metadata?.chatTitle || 'Claude',
    }));
    res.json(list);
  });

  // --- Routes: Send / Click ---

  app.post('/send/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const message = (req.body?.message || '').toString();
    if (!message.trim()) return res.status(400).json({ error: 'Empty message' });

    const now = Date.now();
    const last = lastSendByCascade.get(c.id);
    if (last && last.text === message && (now - last.ts) < DUP_SEND_WINDOW_MS) {
      return res.json({ success: true, message: 'dedup' });
    }

    lastSendByCascade.set(c.id, { text: message, ts: now });

    try {
      const result = await injectMessage(c.cdp, message);
      if (result.ok) {
        res.json({ success: true, message: result.method });
      } else {
        lastSendByCascade.delete(c.id);
        res.status(500).json({ success: false, reason: result.reason });
      }
    } catch (err) {
      lastSendByCascade.delete(c.id);
      res.status(500).json({ success: false, reason: err.message || 'Internal error' });
    }
  });

  app.post('/back/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });

    const result = await clickBack(c.cdp);
    if (result.ok) {
      res.json({ success: true });
      setTimeout(() => refreshSnapshotOnce(req.params.id), 250);
      setTimeout(() => refreshSnapshotOnce(req.params.id), 800);
    } else {
      res.status(500).json({ success: false, reason: result.reason });
    }
  });

  app.post('/select/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const text = (req.body?.text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'Empty text' });

    const result = await clickByText(c.cdp, text);
    if (result.ok) {
      res.json({ success: true, matched: result.matched });
    } else {
      res.status(500).json({ success: false, reason: result.reason });
    }
  });

  app.post('/view-all/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });

    let result = await clickViewAll(c.cdp);
    if (!result.ok) {
      result = await clickByText(c.cdp, 'view all');
    }
    if (result.ok) {
      res.json({ success: true });
      setTimeout(() => refreshSnapshotOnce(req.params.id), 200);
      setTimeout(() => refreshSnapshotOnce(req.params.id), 700);
      setTimeout(() => refreshSnapshotOnce(req.params.id), 1400);
    } else {
      res.status(500).json({ success: false, reason: result.reason });
    }
  });

  app.post('/click/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const text = (req.body?.text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'Empty text' });

    console.log(`[Click] Forwarding click for: "${text}"`);
    const result = await clickByText(c.cdp, text);
    if (result.ok) {
      res.json({ success: true, matched: result.matched });
      setTimeout(() => refreshSnapshotOnce(req.params.id), 200);
      setTimeout(() => refreshSnapshotOnce(req.params.id), 600);
    } else {
      res.status(500).json({ success: false, reason: result.reason });
    }
  });

  // --- Routes: Conversations ---

  app.get('/conversations/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });

    try {
      const openResult = await evaluateInContexts(c.cdp, `(() => {
        const btn = document.querySelector('button[title="Past conversations"]');
        if (!btn) return { error: 'no button' };
        btn.click();
        return { ok: true };
      })()`, { validator: v => v && (v.ok || v.error) });

      if (!openResult?.value?.ok) {
        return res.status(500).json({ error: 'Could not open conversations panel' });
      }

      await new Promise(r => setTimeout(r, 400));

      const listResult = await evaluateInContexts(c.cdp, `(() => {
        const buttons = Array.from(document.querySelectorAll('button[class*="sessionItem"]'));
        if (!buttons.length) return { items: [] };

        const items = buttons.map(btn => {
          const nameEl = btn.querySelector('[class*="sessionName"]');
          const timeEl = btn.querySelector('[class*="sessionTime"]');
          const title = nameEl ? nameEl.textContent.trim() : (btn.textContent || '').trim();
          const time = timeEl ? timeEl.textContent.trim() : '';
          const isActive = btn.className.includes('active');
          return { title, time, active: isActive };
        });

        return { items };
      })()`, { validator: v => v && v.items });

      await evaluateInContexts(c.cdp, `(() => {
        const btn = document.querySelector('button[title="Past conversations"]');
        if (btn) btn.click();
        return { ok: true };
      })()`, { validator: v => v });

      res.json(listResult?.value || { items: [] });
    } catch (err) {
      try {
        await evaluateInContexts(c.cdp, `(() => {
          document.querySelector('button[title="Past conversations"]')?.click();
          return { ok: true };
        })()`, { validator: v => v });
      } catch {}
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/conversations/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const title = (req.body?.title || '').toString().trim();
    if (!title) return res.status(400).json({ error: 'No title' });

    try {
      const result = await evaluateInContexts(c.cdp, `(async () => {
        const btn = document.querySelector('button[title="Past conversations"]');
        if (!btn) return { error: 'no button' };
        btn.click();
        await new Promise(r => setTimeout(r, 400));

        const safeTitle = ${JSON.stringify(title)};
        const buttons = Array.from(document.querySelectorAll('button[class*="sessionItem"]'));
        const target = buttons.find(b => {
          const nameEl = b.querySelector('[class*="sessionName"]');
          const name = nameEl ? nameEl.textContent.trim() : (b.textContent || '').trim();
          return name.includes(safeTitle);
        });
        if (!target) {
          btn.click();
          return { error: 'conversation not found' };
        }
        target.click();
        return { ok: true };
      })()`, { awaitPromise: true, validator: v => v && (v.ok || v.error) });

      if (result?.value?.ok) {
        res.json({ success: true });
        setTimeout(() => refreshSnapshotOnce(req.params.id), 500);
        setTimeout(() => refreshSnapshotOnce(req.params.id), 1500);
      } else {
        res.status(500).json({ success: false, reason: result?.value?.error || 'unknown' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Routes: Mode Switch ---

  app.get('/mode/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });

    try {
      const result = await evaluateInContexts(c.cdp, `(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const modeBtn = buttons.find(b => {
          const title = (b.getAttribute('title') || '');
          return title.includes('switch modes');
        });
        if (!modeBtn) return { mode: null };
        return { mode: (modeBtn.textContent || '').trim() };
      })()`, { validator: v => v });

      res.json(result?.value || { mode: null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/mode/:id', async (req, res) => {
    const c = cascades.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });

    try {
      const result = await evaluateInContexts(c.cdp, `(async () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const modeBtn = buttons.find(b => {
          const title = (b.getAttribute('title') || '');
          return title.includes('switch modes');
        });
        if (!modeBtn) return { error: 'no mode button' };
        modeBtn.click();
        await new Promise(r => setTimeout(r, 150));
        const updated = Array.from(document.querySelectorAll('button')).find(b => {
          const title = (b.getAttribute('title') || '');
          return title.includes('switch modes');
        });
        return { ok: true, mode: updated ? (updated.textContent || '').trim() : null };
      })()`, { awaitPromise: true, validator: v => v && (v.ok || v.error) });

      if (result?.value?.ok) {
        res.json({ success: true, mode: result.value.mode });
        setTimeout(() => refreshSnapshotOnce(req.params.id), 200);
      } else {
        res.status(500).json({ success: false, reason: result?.value?.error || 'unknown' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Routes: Push Notifications ---

  app.get('/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
  });

  app.post('/push-subscribe', (req, res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    pushSubscriptions.set(sub.endpoint, sub);
    console.log(`[Push] Subscription saved (${pushSubscriptions.size} total)`);
    res.json({ success: true });
  });

  app.post('/push-unsubscribe', (req, res) => {
    const sub = req.body;
    if (sub?.endpoint) pushSubscriptions.delete(sub.endpoint);
    res.json({ success: true });
  });

  app.post('/push-test', async (req, res) => {
    if (pushSubscriptions.size === 0) {
      return res.json({ success: false, reason: 'No subscriptions registered' });
    }
    const { default: webpush } = await import('web-push');
    const payload = JSON.stringify({
      title: 'VSClaude WebApp',
      body: 'Test notification - push is working!',
      tag: 'test-notification'
    });
    let sent = 0, failed = 0;
    for (const [endpoint, sub] of pushSubscriptions) {
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        failed++;
        console.error(`[Push] Test send failed: ${err.statusCode || err.message}`);
        if (err.statusCode === 410 || err.statusCode === 404) {
          pushSubscriptions.delete(endpoint);
        }
      }
    }
    res.json({ success: true, sent, failed, total: pushSubscriptions.size });
  });

  // --- WebSocket ---

  wss.on('connection', (ws) => {
    allWsClients.add(ws);
    ws.on('close', () => allWsClients.delete(ws));
    broadcastCascadeList();
  });

  // --- Start Servers ---

  const PORT = process.env.PORT || 3000;
  const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`VSClaude WebApp running on http://0.0.0.0:${PORT}`);
  });

  const certDir = join(PROJECT_DIR, 'certs');
  try {
    const sslOpts = {
      key: fs.readFileSync(join(certDir, 'key.pem')),
      cert: fs.readFileSync(join(certDir, 'cert.pem'))
    };
    const httpsServer = https.createServer(sslOpts, app);
    const wssSecure = new WebSocketServer({ server: httpsServer });
    wssSecure.on('connection', (ws) => {
      allWsClients.add(ws);
      ws.on('close', () => allWsClients.delete(ws));
      broadcastCascadeList();
    });
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`VSClaude WebApp HTTPS on https://0.0.0.0:${HTTPS_PORT}`);
    });
  } catch (e) {
    console.log(`HTTPS disabled (no certs found in ${certDir})`);
  }

  // --- Polling ---

  function needsPolling() {
    return allWsClients.size > 0 || pushSubscriptions.size > 0;
  }

  discover();
  setInterval(() => discover(), DISCOVERY_INTERVAL);
  setInterval(() => {
    if (needsPolling()) updateSnapshots();
  }, POLL_INTERVAL);
}

main();
