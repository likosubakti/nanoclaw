import { randomInt } from 'node:crypto';

/**
 * The lifetime of a pairing code.
 *
 * Six digits is 900,000 possibilities and the bot answers every guess, so the
 * code is its own oracle. That is only safe because a code dies quickly: on
 * first use, on expiry, or after a handful of wrong guesses. A code that merely
 * rotated per launch would be a static shared secret for the machine's uptime,
 * and what one unlocks is total — every discussion, every transcript, and
 * unmetered spending on the owner's plans.
 *
 * Kept separate from the bridge so this can be tested without Electron.
 */

/** Long enough to walk to the phone, short enough that a screenshot rots. */
export const PAIRING_TTL_MS = 10 * 60_000;
export const MAX_PAIR_ATTEMPTS = 5;

export class PairingCode {
  private code = '';
  private expiresAt = 0;
  private attempts = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Issues a fresh code and invalidates whatever came before it. */
  issue(): string {
    this.code = String(randomInt(100_000, 999_999));
    this.expiresAt = this.now() + PAIRING_TTL_MS;
    this.attempts = 0;
    return this.code;
  }

  /** The code to show the owner, or '' when none is live. */
  live(): string {
    return this.code && this.now() < this.expiresAt ? this.code : '';
  }

  /** Invalidates the current code: after use, on unpair, on shutdown. */
  revoke(): void {
    this.code = '';
    this.expiresAt = 0;
    this.attempts = 0;
  }

  /**
   * Checks a guess. A correct one consumes the code; enough wrong ones burn it,
   * because the attacker's patience is not the resource worth exhausting.
   */
  check(guess: string): boolean {
    const live = this.live();
    if (!live) return false;
    if (guess === live) {
      this.revoke();
      return true;
    }
    if (++this.attempts >= MAX_PAIR_ATTEMPTS) this.revoke();
    return false;
  }
}
