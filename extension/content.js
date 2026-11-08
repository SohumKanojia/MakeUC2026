/* Braille Glove - content script.
 * Watches the mouse, resolves what is under it, and asks the service worker
 * to braille its label onto the glove. See context.md sections 5 and 8.
 */
(function () {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    dwellMs: 250,       // 5.1 - dwell before output starts
    maxChars: 20,       // 5.1 - truncate long labels
    showOverlay: true,  // on-screen mirror of the palm, for sighted demoing
    scope: 'full',      // what a page read covers: article | full | visible
    sayType: true       // prefix hover labels with button / link / field (5.3)
  };

  let cfg = Object.assign({}, DEFAULTS);
  let dwellTimer = null;
  let currentTarget = null;

  /* ---------- label extraction (5.2) ---------- */

  // Things worth reading. Checked innermost-first via closest().
  const WIDGET_SELECTOR = [
    'a[href]', 'button', '[role="button"]', '[role="link"]',
    'input', 'textarea', 'select', 'label',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'summary', 'li', '[tabindex]', '[aria-label]', 'img[alt]',
    'p', 'td', 'th'
  ].join(',');

  function resolveTarget(node) {
    if (!node || node === document.documentElement || node === document.body) return null;
    if (node.nodeType !== 1) node = node.parentElement;
    if (!node) return null;
    return node.closest(WIDGET_SELECTOR) || node;
  }

  /** The accessible name of a form control, without the control's own text.
   *  <label>City <select>...</select></label> must read "City", not
   *  "City cincinnati dayton columbus". */
  function controlName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();

    if (el.labels && el.labels.length) {
      const clone = el.labels[0].cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button').forEach(function (n) {
        n.remove();
      });
      const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    return el.placeholder || el.getAttribute('title') || '';
  }

  /** What a control currently holds. Passwords are never read out. */
  function controlValue(el, tag) {
    if (tag === 'select') {
      const opt = el.options && el.options[el.selectedIndex];
      return opt ? opt.text : '';
    }
    const type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'checkbox' || type === 'radio') return '';
    return el.value || '';
  }

  function labelFor(el) {
    if (!el || !el.getAttribute) return '';
    const tag = (el.tagName || '').toLowerCase();

    // Form controls first: they need name AND value, so the generic
    // aria-label shortcut below would lose half the answer.
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const name = controlName(el);
      const value = controlValue(el, tag);
      return [name, value].filter(Boolean).join(' ') || el.type || '';
    }

    // aria-label -> aria-labelledby -> alt -> innerText -> title
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy.split(/\s+/)[0]);
      if (ref && ref.innerText && ref.innerText.trim()) return ref.innerText;
    }

    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt;

    const text = (el.innerText || el.textContent || '').trim();
    if (text) return text;
    return el.getAttribute('title') || '';
  }

  function truncate(text) {
    const t = String(text).trim();
    return t.length > cfg.maxChars ? t.slice(0, cfg.maxChars) : t;
  }

  /* ---------- element type cues (5.3) ----------
   * A screen reader says "Save, button". We put the type FIRST - "button
   * save" - because braille arrives one cell at a time: knowing what you
   * are on after two words is worth more than hearing it after ten.
   * Words are kept short, since every extra letter is half a second.
   */

  const ROLE_WORDS = {
    button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio',
    textbox: 'field', searchbox: 'search', combobox: 'menu', listbox: 'menu',
    heading: 'heading', img: 'image', option: 'option', tab: 'tab',
    menuitem: 'menu', switch: 'switch', slider: 'slider'
  };

  function typeOf(el) {
    if (!el || !el.getAttribute) return '';
    const explicit = (el.getAttribute('role') || '').toLowerCase();
    if (ROLE_WORDS[explicit]) return ROLE_WORDS[explicit];

    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'menu';
    if (tag === 'textarea') return 'field';
    if (tag === 'img') return 'image';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return '';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'search') return 'search';
      return 'field';
    }
    return '';                              // plain text gets no cue
  }

  /** Checked / empty, where it changes what the user would do next. */
  function stateOf(el, type) {
    if (type === 'checkbox' || type === 'radio') {
      const on = el.checked || el.getAttribute('aria-checked') === 'true';
      return on ? 'checked' : 'not checked';
    }
    if (type === 'field' || type === 'search') {
      if (!el.value) return 'empty';
    }
    return '';
  }

  /**
   * What the glove should say for this element.
   * The label is truncated first, so a long label never squeezes out the
   * type word that makes it understandable.
   */
  function describe(el) {
    const label = truncate(labelFor(el));
    if (!cfg.sayType) return label;

    const type = typeOf(el);
    if (!type) return label;

    const state = stateOf(el, type);
    return [type, label, state].filter(Boolean).join(' ');
  }

  /* ---------- messaging ---------- */

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
    } catch (e) { /* worker restarting; the next event will retry */ }
  }

  function cancelOutput() {
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
    send({ type: 'cancel' });
  }

  /* ---------- hover handling (5.1) ---------- */

  function onPointerMove(event) {
    if (!cfg.enabled) return;

    const target = resolveTarget(event.target);
    if (target === currentTarget) return;

    // New target: interrupt whatever is playing, clear the motors, then re-dwell.
    currentTarget = target;
    cancelOutput();
    if (!target) return;

    const text = describe(target);
    if (!text) return;

    dwellTimer = setTimeout(function () {
      dwellTimer = null;
      send({ type: 'speak', text: text, source: 'hover' });
      if (cfg.showOverlay) markTarget(target);
    }, cfg.dwellMs);
  }

  function onFocusIn(event) {
    if (!cfg.enabled) return;
    const target = resolveTarget(event.target);
    if (!target || target === currentTarget) return;
    currentTarget = target;
    cancelOutput();
    const text = describe(target);
    if (text) send({ type: 'speak', text: text, source: 'focus' });
  }

  /* ---------- page text extraction (8.1) ----------
   * A small Readability-style pass: strip the furniture, then pick the
   * element that actually holds the prose. Mozilla's Readability.js does
   * this far better, but it is 100 kB and this is a few dozen lines, and
   * what reaches the glove is a ~140 character summary either way.
   */

  // Chrome, menus, ads, and anything explicitly hidden from assistive tech.
  const JUNK_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'nav', 'header', 'footer', 'aside', 'form', 'button', 'select',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '[role="search"]', '[role="alert"]',
    '[aria-hidden="true"]', '[hidden]',
    '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header',
    '.ad', '.ads', '.advert', '.cookie', '.banner', '.popup', '.modal',
    '.comment', '.comments', '.share', '.social', '.related', '.promo'
  ].join(',');

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** How much real prose does this container hold? */
  function score(el) {
    const paras = el.querySelectorAll('p, li, blockquote, h1, h2, h3');
    let chars = 0;
    for (const p of paras) chars += textOf(p).length;
    // A container that is mostly links is a menu, not an article.
    const linkChars = Array.prototype.reduce.call(
      el.querySelectorAll('a'), function (sum, a) { return sum + textOf(a).length; }, 0);
    const total = textOf(el).length || 1;
    const linkRatio = linkChars / total;
    return linkRatio > 0.5 ? chars * 0.2 : chars;
  }

  function extractPage() {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return { title: document.title || '', text: '' };

    clone.querySelectorAll(JUNK_SELECTOR).forEach(function (el) { el.remove(); });

    // 1. Trust an explicit main/article region if it has real content.
    let best = null, bestScore = 0;
    const explicit = clone.querySelector('article, main, [role="main"]');
    if (explicit && score(explicit) > 150) {
      best = explicit;
    } else {
      // 2. Otherwise pick the densest container.
      const candidates = clone.querySelectorAll('article, main, section, div');
      for (const el of candidates) {
        const s = score(el);
        // Prefer the deepest element that still holds the bulk of the text,
        // so we land on the article body and not on a wrapper around it.
        if (s > bestScore * 1.02) { best = el; bestScore = s; }
      }
    }

    // 3. Nothing convincing: fall back to the stripped body.
    const root = best && textOf(best).length > 120 ? best : clone;
    let text = textOf(root);

    // Headings often carry the point of the page; keep the h1 at the front.
    const h1 = document.querySelector('h1');
    const head = h1 ? textOf(h1) : '';
    if (head && text.indexOf(head) > 400) text = head + '. ' + text;

    return { title: document.title || head || '', text: text };
  }

  /** Kept for the non-summarized path and for anything that wants raw text. */
  function extractPageText() {
    return extractPage().text;
  }

  /* ---------- whole-screen capture ----------
   * extractPage() deliberately throws most of the page away. These two take
   * everything instead:
   *   "full"    - the entire document, top to bottom, scrolled or not
   *   "visible" - only what is on screen right now, the DOM equivalent of a
   *               screenshot (no OCR: the text is already in the page)
   * Both walk text nodes rather than reading innerText off containers, so
   * nothing is counted twice, and both pick up labels that carry no text
   * node of their own: alt text, aria-labels, input values and placeholders.
   */

  // Elements whose aria-label stands in for their contents, as a screen
  // reader would announce them.
  const ARIA_FIRST = new Set(['button', 'a', 'summary', 'label', 'option', 'th']);

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'object', 'embed', 'audio', 'video', 'map', 'head', 'title', 'meta', 'link'
  ]);

  function isRendered(el) {
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hidden) return false;
    const cs = getComputedStyle(el);
    return !(cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0');
  }

  function onScreen(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    return r.bottom > 0 && r.right > 0
      && r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
  }

  /**
   * @param {'full'|'visible'} scope
   * @returns {{title:string, url:string, text:string, chars:number, scope:string}}
   */
  function captureScreen(scope) {
    const visibleOnly = scope === 'visible';
    const parts = [];

    function push(s) {
      const t = (s || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }

    function walk(node) {
      if (node.nodeType === 3) { push(node.nodeValue); return; }   // text node
      if (node.nodeType !== 1) return;

      const tag = node.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (node === host) return;                      // our own overlay
      if (!isRendered(node)) return;
      // A container off screen takes its whole subtree with it.
      if (visibleOnly && !onScreen(node)) return;

      // Elements whose content is an attribute, not a child text node.
      if (tag === 'img' || tag === 'area') { push(node.getAttribute('alt')); return; }
      if (tag === 'input') {
        const type = (node.type || '').toLowerCase();
        if (type === 'hidden') return;
        if (type === 'submit' || type === 'button') { push(node.value); return; }
        if (type === 'checkbox' || type === 'radio') {
          push((node.getAttribute('aria-label') || '') + (node.checked ? ' checked' : ''));
          return;
        }
        push(node.value || node.placeholder || node.getAttribute('aria-label'));
        return;
      }
      if (tag === 'textarea') { push(node.value || node.placeholder); return; }
      if (tag === 'select') {
        const opt = node.options && node.options[node.selectedIndex];
        push(opt ? opt.text : node.getAttribute('aria-label'));
        return;
      }
      // An aria-label replaces the content of a control, which is what a
      // screen reader announces: <button aria-label="delete file">Trash</button>
      // reads as "delete file". Only for controls and leaves, never for a
      // labelled container, or we would swallow everything inside it.
      const aria = node.getAttribute('aria-label');
      if (aria && (ARIA_FIRST.has(tag) || !node.firstElementChild)) {
        push(aria);
        return;
      }

      // A leaf with no text at all: an icon-only control, labelled by title.
      if (!node.firstElementChild && !node.textContent.trim()) {
        push(node.getAttribute('title'));
        return;
      }

      if (node.shadowRoot) {
        node.shadowRoot.childNodes.forEach(walk);     // open shadow DOM
      }
      node.childNodes.forEach(walk);
    }

    if (document.body) walk(document.body);

    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return {
      title: document.title || '',
      url: location.href,
      text: text,
      chars: text.length,
      scope: scope
    };
  }

  /** One entry point for every read: 'article' | 'full' | 'visible'. */
  function capture(scope) {
    if (scope === 'full' || scope === 'visible') return captureScreen(scope);
    const page = extractPage();                       // 'article', the default
    page.url = location.href;
    page.chars = page.text.length;
    page.scope = 'article';
    return page;
  }

  /* ---------- on-screen overlay (demo aid; the glove is the real output) ---------- */

  let host = null, shadow = null, els = null, highlight = null;

  function buildOverlay() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>',
      '.box{font:12px/1.3 ui-monospace,Menlo,Consolas,monospace;background:#101014;color:#e9e9ef;',
      'border:1px solid #2a2a35;border-radius:10px;padding:10px 12px;display:flex;gap:12px;',
      'align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.4);opacity:0;transition:opacity .15s}',
      '.box.on{opacity:1}',
      '.cell{display:grid;grid-template-columns:14px 14px;grid-gap:5px}',
      '.dot{width:14px;height:14px;border-radius:50%;background:#26262f;border:1px solid #35353f}',
      '.dot.on{background:#ffb43a;border-color:#ffb43a;box-shadow:0 0 10px #ffb43a88}',
      '.meta{min-width:92px}',
      '.ch{font-size:22px;font-weight:700;line-height:1}',
      '.byte{color:#ffb43a;margin-top:3px;font-weight:600}',
      '.sub{color:#8d8d9b;margin-top:3px;word-break:break-all}',
      '</style>',
      '<div class="box">',
      '<div class="cell">',
      '<div class="dot" data-d="1"></div><div class="dot" data-d="4"></div>',
      '<div class="dot" data-d="2"></div><div class="dot" data-d="5"></div>',
      '<div class="dot" data-d="3"></div><div class="dot" data-d="6"></div>',
      '</div>',
      '<div class="meta"><div class="ch">&nbsp;</div>',
      '<div class="byte"></div><div class="sub"></div></div>',
      '</div>'
    ].join('');
    (document.body || document.documentElement).appendChild(host);
    els = {
      box: shadow.querySelector('.box'),
      dots: Array.prototype.slice.call(shadow.querySelectorAll('.dot')),
      ch: shadow.querySelector('.ch'),
      byte: shadow.querySelector('.byte'),
      sub: shadow.querySelector('.sub')
    };
  }

  function showCell(ch, dots, word, n) {
    if (!cfg.showOverlay) return;
    buildOverlay();
    els.box.classList.add('on');
    els.dots.forEach(function (d) {
      d.classList.toggle('on', dots.indexOf(Number(d.dataset.d)) !== -1);
    });
    els.ch.textContent = ch === ' ' ? '␣' : ch;
    if (n !== undefined) els.byte.textContent = 'byte ' + n;
    if (word !== undefined) els.sub.textContent = word;
  }

  function hideCell() {
    if (!els) return;
    els.box.classList.remove('on');
    els.dots.forEach(function (d) { d.classList.remove('on'); });
  }

  function markTarget(el) {
    if (highlight) highlight.remove();
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    highlight = document.createElement('div');
    highlight.style.cssText =
      'all:initial;position:fixed;pointer-events:none;z-index:2147483646;' +
      'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' +
      'outline:2px solid #ffb43a;outline-offset:2px;border-radius:3px;';
    (document.body || document.documentElement).appendChild(highlight);
    const mine = highlight;
    setTimeout(function () { if (mine.parentNode) mine.remove(); }, 1200);
  }

  /* ---------- wiring ---------- */

  chrome.runtime.onMessage.addListener(function (msg, _sender, respond) {
    switch (msg && msg.type) {
      case 'cell':                       // the service worker is playing this cell
        showCell(msg.ch, msg.dots || [], msg.word, msg.n);
        break;
      case 'idle':
        hideCell();
        break;
      case 'logBytes': {               // opt-in: byte output in the page console
        const e = msg.entry;
        console.log('%c braille %c ' + e.source + ' "' + e.chars + '" '
          + e.bytes.length + ' cells\n' + e.bytes.join(' '),
          'background:#ffb43a;color:#1a1205;font-weight:700;border-radius:3px',
          'color:#ffb43a');
        break;
      }
      case 'extract': {                  // thumb single tap (8.1)
        const page = capture(msg.scope || cfg.scope);
        send({
          type: 'speak', text: page.text, title: page.title,
          scope: page.scope, source: 'extract'
        });
        break;
      }
      case 'getPageText':
        respond(capture((msg && msg.scope) || cfg.scope));
        return true;
      case 'config':
        cfg = Object.assign({}, cfg, msg.config);
        if (!cfg.showOverlay && host) { host.remove(); host = null; els = null; }
        break;
    }
  });

  chrome.storage.local.get(DEFAULTS, function (stored) {
    cfg = Object.assign({}, cfg, stored);
  });
  chrome.storage.onChanged.addListener(function (changes) {
    Object.keys(changes).forEach(function (k) {
      if (k in DEFAULTS) cfg[k] = changes[k].newValue;
    });
    if (!cfg.showOverlay && host) { host.remove(); host = null; els = null; }
  });

  document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
  document.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('blur', cancelOutput);
})();
