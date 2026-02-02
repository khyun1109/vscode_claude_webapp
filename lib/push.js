import fs from 'fs';
import { join } from 'path';
import webpush from 'web-push';
import { PROJECT_DIR } from './config.js';

const VAPID_KEYS_FILE = join(PROJECT_DIR, '.vapid-keys.json');
const PUSH_COOLDOWN = 15000;

function loadOrGenerateVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, 'utf8'));
    if (saved.publicKey && saved.privateKey) return saved;
  } catch {}
  const keys = webpush.generateVAPIDKeys();
  const data = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  try {
    fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(data, null, 2));
    console.log(`[Push] Generated new VAPID keys -> ${VAPID_KEYS_FILE}`);
  } catch (e) {
    console.error(`[Push] Could not save VAPID keys: ${e.message}`);
  }
  return data;
}

const vapidKeys = loadOrGenerateVapidKeys();
const VAPID_MAILTO = process.env.VAPID_MAILTO || 'mailto:vsclaude-webapp@localhost';
webpush.setVapidDetails(VAPID_MAILTO, vapidKeys.publicKey, vapidKeys.privateKey);

export const VAPID_PUBLIC_KEY = vapidKeys.publicKey;
export const pushSubscriptions = new Map();

let lastPushTime = 0;

export async function sendPushNotification(title, body, tag) {
  if (pushSubscriptions.size === 0) return;
  const now = Date.now();
  if (now - lastPushTime < PUSH_COOLDOWN) return;
  lastPushTime = now;

  const payload = JSON.stringify({ title, body, tag: tag || 'claude-update' });
  const stale = [];
  for (const [endpoint, sub] of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        stale.push(endpoint);
      }
      console.error(`[Push] Send failed: ${err.statusCode || err.message}`);
    }
  }
  stale.forEach(ep => pushSubscriptions.delete(ep));
}
