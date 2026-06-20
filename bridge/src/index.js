import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const monitorScriptPath = path.join(
  projectRoot,
  'bridge',
  'resources',
  'max-monitor.js'
);

const config = {
  maxUrl: process.env.MAX_URL || 'https://web.max.ru',
  targetUrl: process.env.TARGET_URL || '',
  targetType: process.env.TARGET_TYPE || 'webhook',
  targetUsername: process.env.TARGET_USERNAME || '',
  targetPassword: process.env.TARGET_PASSWORD || '',
  targetBearerToken: process.env.TARGET_BEARER_TOKEN || '',
  targetHeadersJson: process.env.TARGET_HEADERS_JSON || '',
  ntfyTitle: process.env.NTFY_TITLE || 'MAX',
  ntfyPriority: process.env.NTFY_PRIORITY || 'default',
  ntfyTags: process.env.NTFY_TAGS || 'speech_balloon',
  accountName: process.env.ACCOUNT_NAME || 'default',
  profileDir: process.env.PROFILE_DIR || '/data/profile',
  stateDir: process.env.STATE_DIR || '/data/state',
  dedupFile: process.env.DEDUP_FILE || '/data/state/dedup.json',
  loginScreenshotFile: process.env.LOGIN_SCREENSHOT_FILE || '/data/state/login.png',
  healthPort: Number(process.env.PORT || 3000),
  headless: parseBool(process.env.HEADLESS, true),
  keepRaw: parseBool(process.env.SEND_RAW, false),
  skipOwnMessages: parseBool(process.env.SKIP_OWN_MESSAGES, true),
  skipMutedChats: parseBool(process.env.SKIP_MUTED_CHATS, true),
  maxHistory: Number(process.env.DEDUP_LIMIT || 5000)
};

const state = {
  running: false,
  browserReady: false,
  pageUrl: '',
  authState: 'starting',
  monitorReady: false,
  lastHeartbeatAt: 0,
  lastMessageAt: 0,
  lastSentAt: 0,
  lastError: '',
  sentCount: 0,
  skippedDuplicates: 0,
  receivedCount: 0,
  dedupSize: 0,
  loginScreenshotAvailable: false
};

const dedup = new Map();
let shutdown = false;
let saveTimer = null;

function parseBool(value, defaultValue) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function log(message) {
  console.log(`[max2ntfy] ${message}`);
}

function previewText(value, limit = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

async function loadState() {
  await fs.mkdir(config.stateDir, { recursive: true });
  try {
    const raw = await fs.readFile(config.dedupFile, 'utf8');
    const parsed = JSON.parse(raw);
    const keys = Array.isArray(parsed.keys) ? parsed.keys : [];
    for (const key of keys) {
      if (typeof key === 'string' && key) {
        dedup.set(key, Date.now());
      }
    }
    pruneDedup();
    state.dedupSize = dedup.size;
  } catch {
    state.dedupSize = 0;
  }
}

function pruneDedup() {
  while (dedup.size > config.maxHistory) {
    const firstKey = dedup.keys().next().value;
    if (!firstKey) break;
    dedup.delete(firstKey);
  }
}

function scheduleSaveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const payload = JSON.stringify({ keys: Array.from(dedup.keys()) }, null, 2);
      const tmpFile = `${config.dedupFile}.tmp`;
      await fs.writeFile(tmpFile, payload, 'utf8');
      await fs.rename(tmpFile, config.dedupFile);
      state.dedupSize = dedup.size;
    } catch (error) {
      state.lastError = String(error?.message || error);
      log(`cannot save dedup state: ${state.lastError}`);
    }
  }, 1000);
}

function claimDedup(key) {
  if (dedup.has(key)) return false;
  dedup.set(key, Date.now());
  pruneDedup();
  scheduleSaveState();
  state.dedupSize = dedup.size;
  return true;
}

function buildHeaders() {
  const headers = {
    'content-type': config.targetType === 'ntfy'
      ? 'text/plain; charset=utf-8'
      : 'application/json'
  };

  if (config.targetBearerToken) {
    headers.authorization = `Bearer ${config.targetBearerToken}`;
  } else if (config.targetUsername || config.targetPassword) {
    const basic = Buffer.from(`${config.targetUsername}:${config.targetPassword}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }

  if (config.targetType === 'ntfy') {
    headers.title = config.ntfyTitle;
    headers.priority = config.ntfyPriority;
    headers.tags = config.ntfyTags;
  }

  if (config.targetHeadersJson) {
    try {
      const extra = JSON.parse(config.targetHeadersJson);
      if (extra && typeof extra === 'object') {
        for (const [key, value] of Object.entries(extra)) {
          headers[key] = String(value);
        }
      }
    } catch (error) {
      log(`bad TARGET_HEADERS_JSON: ${error.message}`);
    }
  }

  return headers;
}

async function sendToTarget(notification) {
  if (!config.targetUrl) {
    log(`skip send, TARGET_URL is empty: ${notification.messageId}`);
    return false;
  }

  const response = await fetch(config.targetUrl, {
    method: 'POST',
    headers: buildHeaders(),
    body: config.targetType === 'ntfy'
      ? formatNtfyMessage(notification)
      : JSON.stringify(notification)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`target response ${response.status} ${response.statusText}${text ? `: ${previewText(text)}` : ''}`);
  }

  return true;
}

function formatNtfyMessage(notification) {
  const sender = notification.senderName || 'MAX';
  const text = notification.text || (notification.hasAttachment ? '[attachment]' : 'new message');
  const chat = notification.chatTitle ? ` (${notification.chatTitle})` : '';
  return `${sender}${chat}: ${text}`;
}

function classifyOwnMessage(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (payload.isOwnMessage === true) {
    return String(payload.ownMessageReason || 'payload.isOwnMessage');
  }

  if (typeof payload.ownMessageReason === 'string' && payload.ownMessageReason.trim()) {
    return payload.ownMessageReason.trim();
  }

  if (payload.outgoing === true || payload.out === true || payload.isOutgoing === true) {
    return 'outgoing';
  }

  const direction = String(payload.direction || '').toLowerCase();
  if (direction === 'out' || direction === 'outgoing') {
    return `direction=${direction}`;
  }

  const senderId = String(payload.senderId || '').trim();
  const myUserId = String(payload.myUserId || '').trim();
  if (senderId && myUserId && senderId === myUserId) {
    return 'senderId';
  }

  return '';
}

function makeNotification(payload) {
  const senderName = String(payload.senderName || payload.sender || 'unknown').trim();
  const text = String(payload.text || '').trim();
  const notification = {
    source: 'max',
    app: 'max2ntfy',
    account: config.accountName,
    sentAt: new Date().toISOString(),
    chatId: String(payload.chatId || ''),
    messageId: String(payload.messageId || ''),
    senderId: String(payload.senderId || ''),
    senderName,
    chatTitle: String(payload.chatTitle || ''),
    text,
    timestamp: Number(payload.timestamp || 0),
    isGroupChat: Boolean(payload.isGroupChat),
    isMutedChat: Boolean(payload.isMutedChat),
    hasAttachment: Boolean(payload.hasAttachment)
  };

  if (config.keepRaw) {
    notification.raw = payload;
  }

  return notification;
}

async function handleBridgeEvent(event) {
  if (!event || typeof event !== 'object') return;

  const type = String(event.type || '');
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};

  switch (type) {
    case 'monitor_ready':
      state.monitorReady = true;
      state.authState = 'monitor-ready';
      log('monitor is ready');
      break;
    case 'auth_check':
    case 'auth_ready':
    case 'chats_synced':
      state.authState = payload.hasToken === false ? 'unauthenticated' : 'authenticated';
      break;
    case 'heartbeat':
      state.lastHeartbeatAt = Date.now();
      if (payload.lastMessageAt) {
        state.lastMessageAt = Number(payload.lastMessageAt);
      }
      break;
    case 'new_message':
      await handleNewMessage(payload);
      break;
    default:
      break;
  }
}

async function handleNewMessage(payload) {
  state.receivedCount += 1;
  const messageId = String(payload.messageId || '').trim();
  const chatId = String(payload.chatId || '').trim();
  const ownMessageReason = classifyOwnMessage(payload);
  const chatMuteKnown = payload.chatMuteKnown === true;
  const isMutedChat = payload.isMutedChat === true;

  if (!messageId || !chatId) {
    log('skip message without messageId/chatId');
    return;
  }

  if (config.skipOwnMessages && ownMessageReason) {
    log(`skip own message ${messageId} reason=${ownMessageReason}`);
    return;
  }

  if (config.skipMutedChats && chatMuteKnown && isMutedChat) {
    log(`skip muted chat ${messageId} chat=${chatId}`);
    return;
  }

  const dedupKey = `${chatId}:${messageId}`;
  if (!claimDedup(dedupKey)) {
    state.skippedDuplicates += 1;
    return;
  }

  const notification = makeNotification(payload);
  state.lastMessageAt = Date.now();

  try {
    const delivered = await sendToTarget(notification);
    if (delivered) {
      state.lastSentAt = Date.now();
      state.sentCount += 1;
      state.lastError = '';
      log(`sent ${notification.messageId} from ${previewText(notification.senderName) || 'unknown'}`);
    }
  } catch (error) {
    state.lastError = String(error?.message || error);
    log(`send failed: ${state.lastError}`);
  }
}

async function updateAuthState(page) {
  try {
    const authenticated = await page.evaluate(() => {
      try {
        return window.localStorage.getItem('__oneme_auth') != null;
      } catch {
        return false;
      }
    });

    state.authState = authenticated ? 'authenticated' : 'unauthenticated';
    if (!authenticated) {
      await page.screenshot({ path: config.loginScreenshotFile, fullPage: true }).catch(() => {});
      state.loginScreenshotAvailable = true;
    } else {
      state.loginScreenshotAvailable = false;
    }
  } catch (error) {
    state.lastError = String(error?.message || error);
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/healthz' || url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state, null, 2));
      return;
    }

    if (url === '/login.png') {
      fs.readFile(config.loginScreenshotFile)
        .then((data) => {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(data);
        })
        .catch(() => {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('login screenshot is not available');
        });
      return;
    }

    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('max2ntfy is running\n');
  });

  server.listen(config.healthPort, '0.0.0.0', () => {
    log(`health server on :${config.healthPort}`);
  });

  return server;
}

async function launchSession() {
  const monitorScript = await fs.readFile(monitorScriptPath, 'utf8');
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-dev-shm-usage']
  });

  state.browserReady = true;
  state.authState = 'starting';

  await context.exposeFunction('max2ntfyBridge', async (event) => {
    try {
      await handleBridgeEvent(event);
    } catch (error) {
      state.lastError = String(error?.message || error);
      log(`bridge handler failed: ${state.lastError}`);
    }
  });
  await context.addInitScript(() => {
    const root = window.webkit || (window.webkit = {});
    const handlers = root.messageHandlers || (root.messageHandlers = {});
    handlers.maxBridge = {
      postMessage(data) {
        try {
          return window.max2ntfyBridge(data);
        } catch (error) {
          console.error('[max2ntfy] bridge error', error);
          return undefined;
        }
      }
    };
  });
  await context.addInitScript({ content: monitorScript });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'warning' || type === 'error') {
      log(`page ${type}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    state.lastError = error.message;
    log(`page error: ${error.message}`);
  });

  await page.goto(config.maxUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  state.pageUrl = page.url();
  await updateAuthState(page);

  while (!shutdown && !page.isClosed()) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    state.pageUrl = page.url();
    await updateAuthState(page);
  }

  await context.close().catch(() => {});
}

async function main() {
  await loadState();
  startHealthServer();
  state.running = true;
  log(`profile=${config.profileDir}`);
  log(`target=${config.targetUrl || '(empty)'}, type=${config.targetType}`);

  while (!shutdown) {
    try {
      await launchSession();
    } catch (error) {
      state.lastError = String(error?.message || error);
      log(`session failed: ${state.lastError}`);
    }

    if (!shutdown) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  state.running = false;
}

process.on('SIGINT', () => {
  shutdown = true;
});

process.on('SIGTERM', () => {
  shutdown = true;
});

await main();

