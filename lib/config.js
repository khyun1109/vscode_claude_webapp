import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_DIR = join(__dirname, '..');

const DEFAULT_PORT_RANGE = '9222-9230';

const parseCsvEnv = (name, fallback) => {
  const raw = (process.env[name] || '').trim();
  if (!raw) return [...fallback];
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  return items.length ? items : [...fallback];
};

const parsePorts = () => {
  const rawPorts = (process.env.CLAUDE_CDP_PORTS || '').trim();
  if (rawPorts) {
    return rawPorts
      .split(',')
      .map(s => s.trim())
      .filter(s => /^\d+$/.test(s))
      .map(s => Number(s));
  }
  const rawRange = (process.env.CLAUDE_CDP_PORT_RANGE || DEFAULT_PORT_RANGE).trim();
  if (rawRange.includes('-')) {
    const [startRaw, endRaw] = rawRange.split('-', 2);
    const start = Number(startRaw.trim());
    const end = Number(endRaw.trim());
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
  }
  if (/^\d+$/.test(rawRange)) return [Number(rawRange)];
  return Array.from({ length: 9 }, (_, i) => 9222 + i);
};

export const PORTS = parsePorts();
export const DISCOVERY_INTERVAL = Number(process.env.CLAUDE_DISCOVERY_INTERVAL || 5000);
export const POLL_INTERVAL = Number(process.env.CLAUDE_POLL_INTERVAL || 2000);
export const MIN_TEXT_LEN = Number(process.env.CLAUDE_MIN_TEXT_LEN || 20);
export const DUP_SEND_WINDOW_MS = Number(process.env.CLAUDE_DUP_SEND_WINDOW_MS || 500);
export const CDP_CALL_TIMEOUT = Number(process.env.CLAUDE_CDP_CALL_TIMEOUT || 10000);

export const TARGET_TITLE_KEYWORDS = parseCsvEnv(
  'CLAUDE_TARGET_TITLE_KEYWORDS',
  ['claude', 'anthropic', 'visual studio code', 'vscode', 'code - oss', 'code-oss', 'workbench']
);

export const TARGET_URL_KEYWORDS = parseCsvEnv(
  'CLAUDE_TARGET_URL_KEYWORDS',
  ['extensionid=anthropic.claude-code', 'vscode-webview', 'claude', 'anthropic', 'workbench', 'code-oss']
);

export const TARGET_TYPES = parseCsvEnv('CLAUDE_TARGET_TYPES', ['page', 'iframe']);

export const PREFERRED_TITLE_KEYWORDS = parseCsvEnv(
  'CLAUDE_PREFERRED_TITLE_KEYWORDS',
  ['claude', 'anthropic', 'agent']
);

export const PREFERRED_URL_KEYWORDS = parseCsvEnv(
  'CLAUDE_PREFERRED_URL_KEYWORDS',
  ['extensionid=anthropic.claude-code', 'vscode-webview', 'claude', 'anthropic']
);

export const ROOT_SELECTORS = parseCsvEnv(
  'CLAUDE_ROOT_SELECTORS',
  ['#root', '#app', '[data-testid*="claude"]', '[data-testid*="chat"]', 'main', 'section[role="main"]', 'body']
);

export const INPUT_SELECTORS = parseCsvEnv(
  'CLAUDE_INPUT_SELECTORS',
  [
    '#prompt-textarea',
    'textarea[data-testid*="prompt" i]',
    'textarea[data-testid*="input" i]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="prompt" i]',
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
    'textarea',
    'input[data-testid*="prompt" i]',
    'input[data-testid*="input" i]',
    'input[type="text"]',
    'input[role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[contenteditable=""]'
  ]
);

export const SEND_SELECTORS = parseCsvEnv(
  'CLAUDE_SEND_SELECTORS',
  [
    'button[data-testid="send-button"]',
    'button[data-testid*="send" i]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="Submit" i]',
    'button[aria-label*="Send message" i]',
    'button[aria-label*="Send Message" i]',
    'button[title*="send" i]',
    'button[title*="submit" i]',
    'button[type="submit"]',
    'button[class*="send"]',
    'button[class*="submit"]'
  ]
);

export const CASCADE_WRAPPER_ID = 'claude-root';

export const MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024;
