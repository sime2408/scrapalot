export interface RagTraceData {
  // From stream_end packet
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  costUsd?: number;
  latencyMs?: number;
  durationMs?: number;
  provider?: string;
  model?: string;
  // From rag_debug_info packet
  systemPromptPreview?: string;
  systemPromptLength?: number;
  contextDocumentCount?: number;
  contextTokenEstimate?: number;
  historyMessageCount?: number;
  hasConversationSummary?: boolean;
  contextWindowSize?: number;
  strategyName?: string;
  collectionNames?: string[];
}
