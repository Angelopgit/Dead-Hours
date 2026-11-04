/** Text chat limits, shared so the input box and the server agree. */
export const CHAT = {
  /** Longest message, in characters. */
  maxLength: 160,
  /** Messages that may be sent back to back... */
  burst: 4,
  /** ...after which one more is allowed every this many seconds. */
  refillSeconds: 1.5,
} as const;

// The filtered words are stored in ROT13 so the list doesn't read as plain slurs in the source.
const ENCODED =
  'shpx shpxf shpxre shpxref shpxvat shpxva shpxrq shpxsnpr shpxurnq zbgureshpxre zbgureshpxref zbsb spx shx shd jgs fgsh tgsb ' +
  'fuvg fuvgf fuvggl fuvgurnq fuvggre ohyyfuvg ubefrfuvg qvcfuvg fuvgr nff nffrf nffubyr nffubyrf nefr nefrubyr wnpxnff qhzonff ' +
  'fznegnff onqnff ovgpu ovgpurf ovgpul onfgneq onfgneqf qvpx qvpxf qvpxurnq pbpx pbpxf pbpxfhpxre phag phagf gjng gjngf cevpx ' +
  'cevpxf chffl chffvrf jnaxre jnaxref jnax obyybpxf fyhg fyhgf fyhggl juber juberf wvmm phz phzfubg gvgf gvggvrf gvggl obbof ' +
  'qvyqb cbea cbeab encr encrq encvfg cvff cvffrq avttre avttref avttn avttnf snttbg snttbgf snt sntf qlxr qlxrf genaal genaavrf ' +
  'ergneq ergneqf ergneqrq fcvp fcvpf puvax puvaxf xvxr xvxrf tbbx tbbxf jrgonpx jrgonpxf pbba pbbaf ornare ornaref enturnq ' +
  'enturnqf gbjryurnq cnxv cnxvf furznyr xlf';

const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

const WORDS = new Set(ENCODED.split(' ').map(rot13));
/** Endings that keep a filtered word filtered (bitching, wankered). */
const SUFFIXES = ['s', 'es', 'er', 'ers', 'ing', 'ed', 'y'];
/** Ordinary words that a filtered word plus an ending would otherwise catch. */
const ALLOWED = new Set(['spicy', 'spicer', 'cocky', 'cocker', 'cocked', 'cocking', 'pricked', 'pricking', 'assed']);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's' };

/** A token as the filter compares it: no accents, lower case, digits and symbols read as the letters they stand for. */
function skeleton(token: string): string {
  return token.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[0-9@$]/g, (c) => LEET[c] ?? c);
}

function listed(word: string): boolean {
  if (ALLOWED.has(word)) return false;
  if (WORDS.has(word)) return true;
  return SUFFIXES.some((s) => word.length > s.length + 2 && word.endsWith(s) && WORDS.has(word.slice(0, -s.length)));
}

/** Whether a token is a filtered word, allowing for stretched letters (fuuuck, shiiit). */
function bad(token: string): boolean {
  const w = skeleton(token);
  if (!/^[a-z]+$/.test(w)) return false;
  return listed(w) || listed(w.replace(/(.)\1{2,}/g, '$1$1')) || listed(w.replace(/(.)\1+/g, '$1'));
}

/** Replaces filtered words with asterisks, including spaced-out ones ("f u c k"). Whole words only. */
export function censor(text: string): string {
  const tokens = [...text.matchAll(/[\p{L}\p{N}@$]+/gu)].map((m) => ({ at: m.index!, text: m[0] }));
  const hit: boolean[] = tokens.map((t) => bad(t.text));
  // Runs of single letters split by spaces or dots read as one word.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text.length !== 1) continue;
    let j = i;
    while (j + 1 < tokens.length && tokens[j + 1].text.length === 1
      && /^[\s._-]{1,2}$/.test(text.slice(tokens[j].at + 1, tokens[j + 1].at))) j++;
    if (j - i >= 2 && bad(tokens.slice(i, j + 1).map((t) => t.text).join(''))) for (let k = i; k <= j; k++) hit[k] = true;
    i = j;
  }
  if (!hit.includes(true)) return text;
  const chars = [...text];
  // Token offsets are UTF-16 indices; map them onto code points.
  const index: number[] = [];
  let u = 0;
  chars.forEach((c, i) => {
    index[u] = i;
    u += c.length;
  });
  tokens.forEach((t, k) => {
    if (!hit[k]) return;
    const start = index[t.at];
    const len = [...t.text].length;
    for (let i = start; i < start + len; i++) chars[i] = '*';
  });
  return chars.join('');
}

/**
 * What a chat message may contain: printable text on one line, no direction overrides or invisible
 * characters, no stacks of combining marks, single spaces, at most CHAT.maxLength characters.
 */
export function cleanChat(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .slice(0, CHAT.maxLength * 4)
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g, ' ')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, CHAT.maxLength).join('').trim();
}
