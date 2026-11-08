/* Checks the converter against the tables in context.md and UEB.
 * Run:  node test-braille.js
 */
global.self = {};
require('./extension/braille.js');
const B = global.self.Braille;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + g + '\n         want ' + w); }
}

console.log('\nletter bytes (context.md 3.2 worked examples)');
eq('d = dots 145 = 25', B.CHAR_TO_BYTE.d, 25);
eq('y = dots 13456 = 61', B.CHAR_TO_BYTE.y, 61);
eq('a = 1', B.CHAR_TO_BYTE.a, 1);
eq('z = dots 1356 = 37+... ', B.CHAR_TO_BYTE.z, 1 + 4 + 16 + 32);

console.log('\nall 26 letters are distinct and in range');
const seen = new Set();
let allGood = true;
for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
  const n = B.CHAR_TO_BYTE[ch];
  if (n < 1 || n > 63 || seen.has(n)) allGood = false;
  seen.add(n);
}
eq('26 unique bytes in 1..63', allGood && seen.size === 26, true);

console.log('\nround trip byte -> char');
let rt = true;
for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
  if (B.byteToChar(B.CHAR_TO_BYTE[ch]) !== ch) rt = false;
}
eq('every letter survives the round trip', rt, true);
eq('byte 0 is a space', B.byteToChar(0), ' ');

console.log('\nbasic mode: a-z and spaces only');
eq('"Hello, World! 123" -> letters only',
  B.textToCells('Hello, World! 123').map(c => c.ch).join(''),
  'hello world');
eq('bytes for "hi"', B.textToBytes('hi'), [19, 10]);
eq('whitespace collapses', B.cleanText('  a \n\t  b  '), 'a b');
eq('no leading or trailing space', B.cleanText('   abc   '), 'abc');
eq('digits dropped when numbers are off', B.cleanText('a1b'), 'ab');
eq('punctuation dropped when off', B.cleanText('a,b.'), 'ab');

console.log('\nunicode braille output (U+2800 + byte)');
eq('"abc" as unicode', B.textToUnicode('abc'), '⠁⠃⠉');
eq('space is the blank cell U+2800', B.textToUnicode('a b')[1], '⠀');

console.log('\ncapitals (opt-in, dot 6 before the letter)');
eq('capital sign is 32', B.CAPITAL_BYTE, 32);
eq('"Ab" -> capital, a, b', B.textToBytes('Ab', { capitals: true }), [32, 1, 3]);
eq('capitals off by default', B.textToBytes('Ab'), [1, 3]);

console.log('\nnumbers (opt-in, dots 3456 then a-j)');
eq('number sign is 60', B.NUMBER_BYTE, 60);
eq('"12" -> sign, a, b', B.textToBytes('12', { numbers: true }), [60, 1, 3]);
eq('"0" -> sign, j', B.textToBytes('0', { numbers: true }), [60, B.CHAR_TO_BYTE.j]);
eq('one sign for a run, reopened after a letter',
  B.textToCells('12a3', { numbers: true }).map(c => c.kind).join(','),
  'number-sign,digit,digit,letter,number-sign,digit');
eq('numeric mode closes at a space',
  B.textToCells('1 2', { numbers: true }).map(c => c.kind).join(','),
  'number-sign,digit,space,number-sign,digit');

console.log('\npunctuation (opt-in, UEB)');
const P = { punctuation: true };
eq('comma = dots 2', B.textToBytes(',', P), [2]);
eq('semicolon = dots 23', B.textToBytes(';', P), [2 + 4]);
eq('colon = dots 25', B.textToBytes(':', P), [2 + 16]);
eq('period = dots 256', B.textToBytes('.', P), [2 + 16 + 32]);
eq('exclamation = dots 235', B.textToBytes('!', P), [2 + 4 + 16]);
eq('question = dots 236', B.textToBytes('?', P), [2 + 4 + 32]);
eq('apostrophe = dot 3', B.textToBytes("'", P), [4]);
eq('hyphen = dots 36', B.textToBytes('-', P), [4 + 32]);
eq('punctuation never collides with a letter',
  Object.values(B.PUNCT_DOTS).every(d => B.byteToChar(B.dotsToByte(d)) === null), true);

console.log('\neverything on');
eq('"Hi, 42!" full',
  B.textToCells('Hi, 42!', B.FULL).map(c => c.label).join(' '),
  'capital sign h i , space number sign 4 2 !');

console.log('\ndropped-character report');
eq('reports what basic mode throws away',
  B.droppedChars('a1b@c'), { '1': 1, '@': 1 });
eq('nothing dropped with numbers on',
  B.droppedChars('a1b', { numbers: true }), {});

console.log('\ntiming estimate');
eq('"ab" at 400+150 = 1100ms',
  B.estimateMs(B.textToCells('ab'), { cellMs: 400, gapMs: 150 }), 1100);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
