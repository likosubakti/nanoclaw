import type {
  ActivityEvent,
  ModeratorBrief,
  ModeratorVerdict,
  Room,
  RoomTotals,
  Round,
  RoundMode,
  RoundtableEvent,
  Seat,
  Turn,
} from '@shared/roundtable';
import { ROLE_PRESETS, ROUND_MODES, moderatorCanResearch, seatCanResearch } from '@shared/roundtable';
import type { ProviderId, Transport } from '@shared/types';
import { PROVIDER_LABELS, PROVIDER_ORDER, modelsFor } from '@shared/models';
import { clear, h, icon } from '../lib/dom';
import { renderMarkdown } from '../lib/markdown';
import { api, toast, update } from '../state';

/**
 * The Roundtable: several backends discussing one topic, with their thinking
 * and research visible while they work.
 *
 * The point of this view is the waiting. A turn can take minutes, and a silent
 * spinner tells you nothing about whether anything is happening. So every seat
 * gets a live lane showing what it is doing right now — thinking, searching,
 * reading — and the research trail keeps the URLs it visited.
 */

let room: Room | null = null;
let totals: RoomTotals = { inputTokens: 0, outputTokens: 0, turns: 0, rounds: 0 };
let roundRunning = false;

let transcriptEl: HTMLElement | null = null;
let seatStripEl: HTMLElement | null = null;
let composerEl: HTMLTextAreaElement | null = null;
let unsubscribe: (() => void) | null = null;
let pinnedToBottom = true;
let selectedMode: RoundMode = 'parallel';

/** Live state for a turn currently streaming. */
interface LiveTurn {
  seat: Seat;
  turnId: string;
  text: string;
  reasoning: string;
  activity: ActivityEvent[];
  card: HTMLElement;
  proseEl: HTMLElement;
  reasoningWrap: HTMLElement | null;
  reasoningProse: HTMLElement | null;
  activityWrap: HTMLElement | null;
  activityList: HTMLElement | null;
  statusEl: HTMLElement;
}

const live = new Map<string, LiveTurn>();

/** The moderator's card while it is briefing or ruling. */
interface LiveModerator {
  roundIndex: number;
  phase: 'brief' | 'verdict';
  text: string;
  reasoning: string;
  activity: ActivityEvent[];
  card: HTMLElement;
  proseEl: HTMLElement;
  reasoningWrap: HTMLElement | null;
  reasoningProse: HTMLElement | null;
  activityWrap: HTMLElement | null;
  activityList: HTMLElement | null;
  statusEl: HTMLElement;
}
let liveModerator: LiveModerator | null = null;
let rolesOpen = false;
/** Per-seat one-line status shown in the strip at the top. */
const seatStatus = new Map<string, { label: string; busy: boolean; detail?: string }>();

/* ----------------------------------------------------------------- view --- */

export function renderRoundtable(container: HTMLElement): void {
  clear(container);

  if (!room) {
    container.appendChild(roomPicker());
    subscribe();
    return;
  }

  seatStripEl = h('div', { class: 'seat-strip' });
  transcriptEl = h('div', { class: 'messages roundtable-transcript' });

  transcriptEl.addEventListener('scroll', () => {
    const el = transcriptEl!;
    pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  });
  transcriptEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('[data-action="copy-code"]');
    if (!target) return;
    const code = target.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard.writeText(code).then(() => {
      target.textContent = 'Copied';
      setTimeout(() => (target.textContent = 'Copy'), 1400);
    });
  });

  rolesPanelEl = h('div', { class: 'roles-panel' });
  rolesPanelEl.hidden = !rolesOpen;

  container.appendChild(seatStripEl);
  container.appendChild(rolesPanelEl);
  container.appendChild(transcriptEl);
  container.appendChild(buildComposer());

  paintSeatStrip();
  paintRolesPanel();
  paintTranscript();
  subscribe();
}

export function buildRoundtableToolbar(): HTMLElement[] {
  if (!room) {
    return [
      h(
        'button',
        { class: 'btn primary', on: { click: () => void newRoom() } },
        icon('plus', 15),
        'New discussion',
      ),
    ];
  }

  const controls: HTMLElement[] = [
    h('span', {
      class: 'badge',
      text: `${totals.rounds} rounds · ${totals.turns} turns`,
      title: 'Rounds and turns so far in this room',
    }),
    h('span', {
      class: 'badge',
      text: `${formatTokens(totals.inputTokens + totals.outputTokens)} tokens`,
      title:
        `Input ${totals.inputTokens.toLocaleString()} · output ${totals.outputTokens.toLocaleString()}\n` +
        'Every seat sees the full transcript each turn, so this grows quickly.',
    }),
  ];

  if (roundRunning) {
    controls.push(
      h(
        'button',
        { class: 'btn danger', on: { click: () => void stopRound() } },
        icon('stop', 14),
        'Stop',
      ),
    );
  }

  controls.push(
    h(
      'button',
      {
        class: 'btn ghost icon',
        title: 'Export discussion as Markdown',
        on: { click: () => void exportRoom() },
      },
      icon('download', 16),
    ),
    h(
      'button',
      {
        class: 'btn ghost',
        title: 'Back to the room list',
        on: {
          click: () => {
            room = null;
            update({});
          },
        },
      },
      'Rooms',
    ),
  );

  return controls;
}

/* ----------------------------------------------------------- room picker -- */

function roomPicker(): HTMLElement {
  const page = h('div', { class: 'scroll-page' });
  const inner = h('div', { class: 'page-inner' });
  page.appendChild(inner);

  inner.appendChild(h('h1', { class: 'page-title', text: 'Roundtable' }));
  inner.appendChild(
    h('p', {
      class: 'page-sub',
      text: 'Put a question to GLM, Claude, Claude Code, ChatGPT and Codex at once, and watch them think, research, and argue it out until they agree.',
    }),
  );

  const input = h('textarea', {
    rows: 3,
    placeholder: 'What should the room discuss?  e.g. "Should we migrate this service off Postgres to SQLite?"',
  });

  inner.appendChild(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'title', text: 'Start a discussion' })),
      h(
        'div',
        { class: 'card-body' },
        input,
        h(
          'div',
          { class: 'row', style: { marginTop: '10px' } },
          h(
            'button',
            {
              class: 'btn primary',
              on: {
                click: () => {
                  const topic = input.value.trim();
                  if (!topic) return toast('Give the room something to discuss.', 'error');
                  void newRoom(topic);
                },
              },
            },
            'Open the room',
          ),
        ),
      ),
    ),
  );

  const list = h('div', { class: 'card' });
  list.appendChild(
    h('div', { class: 'card-head' }, h('div', { class: 'title', text: 'Past discussions' })),
  );
  const body = h('div', { class: 'card-body tight' });
  list.appendChild(body);
  inner.appendChild(list);

  void api.rooms.list().then((rooms) => {
    clear(body);
    if (rooms.length === 0) {
      body.appendChild(h('div', { class: 'hint', text: 'No discussions yet.' }));
      return;
    }
    for (const summary of rooms) {
      body.appendChild(
        h(
          'button',
          {
            class: 'conv-item',
            on: { click: () => void openRoom(summary.id) },
          },
          h('span', { class: 'conv-title', text: summary.title }),
          h(
            'span',
            { class: 'conv-meta' },
            h('span', {
              class: `dot ${summary.consensusReached ? 'ok' : 'off'}`,
            }),
            h('span', {
              text: summary.consensusReached
                ? 'consensus reached'
                : `${summary.roundCount} rounds, still open`,
            }),
            h('span', { text: '·' }),
            h('span', { text: `${summary.seatCount} seats` }),
          ),
        ),
      );
    }
  });

  return page;
}

async function newRoom(topic?: string): Promise<void> {
  if (!topic) {
    update({});
    return;
  }
  room = await api.rooms.create(topic);
  totals = { inputTokens: 0, outputTokens: 0, turns: 0, rounds: 0 };
  selectedMode = 'parallel';
  update({});
}

async function openRoom(id: string): Promise<void> {
  room = await api.rooms.get(id);
  const snapshot = await api.rooms.totals(id);
  if (snapshot) {
    totals = snapshot.totals;
    roundRunning = snapshot.running;
  }
  update({});
}

/* ------------------------------------------------------------ seat strip -- */

function paintSeatStrip(): void {
  if (!seatStripEl || !room) return;
  clear(seatStripEl);

  // The moderator sits apart from the participants: it does not answer the
  // question, it shapes it and rules on the answer.
  const mod = room.moderator;
  const modStatus = seatStatus.get('__moderator');
  seatStripEl.appendChild(
    h(
      'div',
      {
        class: `seat-chip moderator${mod.enabled ? '' : ' disabled'}${modStatus?.busy ? ' busy' : ''}`,
        style: { borderColor: mod.enabled ? `${mod.color}55` : undefined },
        title: `${mod.provider} · ${mod.transport} · ${mod.model}\n${
          moderatorCanResearch(mod)
            ? 'Has tools — can research before briefing and ruling'
            : 'No tools in this seat — cannot check facts'
        }`,
        on: { click: () => void toggleModerator() },
      },
      h('span', { class: 'seat-dot', style: { background: mod.enabled ? mod.color : 'var(--text-faint)' } }),
      h(
        'div',
        { class: 'seat-body' },
        h('div', { class: 'seat-name', text: 'Moderator' }),
        h('div', { class: 'seat-status', text: modStatus?.label ?? (mod.enabled ? 'judging' : 'off') }),
      ),
      modStatus?.busy ? h('span', { class: 'spinner' }) : null,
    ),
  );
  seatStripEl.appendChild(h('div', { class: 'seat-divider' }));

  for (const seat of room.seats) {
    const status = seatStatus.get(seat.id);
    const busy = status?.busy ?? false;

    const chip = h(
      'div',
      {
        class: `seat-chip${seat.enabled ? '' : ' disabled'}${busy ? ' busy' : ''}`,
        style: { borderColor: seat.enabled ? `${seat.color}55` : undefined },
        title: `${seat.provider} · ${seat.transport} · ${seat.model}\n${
          seatCanResearch(seat)
            ? 'Has tools — can search and read'
            : 'No tools — reasons only, does not browse'
        }`,
      },
      h('span', {
        class: 'seat-dot',
        style: { background: seat.enabled ? seat.color : 'var(--text-faint)' },
      }),
      h(
        'div',
        { class: 'seat-body' },
        h('div', { class: 'seat-name', text: seat.name }),
        h('div', {
          class: 'seat-status',
          text: status?.label ?? (seat.role?.trim() || (seat.enabled ? 'no role' : 'sitting out')),
        }),
      ),
      busy ? h('span', { class: 'spinner' }) : null,
    );

    // Clicking a chip seats or un-seats that participant.
    chip.addEventListener('click', () => void toggleSeat(seat.id));
    seatStripEl.appendChild(chip);
  }

  seatStripEl.appendChild(h('span', { class: 'spacer' }));
  seatStripEl.appendChild(
    h(
      'button',
      {
        class: `btn ghost${rolesOpen ? ' active' : ''}`,
        on: {
          click: () => {
            rolesOpen = !rolesOpen;
            paintSeatStrip();
            paintRolesPanel();
          },
        },
      },
      icon('settings', 14),
      'Roles',
    ),
  );
}

async function toggleModerator(): Promise<void> {
  if (!room || roundRunning) return;
  room.moderator.enabled = !room.moderator.enabled;
  room = await api.rooms.update(room);
  paintSeatStrip();
}

/* ----------------------------------------------------------------- roles -- */

let rolesPanelEl: HTMLElement | null = null;

function paintRolesPanel(): void {
  if (!rolesPanelEl || !room) return;
  clear(rolesPanelEl);
  rolesPanelEl.hidden = !rolesOpen;
  if (!rolesOpen) return;

  rolesPanelEl.appendChild(
    h('div', {
      class: 'hint',
      style: { padding: '0 0 12px' },
      text: 'Give each seat a different thing to care about — without distinct roles, several models tend to produce several versions of the same answer. Seats may share an account: three Claude seats with different roles are three different voices.',
    }),
  );

  rolesPanelEl.appendChild(moderatorEditor());

  for (const seat of room.seats) rolesPanelEl.appendChild(seatEditor(seat));

  rolesPanelEl.appendChild(
    h(
      'div',
      { class: 'row', style: { marginTop: '4px' } },
      h(
        'button',
        { class: 'btn', on: { click: () => void addSeat() } },
        icon('plus', 14),
        'Add a seat',
      ),
    ),
  );
}

/** Provider, transport and model pickers, shared by seats and the moderator. */
function backendPickers(
  current: { provider: ProviderId; transport: Transport; model: string },
  onChange: (next: { provider: ProviderId; transport: Transport; model: string }) => void,
): HTMLElement {
  const modelSelect = h('select', { class: 'inline' });

  const fillModels = (provider: ProviderId, selected: string) => {
    clear(modelSelect);
    const models = modelsFor(provider);
    const options = models.some((m) => m.id === selected)
      ? models
      : [{ id: selected, provider, label: selected }, ...models];
    for (const m of options) {
      modelSelect.appendChild(
        h('option', { value: m.id, text: m.label, attrs: { selected: m.id === selected } }),
      );
    }
  };
  fillModels(current.provider, current.model);

  modelSelect.addEventListener('change', () =>
    onChange({ ...current, model: modelSelect.value }),
  );

  const providerSelect = h(
    'select',
    {
      class: 'inline',
      on: {
        change: (event) => {
          const provider = (event.target as HTMLSelectElement).value as ProviderId;
          // The old model belongs to the old provider, so fall back to that
          // provider's default rather than sending a model it will reject.
          const model = modelsFor(provider)[0]?.id ?? current.model;
          fillModels(provider, model);
          onChange({ ...current, provider, model });
        },
      },
    },
    ...PROVIDER_ORDER.map((id) =>
      h('option', { value: id, text: PROVIDER_LABELS[id], attrs: { selected: id === current.provider } }),
    ),
  );

  const transportSelect = h(
    'select',
    {
      class: 'inline',
      title: 'CLI seats have tools and can research; API seats reason only.',
      on: {
        change: (event) =>
          onChange({ ...current, transport: (event.target as HTMLSelectElement).value as Transport }),
      },
    },
    h('option', { value: 'api', text: 'API', attrs: { selected: current.transport === 'api' } }),
    h('option', { value: 'cli', text: 'CLI', attrs: { selected: current.transport === 'cli' } }),
  );

  return h('div', { class: 'row wrap' }, providerSelect, transportSelect, modelSelect);
}

function rolePicker(onPick: (prompt: string) => void): HTMLElement {
  return h(
    'select',
    {
      class: 'inline',
      on: {
        change: (event) => {
          const select = event.target as HTMLSelectElement;
          const preset = ROLE_PRESETS.find((r) => r.id === select.value);
          // "Custom…" leaves whatever is in the box for the user to write.
          if (preset && preset.id !== 'custom') onPick(preset.prompt);
          select.value = '';
        },
      },
    },
    h('option', { value: '', text: 'Preset…' }),
    ...ROLE_PRESETS.map((r) => h('option', { value: r.id, text: r.label })),
  );
}

function moderatorEditor(): HTMLElement {
  const mod = room!.moderator;

  const roleBox = h('textarea', {
    rows: 2,
    value: mod.role ?? '',
    placeholder: 'Neutral chair — reports whether the room settled its disagreements',
    on: {
      change: async (event) => {
        if (!room) return;
        room.moderator.role = (event.target as HTMLTextAreaElement).value.trim();
        room = await api.rooms.update(room);
        paintSeatStrip();
      },
    },
  });

  const creativity = h('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.1',
    value: String(mod.creativity ?? 0.7),
    on: {
      change: async (event) => {
        if (!room) return;
        room.moderator.creativity = Number((event.target as HTMLInputElement).value);
        room = await api.rooms.update(room);
        paintRolesPanel();
      },
    },
  });

  return h(
    'div',
    { class: 'role-row moderator-row' },
    h(
      'div',
      { class: 'role-head' },
      h('span', { class: 'seat-dot', style: { background: mod.color } }),
      h('span', { class: 'role-seat', text: 'Moderator' }),
      h('span', {
        class: 'badge',
        text: moderatorCanResearch(mod) ? 'can research' : 'no tools',
      }),
      h('span', { class: 'spacer' }),
      rolePicker((prompt) => {
        roleBox.value = prompt;
        roleBox.dispatchEvent(new Event('change'));
      }),
    ),
    backendPickers(mod, async (next) => {
      if (!room) return;
      Object.assign(room.moderator, next);
      room = await api.rooms.update(room);
      paintRolesPanel();
      paintSeatStrip();
    }),
    roleBox,
    h(
      'div',
      { class: 'row', style: { marginTop: '6px' } },
      h('span', { class: 'hint', style: { margin: '0' }, text: 'Freshness' }),
      creativity,
      h('span', {
        class: 'hint',
        style: { margin: '0' },
        text:
          (mod.creativity ?? 0.7) >= 0.4
            ? 'Reframes each round with a different lens, so the same room gives different discussions.'
            : 'Plain, repeatable framing.',
      }),
    ),
  );
}

function seatEditor(seat: Seat): HTMLElement {
  const nameInput = h('input', {
    type: 'text',
    value: seat.name,
    on: {
      change: async (event) => {
        if (!room) return;
        const target = room.seats.find((s) => s.id === seat.id);
        if (!target) return;
        // The name is how the moderator addresses this seat in its brief and
        // how other seats refer to it, so it has to be unique and non-empty.
        const wanted = (event.target as HTMLInputElement).value.trim() || 'Seat';
        target.name = uniqueName(wanted, seat.id);
        (event.target as HTMLInputElement).value = target.name;
        room = await api.rooms.update(room);
        paintSeatStrip();
      },
    },
  });

  const roleBox = h('textarea', {
    rows: 2,
    value: seat.role ?? '',
    placeholder: 'No role — this seat speaks as itself',
    on: {
      change: async (event) => {
        if (!room) return;
        const target = room.seats.find((s) => s.id === seat.id);
        if (!target) return;
        target.role = (event.target as HTMLTextAreaElement).value.trim();
        room = await api.rooms.update(room);
        paintSeatStrip();
      },
    },
  });

  return h(
    'div',
    { class: 'role-row' },
    h(
      'div',
      { class: 'role-head' },
      h('span', { class: 'seat-dot', style: { background: seat.color } }),
      nameInput,
      h('span', {
        class: 'badge',
        text: seatCanResearch(seat) ? 'can research' : 'no tools',
      }),
      h('span', { class: 'spacer' }),
      rolePicker((prompt) => {
        roleBox.value = prompt;
        roleBox.dispatchEvent(new Event('change'));
      }),
      h(
        'button',
        {
          class: 'btn ghost icon',
          title: `Duplicate ${seat.name} — same backend, new role`,
          on: { click: () => void addSeat(seat) },
        },
        icon('copy', 14),
      ),
      h(
        'button',
        {
          class: 'btn danger icon',
          title: `Remove ${seat.name}`,
          on: { click: () => void removeSeat(seat.id) },
        },
        icon('trash', 14),
      ),
    ),
    backendPickers(seat, async (next) => {
      if (!room) return;
      const target = room.seats.find((s) => s.id === seat.id);
      if (!target) return;
      Object.assign(target, next);
      room = await api.rooms.update(room);
      paintRolesPanel();
      paintSeatStrip();
    }),
    roleBox,
  );
}

const SEAT_COLORS = ['#38bdf8', '#f97316', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c'];

/** Ensures a seat name is unique, since names are how seats address each other. */
function uniqueName(wanted: string, exceptId?: string): string {
  const taken = new Set(
    room!.seats.filter((s) => s.id !== exceptId).map((s) => s.name.toLowerCase()),
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

async function addSeat(from?: Seat): Promise<void> {
  if (!room || roundRunning) return;
  const base = from ?? room.seats[0];
  const seat: Seat = {
    id: `seat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: uniqueName(from ? from.name : 'New seat'),
    provider: base?.provider ?? 'glm',
    transport: base?.transport ?? 'api',
    model: base?.model ?? 'glm-4.6',
    enabled: true,
    role: from?.role ?? '',
    color: SEAT_COLORS[room.seats.length % SEAT_COLORS.length],
    cwd: base?.cwd,
  };
  room.seats.push(seat);
  room = await api.rooms.update(room);
  paintRolesPanel();
  paintSeatStrip();
}

async function removeSeat(seatId: string): Promise<void> {
  if (!room || roundRunning) return;
  if (room.seats.length <= 1) {
    toast('A room needs at least one seat.', 'error');
    return;
  }
  room.seats = room.seats.filter((s) => s.id !== seatId);
  if (room.synthesisSeatId === seatId) room.synthesisSeatId = room.seats[0]?.id;
  room = await api.rooms.update(room);
  paintRolesPanel();
  paintSeatStrip();
}

async function toggleSeat(seatId: string): Promise<void> {
  if (!room || roundRunning) return;
  const seat = room.seats.find((s) => s.id === seatId);
  if (!seat) return;
  seat.enabled = !seat.enabled;
  room = await api.rooms.update(room);
  paintSeatStrip();
}

function setSeatStatus(seatId: string, label: string, busy: boolean, detail?: string): void {
  seatStatus.set(seatId, { label, busy, detail });
  paintSeatStrip();
}

/* ------------------------------------------------------------ transcript -- */

function paintTranscript(): void {
  if (!transcriptEl || !room) return;
  clear(transcriptEl);
  live.clear();

  if (room.rounds.length === 0) {
    transcriptEl.appendChild(openingCard());
    return;
  }

  for (const round of room.rounds) transcriptEl.appendChild(roundBlock(round));
  scrollToBottom(true);
}

function openingCard(): HTMLElement {
  const enabled = room!.seats.filter((s) => s.enabled);
  const researchers = enabled.filter(seatCanResearch);

  return h(
    'div',
    { class: 'empty' },
    h(
      'div',
      {},
      h('h2', { text: room!.topic }),
      h('p', {
        text: `${enabled.length} seats are ready. ${researchers.length} of them (${researchers
          .map((s) => s.name)
          .join(', ')}) have tools and can actually search the web; the rest reason from what they know.`,
      }),
      h('p', {
        class: 'hint',
        text: 'Pick how the room should talk, then send your opening message below.',
      }),
    ),
  );
}

function roundBlock(round: Round): HTMLElement {
  const modeLabel = ROUND_MODES.find((m) => m.mode === round.mode)?.label ?? round.mode;

  const block = h(
    'div',
    { class: 'round-block', attrs: { 'data-round': String(round.index) } },
    h(
      'div',
      { class: 'round-head' },
      h('span', { class: 'round-index', text: `Round ${round.index + 1}` }),
      h('span', { class: 'round-mode', text: modeLabel }),
    ),
  );

  if (round.prompt.trim()) {
    block.appendChild(
      h(
        'div',
        { class: 'owner-message' },
        h('span', { class: 'owner-tag', text: 'You' }),
        h('div', { class: 'prose', text: round.prompt }),
      ),
    );
  }

  if (round.brief) block.appendChild(briefCard(round.brief));

  for (const turn of round.turns) {
    const seat = room!.seats.find((s) => s.id === turn.seatId);
    if (seat) block.appendChild(completedTurnCard(turn, seat));
  }

  if (round.verdict) block.appendChild(verdictCard(round.verdict));
  if (round.votes.length) block.appendChild(voteTally(round));
  return block;
}

/* ------------------------------------------------------------- moderator -- */

function moderatorShell(label: string): {
  card: HTMLElement;
  statusEl: HTMLElement;
  bodyEl: HTMLElement;
} {
  const color = room?.moderator.color ?? '#34d399';
  const statusEl = h('span', { class: 'turn-status' });
  const bodyEl = h('div', { class: 'turn-body' });
  const card = h(
    'div',
    { class: 'turn-card moderator-card', style: { borderLeftColor: color } },
    h(
      'div',
      { class: 'turn-head' },
      h('span', { class: 'seat-dot', style: { background: color } }),
      h('span', { class: 'turn-seat', text: 'Moderator' }),
      h('span', { class: 'turn-model', text: label }),
      h('span', { class: 'spacer' }),
      statusEl,
    ),
    bodyEl,
  );
  return { card, statusEl, bodyEl };
}

function briefCard(brief: ModeratorBrief): HTMLElement {
  const { card, bodyEl } = moderatorShell('brief');

  if (brief.activity.length) bodyEl.appendChild(activityPanel(brief.activity, false));
  if (brief.reasoning) bodyEl.appendChild(reasoningPanel(brief.reasoning, false));

  const agenda = h('div', { class: 'prose' });
  agenda.innerHTML = renderMarkdown(brief.agenda);
  bodyEl.appendChild(h('div', { class: 'brief-agenda' }, agenda));

  if (brief.notes) {
    bodyEl.appendChild(h('div', { class: 'brief-note', text: brief.notes }));
  }

  const assignments = Object.entries(brief.perSeat);
  if (assignments.length) {
    const details = h('details', { class: 'activity' });
    details.appendChild(h('summary', { text: `Briefs to each seat (${assignments.length})` }));
    const list = h('div', { class: 'activity-list' });
    for (const [seatId, instruction] of assignments) {
      const seat = room?.seats.find((s) => s.id === seatId);
      list.appendChild(
        h(
          'div',
          { class: 'brief-row' },
          h('span', {
            class: 'brief-seat',
            style: { color: seat?.color },
            text: seat?.name ?? seatId,
          }),
          h('span', { class: 'brief-text', text: instruction }),
        ),
      );
    }
    details.appendChild(list);
    bodyEl.appendChild(details);
  }

  return card;
}

function verdictCard(verdict: ModeratorVerdict): HTMLElement {
  const { card, statusEl, bodyEl } = moderatorShell('ruling');
  statusEl.textContent = verdict.conclude ? 'concluded' : 'continues';
  card.classList.add(verdict.conclude ? 'verdict-conclude' : 'verdict-continue');

  if (verdict.activity.length) bodyEl.appendChild(activityPanel(verdict.activity, false));
  if (verdict.reasoning) bodyEl.appendChild(reasoningPanel(verdict.reasoning, false));

  bodyEl.appendChild(
    h(
      'div',
      { class: 'verdict-head' },
      icon(verdict.conclude ? 'check' : 'refresh', 14),
      h('span', {
        text: verdict.conclude
          ? 'The moderator rules the discussion finished'
          : 'The moderator rules the discussion should continue',
      }),
    ),
  );
  bodyEl.appendChild(h('div', { class: 'prose', text: verdict.reason }));
  if (verdict.focus) {
    bodyEl.appendChild(
      h('div', { class: 'brief-note' }, h('strong', { text: 'Next: ' }), verdict.focus),
    );
  }
  return card;
}

function voteTally(round: Round): HTMLElement {
  const agreed = round.votes.filter((v) => v.agree).length;
  const total = round.votes.length;

  const wrap = h(
    'div',
    { class: `vote-tally${round.consensus ? ' consensus' : ''}` },
    h(
      'div',
      { class: 'vote-head' },
      icon(round.consensus ? 'check' : 'alert', 14),
      h('span', {
        text: round.consensus
          ? 'Consensus reached'
          : `Still split — ${agreed} of ${total} agree`,
      }),
    ),
  );

  for (const vote of round.votes) {
    const seat = room!.seats.find((s) => s.id === vote.seatId);
    wrap.appendChild(
      h(
        'div',
        { class: 'vote-row' },
        h('span', {
          class: `vote-mark ${vote.agree ? 'yes' : 'no'}`,
          text: vote.agree ? 'agree' : 'disagree',
        }),
        h('span', { class: 'vote-seat', text: seat?.name ?? vote.seatId }),
        h('span', { class: 'vote-note', text: vote.note }),
      ),
    );
  }
  return wrap;
}

/* ---------------------------------------------------------- turn cards ---- */

function turnShell(seat: Seat): {
  card: HTMLElement;
  header: HTMLElement;
  statusEl: HTMLElement;
  bodyEl: HTMLElement;
} {
  const statusEl = h('span', { class: 'turn-status' });
  const header = h(
    'div',
    { class: 'turn-head' },
    h('span', { class: 'seat-dot', style: { background: seat.color } }),
    h('span', { class: 'turn-seat', text: seat.name }),
    h('span', { class: 'turn-model', text: `${seat.provider}/${seat.transport}` }),
    h('span', { class: 'spacer' }),
    statusEl,
  );
  const bodyEl = h('div', { class: 'turn-body' });
  const card = h(
    'div',
    { class: 'turn-card', style: { borderLeftColor: seat.color } },
    header,
    bodyEl,
  );
  return { card, header, statusEl, bodyEl };
}

function completedTurnCard(turn: Turn, seat: Seat): HTMLElement {
  const { card, statusEl, bodyEl } = turnShell(seat);

  if (turn.status === 'error') {
    statusEl.textContent = 'failed';
    statusEl.className = 'turn-status error';
    bodyEl.appendChild(
      h(
        'div',
        { class: 'message-error' },
        h('div', { class: 'err-title' }, icon('alert', 13), ' This seat could not answer'),
        h('div', { text: turn.error ?? 'Unknown error', style: { whiteSpace: 'pre-wrap' } }),
      ),
    );
    return card;
  }

  if (turn.status === 'aborted') {
    statusEl.textContent = 'stopped';
  } else if (turn.meta?.durationMs) {
    const seconds = (turn.meta.durationMs / 1000).toFixed(1);
    const tokens = turn.meta.outputTokens ? ` · ${turn.meta.outputTokens} out` : '';
    statusEl.textContent = `${seconds}s${tokens}`;
  }

  if (turn.activity.length) bodyEl.appendChild(activityPanel(turn.activity, false));
  if (turn.reasoning) bodyEl.appendChild(reasoningPanel(turn.reasoning, false));

  const prose = h('div', { class: 'prose' });
  prose.innerHTML = renderMarkdown(turn.content);
  bodyEl.appendChild(prose);

  return card;
}

function reasoningPanel(text: string, open: boolean): HTMLElement {
  const details = h('details', {
    class: 'reasoning',
    attrs: open ? { open: 'open' } : undefined,
  });
  details.appendChild(h('summary', { text: 'Thinking' }));
  const prose = h('div', { class: 'prose' });
  prose.innerHTML = renderMarkdown(text);
  details.appendChild(prose);
  return details;
}

function activityPanel(activity: ActivityEvent[], open: boolean): HTMLElement {
  const details = h('details', {
    class: 'activity',
    attrs: open ? { open: 'open' } : undefined,
  });
  details.appendChild(
    h('summary', {}, `Research trail (${activity.length})`) as unknown as HTMLElement,
  );
  const list = h('div', { class: 'activity-list' });
  for (const item of activity) list.appendChild(activityRow(item));
  details.appendChild(list);
  return details;
}

function activityRow(item: ActivityEvent): HTMLElement {
  const row = h('div', { class: `activity-row ${item.kind}` });
  row.appendChild(h('span', { class: 'activity-kind', text: item.label }));

  if (item.url) {
    // Links go to the real browser via the main process, never in-app.
    row.appendChild(
      h('a', {
        class: 'activity-target link',
        text: item.url,
        href: '#',
        on: {
          click: (event) => {
            event.preventDefault();
            void api.app.openExternal(item.url!);
          },
        },
      }),
    );
  } else {
    row.appendChild(
      h('span', { class: 'activity-target', text: item.query ?? item.detail ?? '' }),
    );
  }
  return row;
}

/* -------------------------------------------------------------- composer -- */

function buildComposer(): HTMLElement {
  const modeSelect = h(
    'select',
    {
      class: 'inline',
      title: 'How this round is conducted',
      on: {
        change: (event) => {
          selectedMode = (event.target as HTMLSelectElement).value as RoundMode;
          updateModeHint();
        },
      },
    },
    ...ROUND_MODES.map((m) =>
      h('option', {
        value: m.mode,
        text: m.label,
        attrs: { selected: m.mode === selectedMode },
      }),
    ),
  );

  const textarea = h('textarea', {
    rows: 1,
    placeholder: 'Say something to the room…',
    on: {
      input: (event) => autosize(event.target as HTMLTextAreaElement),
      keydown: (event) => {
        const e = event as KeyboardEvent;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void send();
        }
      },
    },
  });
  composerEl = textarea;

  const sendButton = h(
    'button',
    { class: 'btn primary', on: { click: () => void send() } },
    icon('send', 16),
  );

  const hint = h('span', { class: 'mode-hint' });

  const composer = h(
    'div',
    { class: 'composer' },
    h(
      'div',
      { class: 'composer-inner' },
      h('div', { class: 'composer-box' }, modeSelect, textarea, sendButton),
      h('div', { class: 'composer-foot' }, hint),
    ),
  );

  const updateModeHint = () => {
    const mode = ROUND_MODES.find((m) => m.mode === selectedMode);
    hint.textContent = mode?.hint ?? '';
    // Critique and synthesis stand on the existing discussion, so a message is
    // optional there but required when opening a new line of inquiry.
    textarea.placeholder =
      selectedMode === 'critique'
        ? 'Optional steer for the cross-examination…'
        : selectedMode === 'synthesis'
          ? 'Optional instruction for the wrap-up…'
          : 'Say something to the room…';
  };
  updateModeHint();

  return composer;
}

function autosize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
}

async function send(): Promise<void> {
  if (!room || !composerEl || roundRunning) return;

  const message = composerEl.value.trim();
  const needsMessage = selectedMode !== 'critique' && selectedMode !== 'synthesis';
  if (needsMessage && !message) {
    toast('Say something first, or switch to Cross-examine or Wrap up.', 'error');
    return;
  }

  composerEl.value = '';
  autosize(composerEl);

  await api.rooms.run({ roomId: room.id, mode: selectedMode, message });
}

async function stopRound(): Promise<void> {
  if (!room) return;
  await api.rooms.abort(room.id);
  toast('Stopping — seats will finish their current output.', 'info');
}

async function exportRoom(): Promise<void> {
  if (!room) return;
  const result = await api.rooms.export(room.id);
  if (result.saved) toast(`Exported to ${result.path}`, 'ok');
}

/* ----------------------------------------------------------------- live --- */

function subscribe(): void {
  unsubscribe?.();
  unsubscribe = api.rooms.onEvent(handleEvent);
}

function handleEvent(event: RoundtableEvent): void {
  if (!room || !('roomId' in event) || event.roomId !== room.id) return;

  switch (event.type) {
    case 'round-start': {
      roundRunning = true;
      // Drop the opening card once the first round begins.
      if (transcriptEl?.querySelector('.empty')) clear(transcriptEl);
      const round: Round = {
        index: event.roundIndex,
        mode: event.mode,
        prompt: pendingPrompt,
        seatIds: event.seatIds,
        turns: [],
        votes: [],
        consensus: false,
        startedAt: Date.now(),
      };
      transcriptEl?.appendChild(roundBlock(round));
      for (const seatId of event.seatIds) setSeatStatus(seatId, 'waiting…', true);
      update({});
      scrollToBottom(true);
      break;
    }

    case 'turn-start': {
      const seat = room.seats.find((s) => s.id === event.seatId);
      if (!seat) break;
      const block = transcriptEl?.querySelector(`[data-round="${event.roundIndex}"]`);
      if (!block) break;

      const { card, statusEl, bodyEl } = turnShell(seat);
      statusEl.appendChild(h('span', { class: 'spinner' }));
      statusEl.appendChild(h('span', { text: ' thinking' }));

      const prose = h('div', { class: 'prose' });
      bodyEl.appendChild(prose);
      block.appendChild(card);

      live.set(event.turnId, {
        seat,
        turnId: event.turnId,
        text: '',
        reasoning: '',
        activity: [],
        card,
        proseEl: prose,
        reasoningWrap: null,
        reasoningProse: null,
        activityWrap: null,
        activityList: null,
        statusEl,
      });

      setSeatStatus(seat.id, 'thinking', true);
      scrollToBottom();
      break;
    }

    case 'turn-reasoning': {
      const turn = live.get(event.turnId);
      if (!turn) break;
      turn.reasoning += event.text;
      if (!turn.reasoningWrap) {
        const panel = reasoningPanel('', true);
        turn.reasoningWrap = panel;
        turn.reasoningProse = panel.querySelector('.prose');
        turn.proseEl.before(panel);
      }
      if (turn.reasoningProse) {
        turn.reasoningProse.innerHTML = renderMarkdown(turn.reasoning);
      }
      setSeatStatus(turn.seat.id, 'thinking', true);
      scrollToBottom();
      break;
    }

    case 'turn-activity': {
      const turn = live.get(event.turnId);
      if (!turn) break;
      turn.activity.push(event.activity);

      if (!turn.activityWrap) {
        const panel = activityPanel([], true);
        turn.activityWrap = panel;
        turn.activityList = panel.querySelector('.activity-list');
        (turn.reasoningWrap ?? turn.proseEl).before(panel);
      }
      turn.activityList?.appendChild(activityRow(event.activity));
      const summary = turn.activityWrap.querySelector('summary');
      if (summary) summary.textContent = `Research trail (${turn.activity.length})`;

      // This is the line that makes waiting tolerable: say what it is doing.
      const a = event.activity;
      const label =
        a.kind === 'search'
          ? `searching: ${a.query ?? ''}`
          : a.kind === 'fetch'
            ? `reading: ${hostOf(a.url)}`
            : a.kind === 'run'
              ? `running: ${truncate(a.detail ?? '', 40)}`
              : `${a.label.toLowerCase()}: ${truncate(a.detail ?? '', 40)}`;
      setSeatStatus(turn.seat.id, truncate(label, 52), true);

      turn.statusEl.textContent = '';
      turn.statusEl.appendChild(h('span', { class: 'spinner' }));
      turn.statusEl.appendChild(h('span', { text: ` ${a.kind}` }));
      scrollToBottom();
      break;
    }

    case 'turn-text': {
      const turn = live.get(event.turnId);
      if (!turn) break;
      turn.text += event.text;
      turn.proseEl.innerHTML = renderMarkdown(turn.text);
      // Collapse thinking once the answer starts — the answer is what matters now.
      turn.reasoningWrap?.removeAttribute('open');
      setSeatStatus(turn.seat.id, 'writing', true);
      turn.statusEl.textContent = 'writing…';
      scrollToBottom();
      break;
    }

    case 'turn-end': {
      const turn = live.get(event.turnId);
      if (!turn) break;
      live.delete(event.turnId);

      turn.activityWrap?.removeAttribute('open');
      turn.reasoningWrap?.removeAttribute('open');
      clear(turn.statusEl);

      if (event.status === 'error') {
        turn.statusEl.className = 'turn-status error';
        turn.statusEl.textContent = 'failed';
        turn.proseEl.appendChild(
          h(
            'div',
            { class: 'message-error' },
            h('div', { class: 'err-title' }, icon('alert', 13), ' This seat could not answer'),
            h('div', { text: event.error ?? '', style: { whiteSpace: 'pre-wrap' } }),
          ),
        );
        setSeatStatus(turn.seat.id, 'failed', false);
      } else if (event.status === 'aborted') {
        turn.statusEl.textContent = 'stopped';
        setSeatStatus(turn.seat.id, 'stopped', false);
      } else {
        const ms = event.meta?.durationMs ?? 0;
        const out = event.meta?.outputTokens;
        turn.statusEl.textContent = `${(ms / 1000).toFixed(1)}s${out ? ` · ${out} out` : ''}`;
        setSeatStatus(turn.seat.id, 'done', false);
      }
      scrollToBottom();
      break;
    }

    case 'moderator-start': {
      const block = transcriptEl?.querySelector(`[data-round="${event.roundIndex}"]`);
      if (!block) break;
      const { card, statusEl, bodyEl } = moderatorShell(
        event.phase === 'brief' ? 'writing the brief' : 'ruling',
      );
      statusEl.appendChild(h('span', { class: 'spinner' }));
      const prose = h('div', { class: 'prose' });
      bodyEl.appendChild(prose);
      block.appendChild(card);

      liveModerator = {
        roundIndex: event.roundIndex,
        phase: event.phase,
        text: '',
        reasoning: '',
        activity: [],
        card,
        proseEl: prose,
        reasoningWrap: null,
        reasoningProse: null,
        activityWrap: null,
        activityList: null,
        statusEl,
      };
      setSeatStatus('__moderator', event.phase === 'brief' ? 'briefing' : 'ruling', true);
      scrollToBottom();
      break;
    }

    case 'moderator-reasoning': {
      const m = liveModerator;
      if (!m) break;
      m.reasoning += event.text;
      if (!m.reasoningWrap) {
        const panel = reasoningPanel('', true);
        m.reasoningWrap = panel;
        m.reasoningProse = panel.querySelector('.prose');
        m.proseEl.before(panel);
      }
      if (m.reasoningProse) m.reasoningProse.innerHTML = renderMarkdown(m.reasoning);
      scrollToBottom();
      break;
    }

    case 'moderator-activity': {
      const m = liveModerator;
      if (!m) break;
      m.activity.push(event.activity);
      if (!m.activityWrap) {
        const panel = activityPanel([], true);
        m.activityWrap = panel;
        m.activityList = panel.querySelector('.activity-list');
        (m.reasoningWrap ?? m.proseEl).before(panel);
      }
      m.activityList?.appendChild(activityRow(event.activity));
      const summary = m.activityWrap.querySelector('summary');
      if (summary) summary.textContent = `Research trail (${m.activity.length})`;
      const a = event.activity;
      setSeatStatus(
        '__moderator',
        truncate(a.kind === 'search' ? `searching: ${a.query ?? ''}` : `reading: ${hostOf(a.url)}`, 52),
        true,
      );
      scrollToBottom();
      break;
    }

    case 'moderator-text': {
      const m = liveModerator;
      if (!m) break;
      m.text += event.text;
      m.proseEl.innerHTML = renderMarkdown(m.text);
      m.reasoningWrap?.removeAttribute('open');
      scrollToBottom();
      break;
    }

    case 'moderator-brief': {
      // The parsed brief replaces the raw stream, which was only shown so the
      // owner could watch the moderator work.
      liveModerator?.card.replaceWith(briefCard(event.brief));
      liveModerator = null;
      setSeatStatus('__moderator', 'briefed', false);
      scrollToBottom();
      break;
    }

    case 'moderator-verdict': {
      liveModerator?.card.replaceWith(verdictCard(event.verdict));
      liveModerator = null;
      setSeatStatus('__moderator', event.verdict.conclude ? 'concluded' : 'continues', false);
      scrollToBottom();
      break;
    }

    case 'vote': {
      const block = transcriptEl?.querySelector(`[data-round="${event.roundIndex}"]`);
      if (!block) break;
      let tally = block.querySelector('.vote-tally') as HTMLElement | null;
      if (!tally) {
        tally = h('div', { class: 'vote-tally' });
        tally.appendChild(
          h('div', { class: 'vote-head' }, icon('alert', 14), h('span', { text: 'Positions' })),
        );
        block.appendChild(tally);
      }
      const seat = room.seats.find((s) => s.id === event.vote.seatId);
      tally.appendChild(
        h(
          'div',
          { class: 'vote-row' },
          h('span', {
            class: `vote-mark ${event.vote.agree ? 'yes' : 'no'}`,
            text: event.vote.agree ? 'agree' : 'disagree',
          }),
          h('span', { class: 'vote-seat', text: seat?.name ?? event.vote.seatId }),
          h('span', { class: 'vote-note', text: event.vote.note }),
        ),
      );
      setSeatStatus(event.vote.seatId, event.vote.agree ? 'agrees' : 'disagrees', false);
      scrollToBottom();
      break;
    }

    case 'round-end': {
      roundRunning = false;
      totals = event.totals;

      const block = transcriptEl?.querySelector(`[data-round="${event.roundIndex}"]`);
      const tally = block?.querySelector('.vote-tally');
      if (tally && event.consensus) {
        tally.classList.add('consensus');
        const head = tally.querySelector('.vote-head span');
        if (head) head.textContent = 'Consensus reached';
      }

      if (event.consensus) {
        toast(
          room.moderator.enabled
            ? 'The moderator has ruled the discussion finished. Use "Wrap up" for the conclusion.'
            : 'The room reached consensus. Use "Wrap up" for the conclusion.',
          'ok',
          8000,
        );
        selectedMode = 'synthesis';
      }

      // Refresh from disk so the transcript matches what was persisted.
      void api.rooms.get(room.id).then((fresh) => {
        if (fresh) room = fresh;
        update({});
      });
      break;
    }

    case 'room-status':
      if (event.conclusion && room) room.conclusion = event.conclusion;
      update({});
      break;

    case 'room-error':
      roundRunning = false;
      toast(event.message, 'error', 8000);
      update({});
      break;
  }
}

/** The owner's message for the round currently starting, for optimistic render. */
let pendingPrompt = '';

export function notePendingPrompt(message: string): void {
  pendingPrompt = message;
}

function scrollToBottom(force = false): void {
  if (!transcriptEl) return;
  if (force || pinnedToBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return truncate(url, 40);
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function teardownRoundtable(): void {
  unsubscribe?.();
  unsubscribe = null;
  transcriptEl = null;
  seatStripEl = null;
  composerEl = null;
  live.clear();
  liveModerator = null;
  rolesPanelEl = null;
}
