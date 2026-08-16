// Order matters: uuid before hex, hex before number — earlier rules must
// consume their pattern before a broader rule can eat parts of it.
const RULES: Array<[RegExp, string]> = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\bhttps?:\/\/\S+/gi, '<url>'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>'],
  // Quoted strings. Lookbehind so apostrophes inside words (can't) don't open one.
  [/(?<!\w)"[^"]{1,120}"|(?<!\w)'[^']{1,120}'/g, '<str>'],
  // Filesystem paths: two+ segments so a bare "/" or "a/b" version-ish tokens don't match.
  [/(?<![\w.])\/[\w.-]+(\/[\w.-]+)+/g, '<path>'],
  // logfmt bare-word values (key=value, unquoted, starts with a letter).
  [/(?<=\b\w+=)[A-Za-z][\w.:-]*/g, '<v>'],
  // Full ISO datetime mid-message — before <ip>/<n> so it collapses to one token
  // instead of fragmenting into <n>-<n>-<n>T<n>:<n>:<n>Z.
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>'],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '<ip>'],
  // IPv6: full 8-group form, or any form containing "::". Times like 09:14:02
  // have neither, so they fall through to <n>. Bracketed [::1]:8080 keeps its brackets.
  [
    /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})(?![\w:])/gi,
    '<ip>',
  ],
  // sha256:<64 hex> prefix form — before <hex> so the whole token collapses.
  [/\bsha256:[0-9a-f]{64}\b/gi, '<sha>'],
  // Require at least one letter so long decimals (epoch ms) stay <n>.
  [/\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, '<hex>'],
  // Short hex ids (6-11 chars): need ≥1 digit AND ≥1 letter so real words
  // (facade, decade) survive.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,11}\b/gi, '<hex>'],
  // Base64 blobs: need ≥1 digit AND ≥1 letter so plain words don't match.
  [/(?<![\w+/=])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Za-z])[A-Za-z0-9+/]{20,}={0,2}(?![\w+/=])/g, '<b64>'],
  // No \b: digit-to-letter is not a word boundary, and "250ms" must become "<n>ms".
  // Dotted runs (1.2.3, 3.14) collapse to a single <n>. Negative lookbehind stops
  // it re-chewing digits inside an already-placed placeholder (e.g. "<b64>").
  [/(?<!<[a-z0-9]{0,10})\d+(\.\d+)*/g, '<n>'],
];

/** Mask variable parts of a line. `extra` rules (from `--mask`) run first and yield `<mask>`. */
export function mask(line: string, extra: RegExp[] = []): string {
  let out = line;
  for (const re of extra) out = out.replace(re, '<mask>');
  for (const [re, token] of RULES) out = out.replace(re, token);
  return out;
}

/** Compile a user `--mask` pattern: always global, never sticky. */
export function compileMask(src: string): RegExp {
  try {
    return new RegExp(src, 'g');
  } catch (e) {
    throw new Error(`--mask: invalid regex ${JSON.stringify(src)}: ${(e as Error).message}`);
  }
}
