import type { Room, RoundMode, Seat } from '@shared/roundtable';

/**
 * The two decisions inside a round that are easy to get subtly wrong, kept pure
 * so they can be tested without spawning a provider.
 */

/**
 * Who speaks in this round.
 *
 * The synthesis pin is a *preference*, not a filter. Nothing in the UI names
 * the pinned seat and nothing repairs the pin when that seat is disabled, so
 * filtering on it made "Wrap up" fail with "No seats are enabled for this
 * round" while the rest of the room sat there enabled — with no way for the
 * user to discover the cause.
 */
export function pickParticipants(
  room: Room,
  mode: RoundMode,
  seatIds: string[] | undefined,
): Seat[] {
  const enabled = room.seats.filter((s) => s.enabled);
  const requested = seatIds?.length ? enabled.filter((s) => seatIds.includes(s.id)) : enabled;

  if (mode !== 'synthesis') return requested;
  const synthesist = requested.find((s) => s.id === room.synthesisSeatId) ?? requested[0];
  return synthesist ? [synthesist] : [];
}

/**
 * Folds what a round owns onto the room as it is on disk now.
 *
 * The round holds the Room it read when it started, and that copy goes stale
 * the moment anything else writes — `room:close` and `room:update` each work on
 * their own fresh copy. Saving the round's copy whole erased them: most
 * damagingly the `closed` status, which is the only thing stopping a paired
 * phone from restarting a discussion the owner ended.
 */
export function foldRound(stored: Room, round: Room): Room {
  return {
    ...stored,
    // The transcript belongs to the round; nothing else may write it.
    rounds: round.rounds,
    conclusion: round.conclusion ?? stored.conclusion,
    // Closing wins over whatever the round thinks the status is.
    status: stored.status === 'closed' ? 'closed' : round.status,
  };
}
