/**
 * Types shared by the main process, the preload bridge, and the renderer.
 * Keep this file free of Node and DOM imports — it is bundled into all three.
 */

export type ProviderId = 'glm' | 'anthropic' | 'openai';

/**
 * How a request reaches the model.
 *
 *  - `api` talks to the vendor's HTTP endpoint with an API key.
 *  - `cli` shells out to the vendor's own agent CLI (`claude`, `codex`), which
 *    means subscription logins (Claude Pro/Max, ChatGPT Plus/Pro) work without
 *    this app ever handling those credentials.
 */
export type Transport = 'api' | 'cli';

export type AuthMethod = 'api-key' | 'cli-session' | 'none';

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Chain-of-thought text, when the model exposes it separately. */
  reasoning?: string;
  createdAt: number;
  /** Populated on assistant messages once the turn completes. */
  meta?: MessageMeta;
  error?: string;
}

export interface MessageMeta {
  provider: ProviderId;
  model: string;
  transport: Transport;
  inputTokens?: number;
  outputTokens?: number;
  /** Wall-clock milliseconds from request to final token. */
  durationMs?: number;
  /** Tool invocations reported by a CLI transport. */
  tools?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  transport: Transport;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /**
   * CLI transports keep their own server-side session. Storing the id lets a
   * conversation resume with full context instead of replaying the transcript.
   */
  cliSessionId?: string;
  /** Working directory handed to CLI transports. */
  cwd?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  updatedAt: number;
  messageCount: number;
}

/* ----------------------------------------------------------- requests ----- */

export interface ChatRequest {
  conversationId: string;
  provider: ProviderId;
  model: string;
  transport: Transport;
  messages: ChatMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask reasoning-capable models to emit their thinking. */
  thinking?: boolean;
  /** CLI transports only. */
  cwd?: string;
  cliSessionId?: string;
}

export type StreamEvent =
  | { type: 'start'; streamId: string }
  | { type: 'reasoning'; streamId: string; text: string }
  | { type: 'text'; streamId: string; text: string }
  | {
      type: 'tool';
      streamId: string;
      name: string;
      detail?: string;
      /** Search terms, when the tool was a web search. */
      query?: string;
      /** Page fetched, when the tool was a fetch. The UI links to it. */
      url?: string;
    }
  | { type: 'session'; streamId: string; sessionId: string }
  | { type: 'usage'; streamId: string; inputTokens?: number; outputTokens?: number }
  | { type: 'done'; streamId: string; finishReason?: string; durationMs: number }
  | { type: 'error'; streamId: string; message: string; hint?: string };

/* ----------------------------------------------------------- settings ----- */

export interface ProviderSettings {
  /** Whether the provider shows up in the model picker. */
  enabled: boolean;
  /** Overrides the built-in default; blank means "use the default". */
  baseUrl: string;
  /** Region/endpoint preset. GLM only; ignored elsewhere. */
  endpointPreset?: GlmEndpointPreset;
  defaultModel: string;
  transport: Transport;
  /** Extra headers, e.g. for a corporate gateway. */
  headers?: Record<string, string>;
  /** Absolute path to the CLI binary, when it is not on PATH. */
  cliPath?: string;
}

export type GlmEndpointPreset = 'zai-global' | 'zai-coding' | 'bigmodel-cn' | 'custom';

export interface AppSettings {
  version: number;
  theme: 'dark' | 'light' | 'system';
  fontSize: number;
  defaultProvider: ProviderId;
  /** Sent as the system prompt when a conversation does not override it. */
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  /** Default working directory for agent terminals and CLI transports. */
  workspaceDir: string;
  sendOnEnter: boolean;
  providers: Record<ProviderId, ProviderSettings>;
}

/* --------------------------------------------------------------- auth ----- */

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  /** True when at least one usable credential is present. */
  ready: boolean;
  authMethod: AuthMethod;
  /** Masked key such as `sk-…f21a`, for display only. */
  maskedKey?: string;
  /** Where the credential came from: keyring, env var, or a CLI's own store. */
  source?: string;
  cli: CliStatus;
  detail?: string;
}

export interface CliStatus {
  /** Binary name, e.g. `claude`. */
  command: string;
  installed: boolean;
  path?: string;
  version?: string;
  /** True when the CLI has its own logged-in session on disk. */
  loggedIn: boolean;
  accountHint?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  message: string;
  hint?: string;
}

/* ------------------------------------------------------------- models ----- */

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  label: string;
  /** Short description shown under the name in the picker. */
  note?: string;
  contextWindow?: number;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  /** Recommended default for its provider. */
  recommended?: boolean;
}

/* ---------------------------------------------------------- terminal ------ */

export interface TerminalSpec {
  /** Which backend's CLI to launch. */
  provider: ProviderId;
  /** `agent` runs the coding CLI; `shell` opens a plain login shell. */
  kind: 'agent' | 'shell';
  cwd: string;
  cols: number;
  rows: number;
  /** Extra CLI arguments, e.g. `--model`. */
  args?: string[];
}

export interface TerminalInfo {
  id: string;
  spec: TerminalSpec;
  /** Command line actually executed, for the UI to display. */
  commandLine: string;
  /** True when running through a real pty; false means degraded pipe mode. */
  pty: boolean;
  startedAt: number;
}

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; code: number | null; signal?: string }
  | { type: 'error'; id: string; message: string };

/* ---------------------------------------------------------- diagnostics --- */

export interface Diagnostics {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  configDir: string;
  dataDir: string;
  secretsBackend: 'keyring' | 'file';
  ptyAvailable: boolean;
  providers: ProviderStatus[];
}
