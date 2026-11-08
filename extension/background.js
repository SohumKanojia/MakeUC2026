/* Braille Glove - MV3 service worker.
 * Owns the WebSocket to the Python bridge and the cell playback engine
 * (queue, per-cell timing, interrupt). See context.md 4, 9.2, 9.5.
 */
importScripts('braille.js');

const B = self.Braille;

const DEFAULTS = {
  enabled: true,
  bridgeUrl: 'ws://127.0.0.1:8787',
  cellMs: 400,        // vibration per cell (section 4)
  gapMs: 150,         // silence between cells
  spaceMs: 400,       // extra pause for a space
  readCellMs: 600,    // used for extracted page text
  dwellMs: 250,
  maxChars: 20,
  showOverlay: true,
  summarize: true,    // send extracted page text through Gemini first (8.2)
  summaryChars: 140,  // target length of the summary
  scope: 'full',      // page read covers: article | full | visible
  sayType: true,      // hover says "button save" rather than "save"
  logToPage: false    // also print byte sequences to the page console
};

let cfg = Object.assign({}, DEFAULTS);

/* ---------------- bridge link ---------------- */

let ws = null;
let wsState = 'disconnected';     // disconnected | connecting | connected
let reconnectTimer = null;
let reconnectDelay = 500;
let lastError = '';

function setState(s, err) {
  wsState = s;
  lastError = err || '';
  chrome.runtime.sendMessage({ type: 'status', state: s, error: lastError },
    function () { void chrome.runtime.lastError; });
}

/* The configured port may be held by an older bridge that cannot summarize,
 * because a bridge now moves to the next free port when its own is taken.
 * So the extension probes the range and keeps the best one it finds: a
 * current bridge beats an outdated one, and we only settle for outdated if
 * nothing better answers. This is what makes it work without the user
 * having to know which port won. */
const PROBE_FIRST = 8787;
const PROBE_LAST = 8796;

let candidates = [];
let candIndex = 0;
let outdatedUrl = null;      // usable, but cannot summarize
let activeUrl = '';

function buildCandidates() {
  const base = cfg.bridgeUrl || ('ws://127.0.0.1:' + PROBE_FIRST);
  const m = base.match(/^(wss?:\/\/[^:/]+)(?::(\d+))?/);
  const host = m ? m[1] : 'ws://127.0.0.1';
  const list = [base];
  for (let p = PROBE_FIRST; p <= PROBE_LAST; p++) {
    const u = host + ':' + p;
    if (list.indexOf(u) === -1) list.push(u);
  }
  return list;
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  clearTimeout(reconnectTimer);

  if (!candidates.length) { candidates = buildCandidates(); candIndex = 0; }
  const url = candidates[candIndex] || candidates[0];
  activeUrl = url;
  setState('connecting');

  try {
    ws = new WebSocket(url);
  } catch (e) {
    setState('disconnected', String(e));
    nextCandidate();
    return;
  }

  ws.onopen = function () {
    setState('connected');
    sendCmd({ cmd: 'DUR', ms: cfg.cellMs });
    sendCmd({ cmd: 'MODE', mode: 'READ' });
  };

  ws.onclose = function () {
    setState('disconnected');
    nextCandidate();
  };

  ws.onerror = function () {
    lastError = 'no bridge at ' + url;
  };

  ws.onmessage = function (event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    handleBridgeMessage(msg);
  };
}

/** Called on hello: decide whether to keep this bridge or keep looking. */
function judgeBridge(msg) {
  const current = ('gemini' in msg);
  const more = candIndex < candidates.length - 1;

  if (!current && more) {
    outdatedUrl = activeUrl;            // remember as a last resort
    candIndex++;
    try { ws.close(); } catch (e) {}    // onclose moves us along
    return false;
  }

  // Settled. Stop probing until something disconnects us.
  candidates = [activeUrl];
  candIndex = 0;
  reconnectDelay = 500;
  return true;
}

function nextCandidate() {
  clearTimeout(reconnectTimer);
  if (candIndex < candidates.length - 1) {
    candIndex++;
    reconnectTimer = setTimeout(connect, 120);   // sweep the range quickly
    return;
  }
  // Nothing current answered. Fall back to an outdated bridge if we saw one.
  if (outdatedUrl) {
    candidates = [outdatedUrl];
    candIndex = 0;
    outdatedUrl = null;
    reconnectTimer = setTimeout(connect, 120);
    return;
  }
  candidates = [];                      // rebuild and sweep again later
  candIndex = 0;
  reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  reconnectTimer = setTimeout(connect, reconnectDelay);
}

function sendCmd(obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

/* Messages coming up from the glove, via the bridge (context.md 9.3). */
function handleBridgeMessage(msg) {
  switch (msg.type) {
    case 'extract':                       // EVT THUMB_TAP
      withActiveTab(function (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'extract', scope: cfg.scope },
          function () { void chrome.runtime.lastError; });
      });
      break;
    case 'mode':                          // EVT MODE READ|INPUT
      if (msg.mode === 'INPUT' || msg.mode === 'input') stop();
      broadcastToPopup({ type: 'mode', mode: msg.mode });
      break;
    case 'char':                          // IN: <n> decoded by the bridge
      broadcastToPopup({ type: 'char', ch: msg.ch });
      break;
    case 'serial':                        // raw line, for the popup log
      broadcastToPopup({ type: 'serial', line: msg.line });
      break;
    case 'summary':                       // answer to a SUMMARIZE request
      resolveSummary(msg);
      break;
    case 'hello':
      if (!judgeBridge(msg)) break;          // still probing; ignore this one
      geminiReady = !!msg.gemini;
      bridgeOutdated = !('gemini' in msg);
      broadcastToPopup({
        type: 'gemini', ready: geminiReady, model: msg.model,
        outdated: bridgeOutdated, url: activeUrl
      });
      break;
  }
}

/* ---------------- summarization (8.2, 8.3) ----------------
 * The key lives on the bridge, never here. We ask, we wait a moment, and
 * if the answer does not arrive we read the page text instead - the demo
 * must not depend on the network.
 */

let geminiReady = false;
let bridgeOutdated = false;   // connected to a bridge older than SUMMARIZE
let summarySeq = 0;
const pending = new Map();

function resolveSummary(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  entry.resolve({ text: msg.text, source: msg.source, ms: msg.ms });
}

function requestSummary(text, title, timeoutMs) {
  return new Promise(function (resolve) {
    const id = ++summarySeq;
    const ok = sendCmd({
      cmd: 'SUMMARIZE', id: id, text: text, title: title || '',
      maxChars: cfg.summaryChars
    });
    if (!ok) { resolve(null); return; }

    const timer = setTimeout(function () {
      pending.delete(id);
      resolve(null);                      // bridge too slow; caller falls back
    }, timeoutMs);

    pending.set(id, { resolve: resolve, timer: timer });
  });
}

/* ---------------- byte output ----------------
 * The glove is not built yet, so the extension is its own output device:
 * every sequence it would have sent is recorded here, shown in the popup
 * and logged to the console. This runs whether or not a bridge is
 * connected, so the whole pipeline is demoable and debuggable with nothing
 * plugged in.
 */

const HISTORY_MAX = 40;
const history = [];        // newest first

function recordBytes(text, cells, source) {
  const entry = {
    at: Date.now(),
    text: text,
    source: source || 'hover',
    bytes: cells.map(function (c) { return c.n; }),
    chars: cells.map(function (c) { return c.ch; }).join(''),
    sent: wsState === 'connected'
  };
  history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;

  // Visible in the service worker console (chrome://extensions -> service worker)
  console.log('[braille] %s %o  "%s"  ->  %s',
    entry.sent ? 'glove' : 'no glove', entry.bytes.length, entry.chars,
    entry.bytes.join(' '));

  broadcastToPopup({ type: 'bytes', entry: entry });

  if (cfg.logToPage) {
    notifyTab({ type: 'logBytes', entry: entry });
  }
  return entry;
}

/* ---------------- playback engine (4, 9.5) ---------------- */

let queue = [];
let qIndex = 0;
let readingPage = false;   // mode 2 is playing; mode 1 stands down
let playTimer = null;
let playToken = 0;         // bumped on every cancel so stale timers die
let currentWord = '';
let currentTabId = null;

function setReading(on) {
  if (readingPage === on) return;
  readingPage = on;
  broadcastToPopup({ type: 'reading', on: on });
}

function stop() {
  playToken++;
  clearTimeout(playTimer);
  playTimer = null;
  queue = [];
  qIndex = 0;
  sendCmd({ cmd: 'CLEAR' });               // interrupt: motors off now (5.1)
  notifyTab({ type: 'idle' });
}

/**
 * Thumb tap path: page text in, braille out, with Gemini in the middle.
 * Never leaves the user with nothing - if the summary does not arrive we
 * play the head of the page instead.
 */
async function speakPage(text, title, scope) {
  setReading(false);
  stop();
  if (!text) return;
  setReading(true);

  let out = text;
  let source = 'page';
  let reason = '';

  if (cfg.summarize) {
    broadcastToPopup({ type: 'summarizing' });
    // A shade longer than the bridge's own 5s budget, so the bridge gets
    // to deliver its fallback rather than racing us.
    const res = await requestSummary(text, title, 6500);
    if (res && res.text) {
      out = res.text;
      source = res.source;              // "gemini" or "fallback"
      reason = res.reason || '';
    } else {
      out = text.slice(0, cfg.summaryChars * 3);
    }
  }

  if (!out) { setReading(false); return; }
  broadcastToPopup({
    type: 'summary', source: source, text: out,
    inChars: text.length, scope: scope || cfg.scope, reason: reason
  });
  play(out, { cellMs: cfg.readCellMs, source: 'extract' });
}

function play(text, opts) {
  opts = opts || {};
  stop();
  const cells = B.textToCells(text);
  if (!cells.length) return 0;

  queue = cells;
  qIndex = 0;
  currentWord = B.cleanText(text);
  const token = ++playToken;
  const cellMs = opts.cellMs || cfg.cellMs;

  // Emit the whole byte sequence up front, so it is readable even if the
  // user moves the mouse and cancels playback a cell later.
  recordBytes(text, cells, opts.source);

  step(token, cellMs);
  return cells.length;
}

function step(token, cellMs) {
  if (token !== playToken) return;
  if (qIndex >= queue.length) {
    sendCmd({ cmd: 'CLEAR' });
    notifyTab({ type: 'idle' });
    setReading(false);
    broadcastToPopup({ type: 'done' });
    return;
  }

  const cell = queue[qIndex++];
  sendCmd({ cmd: 'CELL', n: cell.n });
  notifyTab({ type: 'cell', ch: cell.ch, n: cell.n, dots: cell.dots, word: currentWord });
  broadcastToPopup({ type: 'cell', ch: cell.ch, n: cell.n, dots: cell.dots,
                     index: qIndex, total: queue.length });

  // A space is a longer silence with no vibration (3.4).
  const hold = cell.n === 0 ? 0 : cellMs;
  const gap = cell.n === 0 ? cfg.spaceMs : cfg.gapMs;
  playTimer = setTimeout(function () { step(token, cellMs); }, hold + gap);
}

/* ---------------- plumbing ---------------- */

function notifyTab(msg) {
  if (currentTabId == null) return;
  chrome.tabs.sendMessage(currentTabId, msg, function () { void chrome.runtime.lastError; });
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
}

function withActiveTab(fn) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
    if (tabs && tabs[0] && tabs[0].id != null) fn(tabs[0].id);
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  switch (msg && msg.type) {
    case 'speak':
      // cfg.enabled governs mode 1 (hover) only. An explicit page read is
      // mode 2 and must still work with the hover reader switched off.
      if (!cfg.enabled && msg.source !== 'extract') break;
      // While mode 2 is reading, the mouse must not hijack it: moving the
      // pointer at all would otherwise cancel the read instantly.
      if (readingPage && msg.source !== 'extract') break;
      currentTabId = sender.tab ? sender.tab.id : currentTabId;
      if (msg.source === 'extract') {
        speakPage(msg.text, msg.title, msg.scope);
      } else {
        play(msg.text, { cellMs: cfg.cellMs, source: 'hover' });
      }
      break;

    case 'cancel':
      if (sender.tab) currentTabId = sender.tab.id;
      if (readingPage) break;          // a page read owns the motors
      stop();
      break;

    // --- from the popup ---
    case 'getStatus':
      respond({
        state: wsState,
        error: lastError,
        config: cfg,
        gemini: geminiReady,
        outdated: bridgeOutdated,
        url: activeUrl,
        playing: queue.length > 0 && qIndex < queue.length
      });
      return true;

    case 'testSpeak': {
      const n = play(msg.text, { cellMs: cfg.cellMs, source: 'test' });
      respond({ cells: n });
      return true;
    }

    case 'stop':
      setReading(false);
      stop();
      break;

    case 'capturePage':
      // Relay a capture request to the active tab and hand the result back.
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
        const tab = tabs && tabs[0];
        if (!tab || tab.id == null) { respond({ error: 'no active tab' }); return; }
        currentTabId = tab.id;
        chrome.tabs.sendMessage(tab.id, {
          type: 'getPageText', scope: msg.scope || cfg.scope
        }, function (res) {
          if (chrome.runtime.lastError || !res) {
            respond({ error: 'no content script on this page' });
            return;
          }
          const cells = B.textToCells(res.text);
          respond({
            title: res.title, url: res.url, scope: res.scope,
            text: res.text, chars: res.chars,
            cells: cells.length,
            bytes: cells.map(function (c) { return c.n; }),
            ms: B.estimateMs(cells, { cellMs: cfg.readCellMs, gapMs: cfg.gapMs,
                                      spaceMs: cfg.spaceMs })
          });
        });
      });
      return true;                      // responding asynchronously

    case 'getBytes':
      respond({ history: history });
      return true;

    case 'clearBytes':
      history.length = 0;
      broadcastToPopup({ type: 'bytesCleared' });
      break;

    case 'reconnect':
      candidates = []; candIndex = 0; outdatedUrl = null;
      if (ws) { try { ws.close(); } catch (e) {} }
      reconnectDelay = 500;
      connect();
      break;

    case 'pattern':
      sendCmd({ cmd: 'PATTERN', name: msg.name });
      break;

    case 'extractActiveTab':
      withActiveTab(function (tabId) {
        currentTabId = tabId;
        chrome.tabs.sendMessage(tabId, { type: 'extract', scope: cfg.scope },
          function () { void chrome.runtime.lastError; });
      });
      break;
  }
});

chrome.storage.onChanged.addListener(function (changes) {
  Object.keys(changes).forEach(function (k) {
    if (k in DEFAULTS) cfg[k] = changes[k].newValue;
  });
  if (changes.cellMs) sendCmd({ cmd: 'DUR', ms: cfg.cellMs });
  if (changes.bridgeUrl) {
    candidates = []; candIndex = 0; outdatedUrl = null;
    if (ws) { try { ws.close(); } catch (e) {} }
    connect();
  }
  if (changes.enabled && !cfg.enabled) stop();
});

function boot() {
  chrome.storage.local.get(DEFAULTS, function (stored) {
    cfg = Object.assign({}, DEFAULTS, stored);
    connect();
  });
}

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
boot();
