import type { ChatRequest, ConnectionTestResult, ModelInfo, StreamEvent } from '@shared/types';

export interface ProviderContext {
  streamId: string;
  signal: AbortSignal;
  emit: (event: StreamEvent) => void;
}

export interface ProviderAdapter {
  /** Streams a completion, emitting events until it returns. */
  stream(request: ChatRequest, ctx: ProviderContext): Promise<void>;
  /** Cheap round trip used by the "Test connection" button. */
  test(): Promise<ConnectionTestResult>;
  /** Live model list from the vendor, when the endpoint exposes one. */
  listModels?(): Promise<ModelInfo[]>;
}

export class MissingCredentialsError extends Error {
  constructor(readonly hint: string) {
    super('No credentials configured');
    this.name = 'MissingCredentialsError';
  }
}
