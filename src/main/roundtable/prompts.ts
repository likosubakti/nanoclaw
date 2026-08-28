import type { Room, RoundMode, Seat } from '@shared/roundtable';
import { pickFraming } from '@shared/roundtable';
import { seatCanResearch } from '@shared/roundtable';

/**
 * Prompt construction for the roundtable.
 *
 * Two things matter here. First, every seat must know it is one voice among
 * several and who the others are, or it writes a standalone essay instead of a
 * contribution. Second, the transcript is labelled by speaker so seats can
 * address each other by name — without that they talk past one another.
 */

/** Standing instructions for a seat, independent of the round. */
export function seatSystemPrompt(room: Room, seat: Seat): string {
  const others = room.seats
    .filter((s) => s.enabled && s.id !== seat.id)
    .map((s) => s.name)
    .join(', ');

  const lines = [
    `You are "${seat.name}", one participant in a live roundtable discussion.`,
    others ? `The other participants are: ${others}.` : '',
    `The discussion was convened by the owner, who moderates it.`,
    '',
    `Topic under discussion: ${room.topic}`,
    '',
    'How to take part:',
    '- Be substantive and concise. Other participants and a human are reading every word.',
    '- Address others by name when you build on or disagree with them.',
    '- Say plainly when you disagree, and say why. Agreement that is not earned is worthless here.',
    '- Do not repeat a point someone has already made; add to it or challenge it.',
    '- Do not summarise the whole discussion unless you are explicitly asked to.',
    '- Never role-play as another participant or invent what they said.',
  ];

  if (seatCanResearch(seat)) {
    lines.push(
      '- You have tools. Use them when a claim needs checking, and cite what you found.',
    );
  } else {
    lines.push(
      '- You have no tools in this seat, so do not claim to have looked anything up. Reason from what you know and say when you are uncertain.',
    );
  }

  if (seat.role?.trim()) {
    lines.push('', `Your assigned perspective: ${seat.role.trim()}`);
  }

  return lines.filter(Boolean).join('\n');
}

/** The instruction for this round, given its mode. */
export function roundInstruction(mode: RoundMode, ownerMessage: string, seat: Seat): string {
  const owner = ownerMessage.trim();

  switch (mode) {
    case 'parallel':
      return [
        'The owner has put this to the room:',
        '',
        owner,
        '',
        'Give your own answer. Other participants are answering at the same time and you cannot see them yet, so do not speculate about what they will say.',
      ].join('\n');

    case 'sequential':
      return [
        'The owner has put this to the room:',
        '',
        owner,
        '',
        'Participants are speaking in turn. Anything said above is what earlier speakers contributed this round — build on it, or push back on it, rather than starting over.',
      ].join('\n');

    case 'critique':
      return [
        owner ? `The owner adds: ${owner}\n` : '',
        'Now cross-examine the other participants. For each position you disagree with, name the participant and say precisely where you think they are wrong and why. Where you have changed your own mind, say so and say what changed it.',
      ]
        .filter(Boolean)
        .join('\n');

    case 'synthesis':
      return [
        owner ? `The owner adds: ${owner}\n` : '',
        `You are ${seat.name}, asked to close the discussion. Write the conclusion the room has reached.`,
        '',
        'Cover, in this order:',
        '1. What everyone agreed on.',
        '2. What remains genuinely contested, and who holds which position.',
        '3. The recommendation you draw from the discussion.',
        '',
        'Attribute positions to the participants who made them. Do not introduce arguments nobody raised.',
      ]
        .filter(Boolean)
        .join('\n');

    case 'direct':
      return ['The owner asks you directly:', '', owner].join('\n');
  }
}

/**
 * The consensus check.
 *
 * Kept deliberately small and mechanical: a strict prefix so the reply parses
 * without a second model call, and a hard cap on the explanation so this costs
 * a fraction of a real turn even though it runs after every round.
 */
export function votePrompt(room: Room): string {
  return [
    'The round has ended. Answer only this, as the participant you are:',
    '',
    `Has this room reached a conclusion you can support on: ${room.topic}?`,
    '',
    'Reply with exactly one line, in this form and nothing else:',
    'AGREE: <one sentence on what you are agreeing to>',
    'or',
    'DISAGREE: <one sentence on what still needs settling>',
  ].join('\n');
}

/**
 * Renders the discussion so far as a labelled transcript.
 *
 * The owner chose full context with no cap, so nothing is truncated or
 * summarised — every seat sees the entire discussion on every turn.
 */
export function renderTranscript(room: Room, upToRound: number, excludeTurnId?: string): string {
  const seatName = (id: string) => room.seats.find((s) => s.id === id)?.name ?? id;
  const lines: string[] = [];

  for (const round of room.rounds) {
    if (round.index > upToRound) break;

    const spoken = round.turns.filter(
      (t) => t.id !== excludeTurnId && t.status === 'done' && t.content.trim(),
    );
    if (spoken.length === 0 && !round.prompt.trim()) continue;

    lines.push(`### Round ${round.index + 1} — ${round.mode}`);
    if (round.prompt.trim()) lines.push(`Owner: ${round.prompt.trim()}`);
    lines.push('');

    for (const turn of spoken) {
      lines.push(`**${seatName(turn.seatId)}:**`, turn.content.trim(), '');
    }

    if (round.votes.length) {
      const tally = round.votes
        .map((v) => `${seatName(v.seatId)}: ${v.agree ? 'agree' : 'disagree'} — ${v.note}`)
        .join('; ');
      lines.push(`_Positions at end of round: ${tally}_`, '');
    }
  }

  return lines.join('\n').trim();
}

/* -------------------------------------------------------------- moderator -- */

/**
 * The moderator's standing instructions.
 *
 * It is explicitly not a participant. Left unconstrained, a model asked to
 * moderate starts answering the question itself, which both biases the room and
 * wastes the seat.
 */
export function moderatorSystemPrompt(room: Room): string {
  const roster = room.seats
    .filter((s) => s.enabled)
    .map((s) => `- ${s.name}${s.role?.trim() ? ` — role: ${s.role.trim()}` : ' — no assigned role'}`)
    .join('\n');

  const role = room.moderator.role?.trim();

  return [
    `You are the moderator of a roundtable discussion. You are not a participant: you never answer the question yourself.`,
    '',
    role
      ? `You hold a position of your own: ${role}\nYou chair the room from that perspective, and when you rule, you rule as that person — the decision is yours to make, informed by the room but not merely a tally of it.`
      : 'You are a neutral chair. Your ruling reports whether the room has genuinely settled its disagreements, not what you would decide.',
    '',
    `Topic: ${room.topic}`,
    '',
    'The room:',
    roster,
    '',
    'Your responsibilities:',
    '- Turn the owner’s rough, half-formed input into a precise brief the room can act on.',
    '- Write each participant a different instruction, aimed squarely at their specialism, so they attack the problem from genuinely different angles instead of converging on one answer. A brief that would read the same to a cryptographer and a product lead is a failed brief.',
    '- Judge, at the end of each round, whether the discussion is finished.',
    '',
    'Be terse. Your output is scaffolding, not content.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Asks the moderator to turn the owner's rough input into a brief.
 *
 * Returns the framing it was given alongside the prompt so the caller can
 * record it: the anti-repetition rule only works if the room remembers which
 * lenses it has already looked through.
 */
export function briefPrompt(
  room: Room,
  ownerMessage: string,
  mode: RoundMode,
): { prompt: string; framing: string } {
  const seats = room.seats.filter((s) => s.enabled);
  const previousFocus = [...room.rounds].reverse().find((r) => r.verdict?.focus)?.verdict?.focus;

  const usedFramings = room.rounds
    .map((r) => r.brief?.framing)
    .filter((f): f is string => Boolean(f));
  const framing = pickFraming(usedFramings);

  const previousAgendas = room.rounds
    .map((r) => r.brief?.agenda)
    .filter((a): a is string => Boolean(a))
    .slice(-3);

  const creativity = room.moderator.creativity ?? 0.7;

  const prompt = [
    ownerMessage.trim()
      ? `The owner says, in their own words:\n\n"""\n${ownerMessage.trim()}\n"""`
      : 'The owner did not add anything this round; carry the discussion forward yourself.',
    '',
    previousFocus ? `You previously ruled that the room should focus on: ${previousFocus}\n` : '',
    `This round is run as "${mode}".`,
    '',
    'Research the topic first if a fact would sharpen the brief, then write it.',
    '',
    previousAgendas.length
      ? `You have already framed this discussion these ways — do not simply restate them:\n${previousAgendas
          .map((a, i) => `${i + 1}. ${a}`)
          .join('\n')}\n`
      : '',
    creativity >= 0.4
      ? `Suggested lens for this round: ${framing}\nUse it if it genuinely sharpens the question; discard it if it does not. Either way, find an angle this room has not already worked.`
      : `Keep the framing plain and direct.`,
    '',
    'Reply in exactly this format and nothing else:',
    '',
    'AGENDA:',
    '<the precise question the room should address this round, in one short paragraph>',
    '',
    ...seats.map((s) => `FOR ${s.name}:\n<one or two sentences telling ${s.name} what to contribute, aimed at their role>\n`),
    'NOTES:',
    '<anything the room should know, such as a fact you checked; write "none" if there is nothing>',
  ]
    .filter(Boolean)
    .join('\n');

  return { prompt, framing };
}

/** Asks the moderator to rule on whether the discussion is finished. */
export function verdictPrompt(room: Room): string {
  const role = room.moderator.role?.trim();

  return [
    'The round has ended. Read the discussion above and rule on it.',
    '',
    role
      ? `Rule as ${role}. You are not counting votes: you are deciding whether you have what you need to make the call, and the call is yours. Conclude when the room has given you enough to decide, even if the participants themselves still disagree — but say plainly which way you are deciding and why.`
      : 'Conclude only when the substantive disagreements are actually settled — not merely when everyone has spoken, and not merely because the participants are being polite to each other. If a real disagreement remains, the room continues.',
    '',
    'Check a fact first if the ruling turns on one.',
    '',
    'Reply in exactly this format and nothing else:',
    '',
    'VERDICT: CONCLUDE',
    'or',
    'VERDICT: CONTINUE',
    '',
    'REASON:',
    '<one or two sentences>',
    '',
    'FOCUS:',
    '<if continuing, the single thing the next round must settle; write "none" if concluding>',
  ].join('\n');
}

/**
 * Parses the moderator's brief.
 *
 * Tolerant by design: a malformed brief must degrade to "everyone gets the same
 * instruction" rather than abort the round. The moderator is scaffolding, and
 * scaffolding failing should never take the discussion down with it.
 */
export function parseBrief(
  room: Room,
  raw: string,
): { agenda: string; perSeat: Record<string, string>; notes?: string } {
  const text = raw.trim();
  const perSeat: Record<string, string> = {};

  const agendaMatch = /AGENDA:\s*([\s\S]*?)(?=\n\s*(?:FOR\s+|NOTES:)|$)/i.exec(text);
  const notesMatch = /NOTES:\s*([\s\S]*)$/i.exec(text);

  for (const seat of room.seats.filter((s) => s.enabled)) {
    // Seat names can contain regex metacharacters, so escape before matching.
    const escaped = seat.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `FOR\\s+${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:FOR\\s+|NOTES:)|$)`,
      'i',
    );
    const match = pattern.exec(text);
    if (match?.[1]?.trim()) perSeat[seat.id] = match[1].trim();
  }

  const notes = notesMatch?.[1]?.trim();
  return {
    // If the format was ignored entirely, the whole reply is still a usable brief.
    agenda: agendaMatch?.[1]?.trim() || text,
    perSeat,
    notes: notes && !/^none\.?$/i.test(notes) ? notes : undefined,
  };
}

/** Parses the moderator's ruling. Anything unparseable means "keep going". */
export function parseVerdict(raw: string): { conclude: boolean; reason: string; focus?: string } {
  const text = raw.trim();
  const verdict = /VERDICT:\s*(CONCLUDE|CONTINUE)/i.exec(text);
  const reason = /REASON:\s*([\s\S]*?)(?=\n\s*FOCUS:|$)/i.exec(text);
  const focus = /FOCUS:\s*([\s\S]*)$/i.exec(text);

  const focusText = focus?.[1]?.trim();
  return {
    // Defaulting to CONTINUE is the safe failure: it keeps the room open rather
    // than declaring a conclusion the moderator never actually reached.
    conclude: verdict?.[1]?.toUpperCase() === 'CONCLUDE',
    reason: reason?.[1]?.trim() || text.split('\n')[0] || 'No reason given.',
    focus: focusText && !/^none\.?$/i.test(focusText) ? focusText : undefined,
  };
}

/** The per-seat instruction, preferring the moderator's tailored one. */
export function instructionForSeat(
  mode: RoundMode,
  round: { prompt: string; brief?: { agenda: string; perSeat: Record<string, string>; notes?: string } },
  seat: Seat,
): string {
  if (!round.brief) return roundInstruction(mode, round.prompt, seat);

  const parts = [`The moderator has set this agenda:`, '', round.brief.agenda];
  if (round.brief.notes) parts.push('', `Moderator's note: ${round.brief.notes}`);

  const mine = round.brief.perSeat[seat.id];
  if (mine) parts.push('', `Your brief, as ${seat.role?.trim() || seat.name}:`, mine);

  // The mode still governs how the seat should behave within the brief.
  parts.push('', modeReminder(mode));
  return parts.join('\n');
}

function modeReminder(mode: RoundMode): string {
  switch (mode) {
    case 'parallel':
      return 'The other participants are answering at the same time and you cannot see them yet, so do not speculate about what they will say.';
    case 'sequential':
      return 'Anything above is what earlier speakers contributed this round — build on it or push back on it rather than starting over.';
    case 'critique':
      return 'Cross-examine the others by name. Say precisely where you think each is wrong, and say where you have changed your own mind.';
    case 'synthesis':
      return 'Write the conclusion the room reached: what was agreed, what is still contested and who holds which position, and the recommendation that follows.';
    case 'direct':
      return 'Answer the owner directly and briefly.';
  }
}
