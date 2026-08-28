import type { ChatRequest } from '@shared/types';
import type { CliCapabilities } from '../agents/cli-detect';

/**
 * Argument construction for the Claude Code CLI.
 *
 * Kept separate from cli.ts, which reaches Electron through the secret and
 * settings stores: this is pure and therefore testable, and the arguments are
 * exactly where a mistake is expensive — an unrecognised flag makes the CLI
 * exit non-zero and the turn is lost.
 */

/**
 * Tools that make Claude Code behave like a coding agent rather than a peer.
 *
 * `ToolSearch` and `Skill` are on the list because they are loaders: left
 * enabled, they pull the others back in one at a time. A name the running
 * build does not know is a warning on stderr, not an error, so listing a tool
 * that a given release has renamed or dropped costs nothing.
 */
const CODING_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Task',
  'TodoWrite',
  'ToolSearch',
  'Skill',
];
const RESEARCH_TOOLS = ['WebSearch', 'WebFetch'];

export function claudeArgs(req: ChatRequest, capabilities: CliCapabilities): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose'];

  // Partial messages give token-level deltas instead of one block at the end.
  if (capabilities.partialMessages) args.push('--include-partial-messages');
  if (req.model) args.push('--model', req.model);
  // Resuming keeps the CLI's own context instead of replaying the transcript.
  if (req.cliSessionId) args.push('--resume', req.cliSessionId);

  const policy = req.toolPolicy ?? 'full';
  if (policy !== 'full') args.push(...toolArgs(policy, capabilities));

  const system = req.systemPrompt?.trim();
  if (policy !== 'full' && capabilities.systemPrompt) {
    // Replacing rather than appending is the whole point: appending leaves the
    // coding system prompt in place, and the model keeps behaving like a
    // coding agent no matter what is added after it.
    args.push('--system-prompt', discussionSystemPrompt(system, policy));
    // The default prompt carries cwd, git status and memory paths, which pull
    // the model back toward the repository it happens to be sitting in.
    if (capabilities.excludeDynamicSections) args.push('--exclude-dynamic-system-prompt-sections');
  } else if (system && capabilities.appendSystemPrompt) {
    args.push('--append-system-prompt', system);
  }

  return args;
}


/**
 * Cuts the toolset down for a discussion turn.
 *
 * `--allowedTools` is the wrong flag and looks like the right one. It is a
 * *permission* allowlist — it auto-approves what it names and leaves everything
 * else in the toolset. Asked directly, a seat launched with
 * `--allowedTools WebSearch WebFetch` reports 42 available tools, Bash, Edit,
 * Write and Read among them, pointed at the user's workspace.
 *
 * `--tools` is the flag that removes tools from the set ("" for none), and
 * `--restricted` additionally makes the CLI ignore the user's own settings
 * files, so a permissive allowlist in ~/.claude cannot put the coding tools
 * back. Together they report 2 tools for a research seat and 0 for a chat turn.
 *
 * Older builds have neither, so `--disallowedTools` remains as a fallback. It
 * is a real reduction — Bash, Edit, Write, Read, Glob, Grep and Task all go —
 * but it is a denylist, so anything a future release adds arrives enabled.
 */
function toolArgs(policy: 'none' | 'research', capabilities: CliCapabilities): string[] {
  const args: string[] = [];
  const wanted = policy === 'research' ? RESEARCH_TOOLS : [];

  if (capabilities.tools) {
    // `--restricted` also confines the file tools to the working directory,
    // which matters for the fallback path below more than for this one.
    if (capabilities.restricted) args.push('--restricted');
    args.push('--tools', ...(wanted.length ? wanted : ['']));
    // Named in the toolset, still permission-gated: allow them explicitly so a
    // research seat is not stopped by a prompt nobody is there to answer.
    if (wanted.length && capabilities.allowedTools) args.push('--allowedTools', ...wanted);
    return args;
  }

  if (capabilities.disallowedTools) {
    args.push('--disallowedTools', ...CODING_TOOLS, ...(policy === 'none' ? RESEARCH_TOOLS : []));
  }
  if (wanted.length && capabilities.allowedTools) args.push('--allowedTools', ...wanted);
  return args;
}

/**
 * The system prompt that replaces Claude Code's coding prompt for chat and
 * discussion turns.
 */
export function discussionSystemPrompt(caller: string | undefined, policy: 'none' | 'research'): string {
  const lines = [
    'You are taking part in a conversation, not working on a coding task.',
    'Think carefully and answer directly. Reason about the substance of what is asked rather than looking for something to edit or run.',
    policy === 'research'
      ? 'You may search the web and fetch pages when a claim needs checking. You have no other tools.'
      : 'You have no tools. Reason from what you know, and say when you are uncertain.',
    'Do not describe what you are about to do, and do not offer to make changes to files.',
  ];
  if (caller) lines.push('', caller);
  return lines.join('\n');
}


/* ----------------------------------------------------------------- kimi -- */

/**
 * Argument construction for the Kimi Code CLI.
 *
 * Kimi's print mode emits whole messages rather than token deltas, which the
 * stream parser already handles — it is the same path an older Claude Code
 * build takes.
 *
 * Tool restriction works differently again: there is no `--tools` flag, but
 * `--agent-file` replaces the whole agent specification, and a spec names its
 * tools explicitly as an allowlist. So a discussion turn hands it a generated
 * spec with the system prompt replaced and `tools` cut to nothing (chat) or to
 * web search and fetch (research) — the same two policies as everywhere else.
 */
export function kimiArgs(
  req: ChatRequest,
  options: { agentFile?: string } = {},
): string[] {
  const args = ['--print', '--output-format', 'stream-json'];

  if (req.model) args.push('--model', req.model);
  // Thinking is a tri-state in Kimi: unset means "whatever the config says",
  // so both branches are stated rather than only the on one.
  args.push(req.thinking ? '--thinking' : '--no-thinking');
  if (req.cwd) args.push('--work-dir', req.cwd);
  if (options.agentFile) args.push('--agent-file', options.agentFile);

  return args;
}

/** The two tool sets a generated Kimi agent spec may name. */
export const KIMI_RESEARCH_TOOLS = ['kimi_cli.tools.web:SearchWeb', 'kimi_cli.tools.web:FetchURL'];

/**
 * A Kimi agent specification for a discussion turn.
 *
 * `tools` is an allowlist of fully-qualified tool classes, so an empty list is
 * genuinely no tools — the same guarantee `--tools ""` gives Claude Code, and
 * for the same reason: a discussant that can edit the user's files is not a
 * discussant.
 */
export function kimiAgentSpec(
  systemPromptPath: string,
  policy: 'none' | 'research',
): string {
  const tools = policy === 'research' ? KIMI_RESEARCH_TOOLS : [];
  return [
    'version: 1',
    'agent:',
    '  name: ""',
    `  system_prompt_path: ${JSON.stringify(systemPromptPath)}`,
    `  tools: [${tools.map((t) => JSON.stringify(t)).join(', ')}]`,
    '  subagents: {}',
    '',
  ].join('\n');
}
