/* Braille Glove - popup: status, timing knobs, test sender. */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const dots = Array.prototype.slice.call(document.querySelectorAll('.cell i'));

  const SLIDERS = [
    { id: 'dwellMs', out: 'dwellVal', suffix: 'ms' },
    { id: 'cellMs', out: 'cellVal', suffix: 'ms' },
    { id: 'maxChars', out: 'maxVal', suffix: '' },
    { id: 'summaryChars', out: 'sumVal', suffix: ' chars' }
  ];
  const TOGGLES = ['enabled', 'showOverlay', 'summarize', 'logToPage', 'sayType'];

  function renderStatus(state, error) {
    const d = $('statusDot');
    d.className = 'dot ' + state;
    $('statusText').textContent =
      state === 'connected' ? 'bridge connected' :
      state === 'connecting' ? 'connecting...' : 'bytes only';
    $('hint').innerHTML = state === 'connected'
      ? 'Cells are going out over serial.'
      : 'No glove yet — bytes still appear above. '
        + 'To drive hardware: <code>python bridge/bridge.py --mock</code>';
    if (error && state !== 'connected') $('hint').title = error;
  }

  function renderCell(ch, n, cellDots) {
    dots.forEach(function (el) {
      el.classList.toggle('on', cellDots.indexOf(Number(el.dataset.d)) !== -1);
    });
    $('curChar').textContent = ch === ' ' ? '␣' : ch;
    $('curByte').textContent = 'dots ' + (cellDots.join('') || '-') + '  byte ' + n;
  }

  function scopeWord() {
    const v = $('scope').value;
    return v === 'visible' ? 'visible screen' : v === 'article' ? 'article' : 'whole page';
  }

  function renderProgress(msg) {
    if (!msg.total) return;
    $('readProgress').textContent =
      'cell ' + msg.index + ' of ' + msg.total
      + '  ·  ' + Math.round((msg.index / msg.total) * 100) + '%';
  }

  function renderIdle() {
    dots.forEach(function (el) { el.classList.remove('on'); });
    $('curChar').innerHTML = '&nbsp;';
    $('curByte').textContent = 'idle';
  }

  function renderGemini(ready, model, outdated, url) {
    if (url) $('statusText').title = 'connected to ' + url;
    const el = $('geminiState');
    if (ready) {
      el.textContent = 'Gemini ready' + (model ? ' (' + model + ')' : '');
    } else if (outdated) {
      el.innerHTML = 'This bridge is too old to summarize — restart it '
        + 'from the current folder.';
    } else {
      el.textContent = 'Bridge has no GEMINI_API_KEY — reading the raw text. '
        + 'Set the key and restart the bridge to summarize.';
    }
  }

  function renderSummary(msg) {
    if (msg.type === 'summarizing') {
      $('lastSummary').textContent = 'summarizing…';
      return;
    }
    const tag = (msg.scope ? msg.scope + ' → ' : '')
      + (msg.source === 'gemini' ? 'Gemini'
        : msg.source === 'fallback'
          ? 'fallback' + (msg.reason ? ' (' + msg.reason + ')' : ' (page text)')
        : 'page text');
    const outLen = (msg.text || '').length;
    const how = msg.source === 'gemini'
      ? msg.inChars + ' chars summarized to ' + outLen
      : outLen >= msg.inChars
        ? msg.inChars + ' chars, not summarized'
        : msg.inChars + ' chars cut to ' + outLen + ', not summarized';
    $('lastSummary').textContent = tag + ': ' + how + '  “'
      + (msg.text || '').slice(0, 80) + '”';
  }

  /* ---- page capture (testing) ---- */

  let captured = null;

  function fmtDuration(ms) {
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }

  $('capture').addEventListener('click', function () {
    $('captureStats').textContent = 'capturing…';
    chrome.runtime.sendMessage({ type: 'capturePage', scope: $('scope').value },
      function (res) {
        if (!res || res.error) {
          captured = null;
          $('captureStats').textContent = (res && res.error) || 'capture failed';
          $('captureText').textContent = '';
          return;
        }
        captured = res;
        $('captureStats').textContent =
          res.scope + '  ·  ' + res.chars + ' chars  ·  '
          + res.cells + ' cells  ·  ' + fmtDuration(res.ms) + ' on the palm';
        $('captureText').textContent = res.text || '(nothing captured)';
      });
  });

  $('copyCapture').addEventListener('click', function () {
    if (captured) copy(captured.text, $('copyCapture'));
  });

  $('copyCaptureBytes').addEventListener('click', function () {
    if (captured) copy(captured.bytes.join(', '), $('copyCaptureBytes'));
  });

  /* ---- byte output ---- */

  let lastEntry = null;
  let allEntries = [];

  function fmtTime(t) {
    const d = new Date(t);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
      + ':' + ('0' + d.getSeconds()).slice(-2);
  }

  function renderBytes(entry) {
    lastEntry = entry;
    const where = entry.sent ? '' : '  (no glove connected)';
    $('lastBytes').innerHTML = '';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = entry.source + ': “' + entry.chars + '”  '
      + entry.bytes.length + ' cells' + where;
    const row = document.createElement('span');
    row.textContent = entry.bytes.join(', ');
    $('lastBytes').appendChild(txt);
    $('lastBytes').appendChild(row);
  }

  function renderHistory(entries) {
    allEntries = entries;
    $('byteHistory').innerHTML = '';
    entries.forEach(function (e) {
      const row = document.createElement('div');
      row.innerHTML = '<b>' + fmtTime(e.at) + '</b> ' + e.bytes.length + ' cells  '
        + (e.chars || '').slice(0, 26);
      row.title = e.bytes.join(', ');
      row.addEventListener('click', function () { renderBytes(e); });
      $('byteHistory').appendChild(row);
    });
  }

  function copy(text, button) {
    navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(function () { button.textContent = old; }, 1000);
  }

  $('copyBytes').addEventListener('click', function () {
    if (lastEntry) copy(lastEntry.bytes.join(', '), $('copyBytes'));
  });

  $('copyAll').addEventListener('click', function () {
    const text = allEntries.slice().reverse().map(function (e) {
      return [fmtTime(e.at), e.source, e.chars, e.bytes.join(' ')].join('\t');
    }).join('\n');
    copy(text, $('copyAll'));
  });

  $('clearBytes').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'clearBytes' });
    allEntries = [];
    lastEntry = null;
    $('byteHistory').innerHTML = '';
    $('lastBytes').textContent = 'cleared';
  });

  chrome.runtime.sendMessage({ type: 'getBytes' }, function (res) {
    if (res && res.history && res.history.length) {
      renderHistory(res.history);
      renderBytes(res.history[0]);
    }
  });

  /* ---- load state ---- */

  chrome.runtime.sendMessage({ type: 'getStatus' }, function (res) {
    if (!res) { renderStatus('disconnected', 'service worker not responding'); return; }
    renderStatus(res.state, res.error);
    renderGemini(res.gemini, null, res.outdated, res.url);
    if (res.url) $('bridgeUrl').placeholder = res.url;
    const cfg = res.config;

    TOGGLES.forEach(function (k) { $(k).checked = !!cfg[k]; });
    SLIDERS.forEach(function (s) {
      $(s.id).value = cfg[s.id];
      $(s.out).textContent = cfg[s.id] + s.suffix;
    });
    $('scope').value = cfg.scope || 'full';
    $('bridgeUrl').value = cfg.bridgeUrl;
  });

  /* ---- controls ---- */

  TOGGLES.forEach(function (k) {
    $(k).addEventListener('change', function () {
      const patch = {}; patch[k] = $(k).checked;
      chrome.storage.local.set(patch);
    });
  });

  SLIDERS.forEach(function (s) {
    $(s.id).addEventListener('input', function () {
      const v = Number($(s.id).value);
      $(s.out).textContent = v + s.suffix;
      const patch = {}; patch[s.id] = v;
      chrome.storage.local.set(patch);
    });
  });

  $('scope').addEventListener('change', function () {
    chrome.storage.local.set({ scope: $('scope').value });
  });

  $('bridgeUrl').addEventListener('change', function () {
    chrome.storage.local.set({ bridgeUrl: $('bridgeUrl').value.trim() });
  });

  $('send').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'testSpeak', text: $('testText').value });
  });

  $('testText').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('send').click();
  });

  $('stop').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'stop' });
    renderIdle();
  });

  /* ---- mode 2: read the page ---- */

  $('readPage').addEventListener('click', function () {
    $('readProgress').textContent = 'reading the ' + scopeWord() + '…';
    chrome.runtime.sendMessage({ type: 'extractActiveTab' });
  });

  $('stopRead').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'stop' });
    $('readProgress').textContent = 'stopped';
    renderIdle();
  });

  $('reconnect').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'reconnect' });
    renderStatus('connecting');
  });

  /* ---- live updates from the service worker ---- */

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === 'status') renderStatus(msg.state, msg.error);
    else if (msg.type === 'cell') { renderCell(msg.ch, msg.n, msg.dots || []); renderProgress(msg); }
    else if (msg.type === 'done') { renderIdle(); $('readProgress').textContent = 'finished'; }
    else if (msg.type === 'gemini') renderGemini(msg.ready, msg.model, msg.outdated, msg.url);
    else if (msg.type === 'reading') {
      $('readProgress').textContent = msg.on ? 'reading… hover paused' : 'finished';
      $('hoverPaused').style.display = msg.on ? '' : 'none';
    }
    else if (msg.type === 'summary' || msg.type === 'summarizing') renderSummary(msg);
    else if (msg.type === 'bytes') {
      renderBytes(msg.entry);
      renderHistory([msg.entry].concat(allEntries).slice(0, 40));
    }
  });
})();
