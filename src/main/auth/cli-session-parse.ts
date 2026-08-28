/**
 * Parsers for what the vendor CLIs report about their own sign-in state.
 *
 * These are separated from the probe itself so they can be tested without
 * pulling in Electron, and because their tolerance is the whole point: both
 * CLIs have changed this output between releases, and a parser that insists on
 * one shape would report "not signed in" for a user who plainly is.
 */

export interface SessionProbe {
  /** True only for a real subscription session — not an API key the CLI found. */
  loggedIn: boolean;
  accountHint?: string;
}

/** Matches an email without capturing anything else that looks like one. */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/**
 * `claude auth status` emits JSON by default:
 *   {"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty",…}
 *
 * `authMethod` is what makes this worth doing: the file on disk cannot
 * distinguish a Pro/Max session from an ANTHROPIC_API_KEY the CLI picked up,
 * and calling the second one "signed in with Claude" would be a lie that
 * changes which transport the app recommends.
 */
export function parseClaudeAuthStatus(stdout: string): SessionProbe | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return textFallback(stdout);

  let json: any;
  try {
    json = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return textFallback(stdout);
  }
  if (typeof json?.loggedIn !== 'boolean') return textFallback(stdout);

  const method = String(json.authMethod ?? '');
  // An unrecognised method is treated as a session: new names appear (sso,
  // oauth_token…), and refusing to believe one would silently downgrade a
  // working subscription to "please sign in".
  const viaKey = /api[_-]?key/i.test(method);
  const loggedIn = json.loggedIn && !viaKey;

  const email =
    typeof json.email === 'string'
      ? json.email
      : typeof json.account?.emailAddress === 'string'
        ? json.account.emailAddress
        : undefined;
  const org =
    typeof json.organizationName === 'string'
      ? json.organizationName
      : typeof json.account?.organizationName === 'string'
        ? json.account.organizationName
        : undefined;

  if (!loggedIn) return { loggedIn: false };
  const parts = [email ?? 'signed in', org].filter(Boolean);
  return { loggedIn: true, accountHint: parts.join(' · ') };
}

/** Older builds print prose instead of JSON. */
function textFallback(stdout: string): SessionProbe | null {
  const text = stdout.trim();
  if (!text) return null;
  if (/not\s+(logged|signed)\s*-?\s*in|no\s+(active\s+)?(session|credentials)/i.test(text)) {
    return { loggedIn: false };
  }
  if (/logged\s*in|signed\s*in|authenticated/i.test(text)) {
    return { loggedIn: true, accountHint: EMAIL.exec(text)?.[0] };
  }
  return null;
}

/**
 * `codex login status` has only ever printed prose, and the wording has moved
 * around ("Logged in using ChatGPT", "Logged in using an API key"). Exit status
 * is the reliable signal; the text refines it.
 */
export function parseCodexLoginStatus(stdout: string, exitCode: number): SessionProbe | null {
  const text = stdout.trim();
  if (exitCode !== 0) {
    // A non-zero exit from an unknown subcommand is not the same as being
    // logged out, and guessing wrong strands a signed-in user.
    return /unknown|unrecognized|usage:|--help/i.test(text) ? null : { loggedIn: false };
  }
  if (!text) return null;
  if (/not\s+(logged|signed)\s*-?\s*in/i.test(text)) return { loggedIn: false };
  // An API key is not a ChatGPT subscription, and the CLI says which it used.
  if (/api\s*key/i.test(text)) return { loggedIn: false };
  if (!/logged\s*in|signed\s*in|authenticated/i.test(text)) return null;
  return { loggedIn: true, accountHint: EMAIL.exec(text)?.[0] ?? 'signed in with ChatGPT' };
}
