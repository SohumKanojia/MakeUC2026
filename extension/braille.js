/* Braille Glove - text to braille converter. Single source of truth,
 * shared by the content script, the service worker and converter.html.
 *
 * Grade 1 (uncontracted). Cell byte: bit0 = dot1 ... bit5 = dot6,
 * so the Unicode braille char is simply U+2800 + byte.
 *
 * Defaults are "basics first" (context.md): lowercase a-z and spaces only.
 * Capitals, digits and punctuation are real but opt-in, so turning them on
 * is a decision, not an accident.
 */
(function (root) {
  'use strict';

  /* ---------------- dot tables ---------------- */

  // Letters, context.md 3.3
  const LETTER_DOTS = {
    a: [1],            b: [1, 2],         c: [1, 4],
    d: [1, 4, 5],      e: [1, 5],         f: [1, 2, 4],
    g: [1, 2, 4, 5],   h: [1, 2, 5],      i: [2, 4],
    j: [2, 4, 5],      k: [1, 3],         l: [1, 2, 3],
    m: [1, 3, 4],      n: [1, 3, 4, 5],   o: [1, 3, 5],
    p: [1, 2, 3, 4],   q: [1, 2, 3, 4, 5],r: [1, 2, 3, 5],
    s: [2, 3, 4],      t: [2, 3, 4, 5],   u: [1, 3, 6],
    v: [1, 2, 3, 6],   w: [2, 4, 5, 6],   x: [1, 3, 4, 6],
    y: [1, 3, 4, 5, 6],z: [1, 3, 5, 6]
  };

  // Punctuation, UEB (context.md 3.5)
  const PUNCT_DOTS = {
    ',': [2],
    ';': [2, 3],
    ':': [2, 5],
    '.': [2, 5, 6],
    '!': [2, 3, 5],
    '?': [2, 3, 6],
    "'": [3],
    '-': [3, 6]
  };

  // Indicators (context.md 3.5)
  const CAPITAL_DOTS = [6];           // before a capital letter
  const NUMBER_DOTS = [3, 4, 5, 6];   // before a run of digits

  // Digits reuse a-j: 1=a ... 9=i, 0=j
  const DIGIT_LETTER = {
    '1': 'a', '2': 'b', '3': 'c', '4': 'd', '5': 'e',
    '6': 'f', '7': 'g', '8': 'h', '9': 'i', '0': 'j'
  };

  function dotsToByte(dots) {
    let n = 0;
    for (const d of dots) n |= 1 << (d - 1);
    return n;
  }

  function byteToDots(n) {
    const dots = [];
    for (let d = 1; d <= 6; d++) if (n & (1 << (d - 1))) dots.push(d);
    return dots;
  }

  const CHAR_TO_BYTE = {};
  const BYTE_TO_CHAR = {};
  for (const ch of Object.keys(LETTER_DOTS)) {
    const n = dotsToByte(LETTER_DOTS[ch]);
    CHAR_TO_BYTE[ch] = n;
    BYTE_TO_CHAR[n] = ch;             // inverse, for input mode (9.2a)
  }
  CHAR_TO_BYTE[' '] = 0;
  BYTE_TO_CHAR[0] = ' ';

  const PUNCT_BYTE = {};
  for (const ch of Object.keys(PUNCT_DOTS)) PUNCT_BYTE[ch] = dotsToByte(PUNCT_DOTS[ch]);

  const CAPITAL_BYTE = dotsToByte(CAPITAL_DOTS);   // 32
  const NUMBER_BYTE = dotsToByte(NUMBER_DOTS);     // 60

  /* ---------------- options ---------------- */

  const BASIC = { capitals: false, numbers: false, punctuation: false };
  const FULL = { capitals: true, numbers: true, punctuation: true };

  function opts(o) {
    return Object.assign({}, BASIC, o || {});
  }

  /* ---------------- conversion ---------------- */

  /** What the glove will actually feel, as plain text. Mirrors textToCells. */
  function cleanText(text, o) {
    return textToCells(text, o).map(function (c) { return c.ch; }).join('');
  }

  /**
   * Convert text to a list of cells.
   * @param {string} text
   * @param {{capitals?:boolean, numbers?:boolean, punctuation?:boolean}} [o]
   * @returns {Array<{ch:string, n:number, dots:number[], kind:string, label:string,
   *                  unicode:string, skipped?:string}>}
   */
  function textToCells(text, o) {
    const cfg = opts(o);
    const cells = [];
    const src = String(text == null ? '' : text).replace(/[\s ]+/g, ' ');

    let inNumber = false;             // numeric mode is open

    function push(ch, n, kind, label) {
      cells.push({
        ch: ch,
        n: n,
        dots: byteToDots(n),
        kind: kind,
        label: label || ch,
        unicode: String.fromCharCode(0x2800 + n)
      });
    }

    for (let i = 0; i < src.length; i++) {
      const raw = src[i];

      // --- space: blank cell, closes numeric mode ---
      if (raw === ' ') {
        inNumber = false;
        // collapse runs of spaces into one
        if (cells.length && cells[cells.length - 1].kind === 'space') continue;
        if (!cells.length) continue;                 // no leading space
        push(' ', 0, 'space', 'space');
        continue;
      }

      const lower = raw.toLowerCase();

      // --- digits ---
      if (raw >= '0' && raw <= '9') {
        if (!cfg.numbers) { inNumber = false; continue; }
        if (!inNumber) {
          push('#', NUMBER_BYTE, 'number-sign', 'number sign');
          inNumber = true;
        }
        const letter = DIGIT_LETTER[raw];
        push(raw, CHAR_TO_BYTE[letter], 'digit', raw);
        continue;
      }

      // Anything that is not a digit ends numeric mode.
      inNumber = false;

      // --- letters ---
      if (lower >= 'a' && lower <= 'z') {
        const isUpper = raw !== lower && raw === raw.toUpperCase();
        if (isUpper && cfg.capitals) {
          push('^', CAPITAL_BYTE, 'capital-sign', 'capital sign');
        }
        push(lower, CHAR_TO_BYTE[lower], 'letter', lower);
        continue;
      }

      // --- punctuation ---
      if (Object.prototype.hasOwnProperty.call(PUNCT_BYTE, raw)) {
        if (!cfg.punctuation) continue;
        push(raw, PUNCT_BYTE[raw], 'punctuation', raw);
        continue;
      }

      // --- anything else is dropped (3.4) ---
    }

    // no trailing space
    while (cells.length && cells[cells.length - 1].kind === 'space') cells.pop();
    return cells;
  }

  /** Just the byte stream, which is what goes over the wire. */
  function textToBytes(text, o) {
    return textToCells(text, o).map(function (c) { return c.n; });
  }

  /** Unicode braille string, for display and for copy-paste. */
  function textToUnicode(text, o) {
    return textToCells(text, o).map(function (c) { return c.unicode; }).join('');
  }

  /** Characters present in the input that the current options will drop. */
  function droppedChars(text, o) {
    const cfg = opts(o);
    const dropped = {};
    const src = String(text == null ? '' : text);
    for (const raw of src) {
      if (/[\sa-zA-Z]/.test(raw)) continue;
      if (raw >= '0' && raw <= '9') { if (cfg.numbers) continue; }
      else if (Object.prototype.hasOwnProperty.call(PUNCT_BYTE, raw)) { if (cfg.punctuation) continue; }
      dropped[raw] = (dropped[raw] || 0) + 1;
    }
    return dropped;
  }

  /** Cell byte -> letter or space, or null. Inverse of the letter table. */
  function byteToChar(n) {
    const ch = BYTE_TO_CHAR[n & 0x3f];
    return ch === undefined ? null : ch;
  }

  /** Three-line ASCII art of one cell. */
  function cellToAscii(n) {
    const on = function (d) { return (n & (1 << (d - 1))) ? 'O' : '.'; };
    return [on(1) + ' ' + on(4), on(2) + ' ' + on(5), on(3) + ' ' + on(6)].join('\n');
  }

  /** How long a cell list takes to play, in ms, at the given timings. */
  function estimateMs(cells, timing) {
    const t = Object.assign({ cellMs: 400, gapMs: 150, spaceMs: 400 }, timing || {});
    let total = 0;
    for (const c of cells) {
      total += c.n === 0 ? t.spaceMs : t.cellMs + t.gapMs;
    }
    return total;
  }

  root.Braille = {
    LETTER_DOTS: LETTER_DOTS,
    PUNCT_DOTS: PUNCT_DOTS,
    CHAR_TO_BYTE: CHAR_TO_BYTE,
    BYTE_TO_CHAR: BYTE_TO_CHAR,
    CAPITAL_BYTE: CAPITAL_BYTE,
    NUMBER_BYTE: NUMBER_BYTE,
    BASIC: BASIC,
    FULL: FULL,
    dotsToByte: dotsToByte,
    byteToDots: byteToDots,
    cleanText: cleanText,
    textToCells: textToCells,
    textToBytes: textToBytes,
    textToUnicode: textToUnicode,
    droppedChars: droppedChars,
    byteToChar: byteToChar,
    cellToAscii: cellToAscii,
    estimateMs: estimateMs
  };
})(typeof self !== 'undefined' ? self : this);
