/**
 * What the commands agents start say about themselves: the declaration an agent adds to a named
 * service or a background job (a trailing shell comment, `# purpose: … ; lifetime: …`, in its own
 * words), how long that lifetime is, the ports a command names, and the secret-looking values a
 * command line must not show.
 *
 * The gate omp loads (process-gate.js) refuses a long-running command without a declaration; the
 * ledger (processes.js) keeps it and reads its lifetime to tell when the process is left over.
 * On the owner's word, nothing an agent reads about declaring gives examples, units or limits, so
 * as not to steer what it declares: any lifetime is accepted, and words this module cannot read as
 * a length of time mean "while its conversation is awake".
 *
 * omp loads the gate, and with it this module, into its own process: it imports nothing.
 */

/** How an agent is told to declare, wherever it is told (the gate's refusal, the processes tool). */
export const DECLARATION_FORMAT = '# purpose: <what it is for> ; lifetime: <how long it should keep running>';

/** A declaration: a comment from `#` to the end of its line, both parts saying something. */
const DECLARATION = /#\s*purpose:\s*([^\n]*?)\s*;\s*lifetime:\s*([^\n]*?)\s*$/im;

/** @typedef {{ purpose: string, lifetime: string }} Declaration */

/**
 * The declaration at the end of a line of `command`, or null if there is none.
 * @param {string} command
 * @returns {Declaration | null}
 */
export function declarationOf(command) {
  const match = DECLARATION.exec(command);
  return match && match[1] && match[2] ? { purpose: match[1], lifetime: match[2] } : null;
}

/** `command` without its declaration. @param {string} command */
export const withoutDeclaration = (command) => command.replace(DECLARATION, '').trimEnd();

/**
 * How long a process may run, as its agent declared it: for good (`forever`), for a length of time
 * from when it was declared (`for`), or while the conversation that declared it is awake.
 * @typedef {{ kind: 'forever' } | { kind: 'for', ms: number } | { kind: 'conversation' }} Lifetime
 */

const FOREVER = /\b(?:forever|indefinitely|indefinite|permanently|permanent|no (?:end|limit)|until (?:it is |it's )?(?:stopped|killed))\b/i;
/** @type {Readonly<Record<string, number>>} */
const UNIT_MS = { mo: 30 * 86_400_000, w: 7 * 86_400_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const SPAN = /(\d+(?:\.\d+)?|\ban?\b|\bone\b)\s*(?:(?:more|extra|additional|further|full|whole)\s+)?(months?|mo|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;

/** The unit a span names (`hours` → `h`). @param {string} unit */
const unitOf = (unit) => {
  const u = unit.toLowerCase();
  return u.startsWith('mo') ? 'mo' : u.startsWith('mi') || u === 'm' ? 'm' : u[0];
};

/**
 * What a declared lifetime says: for good, a length of time (the sum of the spans it names:
 * `2h`, `90 minutes`, `an hour and a half`… reads as the hour), else while its conversation is awake.
 * @param {string} text
 * @returns {Lifetime}
 */
export function lifetimeOf(text) {
  if (FOREVER.test(text)) return { kind: 'forever' };
  let ms = 0;
  for (const [, count, unit] of text.matchAll(SPAN)) ms += (/^\d/.test(count) ? Number(count) : 1) * UNIT_MS[unitOf(unit)];
  return ms > 0 ? { kind: 'for', ms } : { kind: 'conversation' };
}

const PORT = /(?:(?:^|\s)--?p(?:ort)?(?:=|\s+)|\bPORT=|:)(\d{2,5})\b/g;

/**
 * The ports `command` names: `-p 8081`, `--port 8081`, `--port=8081`, `PORT=8081`, `:8081`.
 * @param {string} command
 */
export function portsIn(command) {
  const ports = new Set();
  for (const [, digits] of command.matchAll(PORT)) {
    const port = Number(digits);
    if (port >= 1 && port <= 65_535) ports.add(port);
  }
  return [...ports];
}

const SECRET_WORD = '[\\w.-]*(?:token|key|secret|passw(?:or)?d|pwd|auth|credential|cookie)[\\w.-]*';
/** A shell word: quoted whole, else up to the next space. */
const VALUE = '(?:"[^"]*"|\'[^\']*\'|\\S+)';
const SECRET_FLAG = new RegExp(`(--?${SECRET_WORD})(=|\\s+)(?!-)${VALUE}`, 'gi');
const SECRET_ASSIGNMENT = new RegExp(`\\b(${SECRET_WORD})=${VALUE}`, 'gi');
const URL_PASSWORD = /(\/\/[^\s:@/]+):[^\s@/]+@/g;
/** `curl -u user:pass`, `--user=user:pass`. */
const USER_PASSWORD = /((?:^|\s)(?:-u|--user)(?:=|\s*)["']?[^\s:"'@]+):[^\s"']+/g;
/** An `Authorization:` header's credentials, and a bearer token anywhere. */
const AUTHORIZATION = /\b((?:proxy-)?authorization\s*:\s*(?:(?:bearer|basic|token|digest)\s+)?)[^\s"']+/gi;
const BEARER = /\b(bearer\s+)[^\s"']+/gi;
/** Short flags that take a password, by program: `mysql -pPASS` (only attached: apart, it asks), `redis-cli -a PASS`, `sshpass -p PASS`. */
const PASSWORD_FLAGS = [
  { program: /\b(?:mysql\w*|mariadb\w*)\b/, flag: /(\s-p)[^\s-]\S*/g },
  { program: /\bredis-cli\b/, flag: /(\s-a\s+)\S+/g },
  { program: /\bsshpass\b/, flag: /(\s-p\s*)\S+/g },
];
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;

/**
 * `command` with secret-looking values masked (`…`): those of flags and variables named like a
 * token, key, secret or password, a URL's or `-u`'s password, an authorization header, the
 * password flags of `mysql`, `redis-cli` and `sshpass`, and long strings of letters and digits.
 * @param {string} command
 */
export function masked(command) {
  let out = command
    .replace(SECRET_FLAG, '$1$2…')
    .replace(SECRET_ASSIGNMENT, '$1=…')
    .replace(URL_PASSWORD, '$1:…@')
    .replace(USER_PASSWORD, '$1:…')
    .replace(AUTHORIZATION, '$1…')
    .replace(BEARER, '$1…');
  for (const { program, flag } of PASSWORD_FLAGS) if (program.test(out)) out = out.replace(flag, '$1…');
  return out.replace(LONG_TOKEN, (token) => (/\d/.test(token) && /[A-Za-z]/.test(token) ? '…' : token));
}

/** One command with its spacing evened out, for comparing two. @param {string} command */
const normalized = (command) => command.trim().replace(/\s+/g, ' ');

/**
 * The running processes in `records` that a new `command` (its declaration taken off) would
 * duplicate: the same command, or one of the ports it names.
 * @template {{ command: string, ports: readonly number[], endedAt: number | null }} R
 * @param {readonly R[]} records
 * @param {string} command
 * @returns {R[]}
 */
export function duplicatesOf(records, command) {
  const same = normalized(masked(command));
  const ports = portsIn(command);
  return records.filter(
    (r) => r.endedAt === null && (normalized(r.command) === same || r.ports.some((p) => ports.includes(p)) || portsIn(r.command).some((p) => ports.includes(p))),
  );
}
