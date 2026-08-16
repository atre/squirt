// Order matters: uuid before hex, hex before number — earlier rules must
// consume their pattern before a broader rule can eat parts of it.
const RULES: Array<[RegExp, string]> = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\bhttps?:\/\/\S+/gi, '<url>'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>'],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '<ip>'],
  // IPv6: full 8-group form, or any form containing "::". Times like 09:14:02
  // have neither, so they fall through to <n>. Bracketed [::1]:8080 keeps its brackets.
  [
    /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})(?![\w:])/gi,
    '<ip>',
  ],
  [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
  // No \b: digit-to-letter is not a word boundary, and "250ms" must become "<n>ms".
  // Dotted runs (1.2.3, 3.14) collapse to a single <n>.
  [/\d+(\.\d+)*/g, '<n>'],
];

export function mask(line: string): string {
  let out = line;
  for (const [re, token] of RULES) out = out.replace(re, token);
  return out;
}
