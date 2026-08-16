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
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '<ip>'],
  // IPv6: full 8-group form, or any form containing "::". Times like 09:14:02
  // have neither, so they fall through to <n>. Bracketed [::1]:8080 keeps its brackets.
  [
    /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})(?![\w:])/gi,
    '<ip>',
  ],
  // Require at least one letter so long decimals (epoch ms) stay <n>.
  [/\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, '<hex>'],
  // No \b: digit-to-letter is not a word boundary, and "250ms" must become "<n>ms".
  // Dotted runs (1.2.3, 3.14) collapse to a single <n>.
  [/\d+(\.\d+)*/g, '<n>'],
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
