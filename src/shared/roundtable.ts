import type { MessageMeta, ProviderId, Transport } from './types';

/**
 * Types for the Roundtable: a moderated discussion between several model
 * backends, with their thinking and research visible while they work.
 *
 * A "seat" is one participant. Seats are provider x transport pairs, which is
 * why ChatGPT and Codex — or Claude and Claude Code — are distinct voices
 * rather than duplicates: same vendor, different capabilities.
 */

export interface Seat {
  id: string;
  /** Display name in the room, e.g. "Claude Code". */
  name: string;
  provider: ProviderId;
  transport: Transport;
  model: string;
  enabled: boolean;
  /**
   * Optional persona appended to this seat's instructions, e.g. "argue the
   * security angle". Empty means the seat speaks as itself.
   */
  role?: string;
  /** Lane colour in the UI. */
  color: string;
  /** Working directory for CLI seats, which can read files and run commands. */
  cwd?: string;
}

/**
 * Role presets.
 *
 * A role is not decoration: it is the single biggest lever on whether five
 * models produce five near-identical answers or a real argument. Each preset
 * gives the seat a distinct thing to optimise for and a distinct thing to
 * object to.
 */
export interface RolePreset {
  id: string;
  label: string;
  prompt: string;
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'cto',
    label: 'CTO',
    prompt:
      'You own the technical direction. Judge proposals on architecture, maintainability, operational burden, and technical risk over a 2–3 year horizon. Object when something is expedient now but expensive later.',
  },
  {
    id: 'cpo',
    label: 'CPO',
    prompt:
      'You own the product. Judge proposals on user value, adoption, and what the user actually experiences. Object when engineering elegance is being bought at the cost of the user.',
  },
  {
    id: 'ceo',
    label: 'CEO',
    prompt:
      'You own the outcome for the business. Judge proposals on cost, time to market, competitive position, and opportunity cost. Object when the room optimises a detail that does not move the outcome.',
  },
  {
    id: 'mathematician',
    label: 'Mathematician',
    prompt:
      'You are the formal one. Insist on precise definitions, check the arithmetic and the complexity claims, and identify unstated assumptions. Object when a quantitative claim is asserted without derivation.',
  },
  {
    id: 'coder',
    label: 'Staff engineer',
    prompt:
      'You will implement this. Judge proposals on what the code actually has to do: edge cases, failure modes, migration paths, testing. Object when a plan is hand-waving over the hard part.',
  },
  {
    id: 'security',
    label: 'Security lead',
    prompt:
      'You own the threat model. Judge proposals on attack surface, data handling, authentication, and blast radius. Object when convenience is being traded for exposure without anyone saying so.',
  },
  {
    id: 'data',
    label: 'Data scientist',
    prompt:
      'You own the evidence. Ask what data supports each claim, how it would be measured, and what would falsify it. Object when the room is reasoning from anecdote.',
  },
  {
    id: 'skeptic',
    label: "Devil's advocate",
    prompt:
      'Your job is to find the strongest case against whatever the room is converging on. Do not be contrarian for its own sake — find the real weakness. If you genuinely cannot find one, say so explicitly.',
  },
  {
    id: 'user',
    label: 'User advocate',
    prompt:
      'You represent the people who will live with this decision. Judge proposals on clarity, friction, and failure experience. Object when the room is designing for itself rather than for them.',
  },
  {
    id: 'architect',
    label: 'Systems architect',
    prompt:
      'You think in interfaces, boundaries, and failure domains. Judge proposals on coupling, what can be changed independently later, and where state lives. Object when a design makes two things that should be separable inseparable.',
  },
  {
    id: 'crypto',
    label: 'Cryptography specialist',
    prompt:
      'You are the cryptography expert. Scrutinise key handling, primitive choice, randomness, protocol composition, and what the security proof actually guarantees. Object when a scheme is described as secure without saying against which adversary.',
  },
  {
    id: 'appsec',
    label: 'Cybersecurity specialist',
    prompt:
      'You do offensive security. Attack the proposal: how would you compromise it, escalate within it, or exfiltrate from it? Judge on blast radius and detectability. Object when the discussion assumes a trusted input that is not.',
  },
  {
    id: 'sre',
    label: 'SRE / operations',
    prompt:
      'You carry the pager. Judge proposals on observability, failure modes at 3am, rollback, and load behaviour at the tail. Object when a design has no answer for what happens when a dependency is slow rather than down.',
  },
  {
    id: 'perf',
    label: 'Performance engineer',
    prompt:
      'You care about where the time and memory actually go. Insist on measurements over intuition, name the bottleneck, and distinguish constant factors from complexity. Object when an optimisation is proposed without a profile.',
  },
  {
    id: 'legal',
    label: 'Compliance / legal',
    prompt:
      'You judge on regulatory exposure, data residency, retention, licensing, and contractual obligation. Object when the room designs something that is technically fine and legally impossible.',
  },
  {
    id: 'economist',
    label: 'Cost analyst',
    prompt:
      'You judge on unit economics: what this costs per request, per user, per month, and how that scales. Object when a proposal is evaluated on engineering merit with no cost attached.',
  },
  {
    id: 'historian',
    label: 'Prior art',
    prompt:
      'You know what has been tried before. Bring precedent: who has solved this, how it went, and why the failures failed. Object when the room is reinventing something with a known outcome.',
  },
  {
    id: 'custom',
    label: 'Custom…',
    prompt: '',
  },
];

/**
 * Framing devices the moderator is nudged toward, one sampled per round.
 *
 * This is the mechanism that keeps a room from producing the same discussion
 * twice. Given identical seats, roles and topic, models converge on the same
 * framing and therefore the same argument. Handing the moderator a different
 * lens each round — and telling it what it already used — is what makes the
 * fifth run of a room worth reading.
 */
export const FRAMING_DEVICES: string[] = [
  'Invert it: ask what would have to be true for the opposite choice to be right.',
  'Start from the constraint that hurts most and reason outward from it.',
  'Consider the proposal at ten times the scale, then at a tenth of the budget.',
  'Separate the reversible decisions from the irreversible ones and weight them differently.',
  'Surface what the room is assuming but has not stated.',
  'Reason backwards from the most likely failure, not forwards from the plan.',
  'Ask who bears the cost of being wrong, and whether they are in the room.',
  'Frame it as a bet: what odds would each participant actually take?',
  'Find the smallest experiment that would settle the disagreement.',
  'Ask what changes if the timeline halves, and what that reveals about priorities.',
  'Ask what the second-best option is, and why exactly it loses.',
  'Identify which disagreement is about facts and which is about values — they need different treatment.',
  'Ask what a competitor doing the opposite would know that this room does not.',
  'Push on the boundary conditions: where does each position stop being true?',
];

/** Picks a framing device, avoiding ones already used in this room. */
export function pickFraming(usedFramings: string[]): string {
  const unused = FRAMING_DEVICES.filter((f) => !usedFramings.includes(f));
  const pool = unused.length > 0 ? unused : FRAMING_DEVICES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * How one round is conducted. The owner picks this per round rather than the
 * room fixing it up front, so a discussion can open wide, narrow to critique,
 * and close on a synthesis without leaving the room.
 */
export type RoundMode =
  /** Every seat answers the prompt independently, in parallel. Nobody sees the others. */
  | 'parallel'
  /** Seats speak in order; each sees what earlier seats said this round. */
  | 'sequential'
  /** Each seat critiques the others' most recent contributions. */
  | 'critique'
  /** One seat writes the conclusion from everything said so far. */
  | 'synthesis'
  /** The owner addresses specific seats directly. */
  | 'direct';

export const ROUND_MODES: Array<{ mode: RoundMode; label: string; hint: string }> = [
  {
    mode: 'parallel',
    label: 'Open floor',
    hint: 'Everyone answers at once, independently. Best for a first pass — no anchoring on whoever spoke first.',
  },
  {
    mode: 'sequential',
    label: 'Go around',
    hint: 'Seats speak in turn, each building on what was already said this round.',
  },
  {
    mode: 'critique',
    label: 'Cross-examine',
    hint: 'Each seat challenges the others’ latest positions and names where it disagrees.',
  },
  {
    mode: 'synthesis',
    label: 'Wrap up',
    hint: 'One seat writes the conclusion from the whole discussion.',
  },
  {
    mode: 'direct',
    label: 'Ask directly',
    hint: 'Put a question to specific seats only.',
  },
];

/** One thing a seat did while working — the research trail. */
export interface ActivityEvent {
  at: number;
  kind: 'search' | 'fetch' | 'read' | 'run' | 'tool';
  /** Short label, e.g. "WebSearch". */
  label: string;
  /** The search terms, when the tool was a search. */
  query?: string;
  /** The page fetched, when the tool was a fetch. Rendered as a link. */
  url?: string;
  /** Anything else worth showing, already truncated for display. */
  detail?: string;
}

export type TurnStatus = 'pending' | 'streaming' | 'done' | 'error' | 'aborted';

export interface Turn {
  id: string;
  seatId: string;
  roundIndex: number;
  content: string;
  reasoning?: string;
  activity: ActivityEvent[];
  status: TurnStatus;
  error?: string;
  meta?: MessageMeta;
  startedAt: number;
  endedAt?: number;
}

/** A seat's position at the end of a round, used to detect convergence. */
export interface Vote {
  seatId: string;
  agree: boolean;
  /** One line explaining the position, shown next to the tally. */
  note: string;
}

export interface Round {
  index: number;
  mode: RoundMode;
  /** What the owner actually typed, in their own words. */
  prompt: string;
  /** The moderator's rewrite of it, when a moderator is seated. */
  brief?: ModeratorBrief;
  /** The moderator's ruling at the end of the round. */
  verdict?: ModeratorVerdict;
  /** Which seats took part. */
  seatIds: string[];
  turns: Turn[];
  votes: Vote[];
  /** True when every voting seat agreed. */
  consensus: boolean;
  startedAt: number;
  endedAt?: number;
}

/**
 * The moderator.
 *
 * Not a participant. It does three jobs the seats cannot do for themselves:
 * turns the owner's rough thought into a properly formed brief, tailors that
 * brief to each seat's role, and judges after every round whether the room is
 * done. Because judging often needs a fact checked, it defaults to a CLI seat —
 * those are the ones with research tools.
 */
export interface Moderator {
  enabled: boolean;
  name: string;
  provider: ProviderId;
  transport: Transport;
  model: string;
  cwd?: string;
  color: string;
  /**
   * The moderator's own role. A neutral chair merely reports whether the room
   * agreed; a moderator seated as, say, the CTO decides, and its ruling carries
   * that perspective's priorities. Empty means neutral chair.
   */
  role?: string;
  /**
   * How much the moderator is pushed to reframe rather than repeat, 0–1. Also
   * sets its sampling temperature. Higher means fresher and less predictable
   * discussions from the same inputs.
   */
  creativity: number;
}

/** The moderator's rewrite of the owner's message into an agenda. */
export interface ModeratorBrief {
  /** The properly formed question put to the room. */
  agenda: string;
  /** The framing device this brief was built around, so later rounds vary. */
  framing?: string;
  /** Seat id to the instruction written specifically for that seat's role. */
  perSeat: Record<string, string>;
  /** Anything the moderator wants the room to know, e.g. a fact it checked. */
  notes?: string;
  reasoning?: string;
  activity: ActivityEvent[];
}

/** The moderator's ruling at the end of a round. */
export interface ModeratorVerdict {
  /** True when the moderator judges the discussion finished. */
  conclude: boolean;
  reason: string;
  /** What the next round should concentrate on, when continuing. */
  focus?: string;
  reasoning?: string;
  activity: ActivityEvent[];
}

export type RoomStatus = 'idle' | 'running' | 'closed';

export interface Room {
  id: string;
  title: string;
  /** The question the owner put to the room. */
  topic: string;
  seats: Seat[];
  moderator: Moderator;
  rounds: Round[];
  status: RoomStatus;
  /** Set once the room reaches consensus or is closed with a synthesis. */
  conclusion?: string;
  /**
   * Consensus is checked after every round. The room keeps going until every
   * seat agrees or the owner closes it — there is deliberately no round cap.
   */
  requireConsensus: boolean;
  /** Which seat writes the synthesis. Defaults to the first enabled seat. */
  synthesisSeatId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoomSummary {
  id: string;
  title: string;
  status: RoomStatus;
  seatCount: number;
  roundCount: number;
  consensusReached: boolean;
  updatedAt: number;
}

/** Everything the room pushes to the renderer while a round runs. */
export type RoundtableEvent =
  | { type: 'round-start'; roomId: string; roundIndex: number; mode: RoundMode; seatIds: string[] }
  | { type: 'turn-start'; roomId: string; roundIndex: number; seatId: string; turnId: string }
  | { type: 'turn-reasoning'; roomId: string; turnId: string; seatId: string; text: string }
  | { type: 'turn-text'; roomId: string; turnId: string; seatId: string; text: string }
  | { type: 'turn-activity'; roomId: string; turnId: string; seatId: string; activity: ActivityEvent }
  | {
      type: 'turn-end';
      roomId: string;
      turnId: string;
      seatId: string;
      status: TurnStatus;
      meta?: MessageMeta;
      error?: string;
      /**
       * The finished answer and its research trail, carried on the event.
       *
       * A consumer cannot read these back from the store: the engine pushes
       * turns into the round only once every turn in it has finished, so at the
       * moment this fires the turn exists in neither the room nor the file.
       */
      content?: string;
      activity?: ActivityEvent[];
    }
  | { type: 'vote'; roomId: string; roundIndex: number; vote: Vote }
  | { type: 'moderator-start'; roomId: string; roundIndex: number; phase: 'brief' | 'verdict' }
  | { type: 'moderator-reasoning'; roomId: string; roundIndex: number; text: string }
  | { type: 'moderator-text'; roomId: string; roundIndex: number; text: string }
  | { type: 'moderator-activity'; roomId: string; roundIndex: number; activity: ActivityEvent }
  | { type: 'moderator-brief'; roomId: string; roundIndex: number; brief: ModeratorBrief }
  | { type: 'moderator-verdict'; roomId: string; roundIndex: number; verdict: ModeratorVerdict }
  | {
      type: 'round-end';
      roomId: string;
      roundIndex: number;
      consensus: boolean;
      /** Running total across the whole room, so spend stays visible. */
      totals: RoomTotals;
    }
  | { type: 'room-status'; roomId: string; status: RoomStatus; conclusion?: string }
  | { type: 'room-error'; roomId: string; message: string };

export interface RoomTotals {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  rounds: number;
}

/** Default roster: one voice per provider, plus a CLI seat where the vendor has one. */
export function defaultSeats(models: Record<ProviderId, string>): Seat[] {
  return [
    {
      id: 'glm-api',
      name: 'GLM',
      provider: 'glm',
      transport: 'api',
      model: models.glm,
      enabled: true,
      color: '#38bdf8',
    },
    {
      id: 'claude-api',
      name: 'Claude',
      provider: 'anthropic',
      transport: 'api',
      model: models.anthropic,
      enabled: true,
      color: '#f97316',
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      provider: 'anthropic',
      transport: 'cli',
      model: models.anthropic,
      enabled: true,
      color: '#fb923c',
    },
    {
      id: 'chatgpt-api',
      name: 'ChatGPT',
      provider: 'openai',
      transport: 'api',
      model: models.openai,
      enabled: true,
      color: '#a78bfa',
    },
    {
      id: 'codex-cli',
      name: 'Codex',
      provider: 'openai',
      transport: 'cli',
      model: models.openai,
      enabled: true,
      color: '#c4b5fd',
    },
    {
      id: 'kimi-api',
      name: 'Kimi',
      provider: 'kimi',
      transport: 'api',
      model: models.kimi,
      enabled: true,
      color: '#2dd4bf',
    },
    {
      id: 'kimi-cli',
      name: 'Kimi Code',
      provider: 'kimi',
      transport: 'cli',
      model: models.kimi,
      // Off by default: seven seats is a crowd, and this one needs the Kimi
      // Code CLI installed. Enable it in the seat editor.
      enabled: false,
      color: '#5eead4',
    },
  ];
}

/**
 * The default moderator: Claude Code, because judging a discussion usually
 * means checking something, and the CLI seats are the ones with tools.
 */
export function defaultModerator(model: string): Moderator {
  return {
    enabled: true,
    name: 'Moderator',
    provider: 'anthropic',
    transport: 'cli',
    model,
    color: '#34d399',
    creativity: 0.7,
  };
}

/** A moderator can only research when it is seated on a CLI transport. */
export function moderatorCanResearch(moderator: Moderator): boolean {
  return moderator.transport === 'cli';
}

/**
 * Which seats can actually research rather than only reason.
 *
 * Only the CLI seats carry web tools. An API seat with extended thinking will
 * show you its reasoning but will never show a URL, because it is not browsing.
 * The UI says so rather than leaving an empty panel looking broken.
 */
export function seatCanResearch(seat: Seat): boolean {
  return seat.transport === 'cli';
}
