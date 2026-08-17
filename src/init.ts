import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// PreToolUse(Bash) guard: rewrites raw `kubectl logs` / `docker logs` /
// `journalctl` into `… | squirt` instead of blocking — a block is a wasted
// round-trip. Only blocks when a rewrite would be unsafe (-f/--follow,
// already piped/redirected elsewhere), and logs rewrites + blocks to guard.log for
// `squirt guard-stats`. Built as an array (not a template literal) because
// the script itself contains backtick and `${...}` sequences that would
// collide with JS template syntax.
const GUARD_SCRIPT_LINES = [
  '#!/usr/bin/env bash',
  '# PreToolUse(Bash): raw log dumps must go through squirt.',
  '# Rewrites `kubectl logs` / `docker logs` / `journalctl` to `… | squirt` when the output is not',
  '# already narrowed (grep/head/tail/jq/wc/awk, small --tail, file redirect). Blocks only when a',
  '# rewrite is unsafe (-f/--follow streams). Rewrite > block: a block is a wasted round-trip.',
  'INPUT=$(cat)',
  'CMD=$(printf \'%s\' "$INPUT" | jq -r \'.tool_input.command // empty\')',
  '[ -z "$CMD" ] && exit 0',
  'echo "$CMD" | grep -qE \'(kubectl([[:space:]]+-[^|;]*)?[[:space:]]+logs|docker([[:space:]]+compose)?([[:space:]]+-[^|;]*)?[[:space:]]+logs|journalctl)\' || exit 0',
  'echo "$CMD" | grep -qE \'\\bsquirt\\b\' && exit 0',
  'echo "$CMD" | grep -qE -- \'--tail[= ][0-9]{1,2}\\b|-n[= ]?[0-9]{1,2}\\b\' && exit 0',
  'echo "$CMD" | grep -qE \'\\|[[:space:]]*(grep|rg|head|tail|wc|awk|jq|sed -n|cut|sort|uniq)\\b\' && exit 0',
  'echo "$CMD" | grep -qE \'>[[:space:]]*[^&]\' && exit 0   # redirected to a file, not into context',
  'if echo "$CMD" | grep -qE \'(^|[[:space:]])(-f|--follow)([[:space:]]|$)|;|&&|\\|\\|\'; then',
  '  mkdir -p "${SQUIRT_HOME:-$HOME/.squirt}"',
  '  echo "$(date -u +%FT%TZ) block $CMD" >> "${SQUIRT_HOME:-$HOME/.squirt}/guard.log"',
  '  echo "raw log dump blocked — pipe through squirt (e.g. \\`… | squirt --level warn\\`, or \\`squirt k8s -n <ns> deploy/<x> --since 1h\\`); narrow with --grep/--sample. No -f/--follow into context. Small --tail N / grep / head / file redirect are fine." >&2',
  '  exit 2',
  'fi',
  'NEW="$CMD | squirt"',
  'mkdir -p "${SQUIRT_HOME:-$HOME/.squirt}"',
  'echo "$(date -u +%FT%TZ) rewrite $CMD" >> "${SQUIRT_HOME:-$HOME/.squirt}/guard.log"',
  'printf \'%s\' "$INPUT" | jq -c --arg cmd "$NEW" \'{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:(.tool_input + {command:$cmd})}}\'',
  'exit 0',
];

export const GUARD_SCRIPT = `${GUARD_SCRIPT_LINES.join('\n')}\n`;

const DEFAULT_COMMAND = '~/.claude/hooks/squirt-guard.sh';

/** Merge the PreToolUse(Bash) guard hook into a .claude/settings.json body. Idempotent. */
export function mergeGuardHook(
  settingsText: string | undefined,
  command: string = DEFAULT_COMMAND,
): { text: string; changed: boolean } {
  const settings = settingsText?.trim() ? (JSON.parse(settingsText) as Record<string, unknown>) : {};
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const pre = (hooks.PreToolUse ??= []) as Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>;
  const present = pre.some((g) => g.hooks?.some((h) => typeof h.command === 'string' && /squirt-guard/.test(h.command)));
  if (present) return { text: `${JSON.stringify(settings, null, 2)}\n`, changed: false };

  let group = pre.find((g) => g.matcher === 'Bash');
  if (!group) {
    group = { matcher: 'Bash', hooks: [] };
    pre.push(group);
  }
  (group.hooks ??= []).push({ type: 'command', command, timeout: 5 });
  return { text: `${JSON.stringify(settings, null, 2)}\n`, changed: true };
}

export interface InitOpts {
  root: string;
  global?: boolean;
  print?: boolean;
}

/** `squirt init --claude [--global] [--print]` — install/print the guard hook + script. */
export function cmdInit(opts: InitOpts): number {
  const base = opts.global ? join(homedir(), '.claude') : join(opts.root, '.claude');
  const scriptPath = join(base, 'hooks', 'squirt-guard.sh');
  const settingsPath = join(base, 'settings.json');
  const command = opts.global ? DEFAULT_COMMAND : scriptPath;

  const prevSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;
  let merged: { text: string; changed: boolean };
  try {
    merged = mergeGuardHook(prevSettings, command);
  } catch {
    console.error(`squirt: ${settingsPath} is not valid JSON — guard not installed`);
    return 1;
  }

  if (opts.print) {
    console.log(GUARD_SCRIPT);
    console.log(merged.text);
    return 0;
  }

  mkdirSync(join(base, 'hooks'), { recursive: true });
  writeFileSync(scriptPath, GUARD_SCRIPT);
  chmodSync(scriptPath, 0o755);
  if (merged.changed) {
    writeFileSync(settingsPath, merged.text);
    console.log(`squirt: installed guard hook → ${scriptPath}, wired into ${settingsPath}`);
  } else {
    console.log(`squirt: guard hook already wired in ${settingsPath}`);
  }
  return 0;
}
