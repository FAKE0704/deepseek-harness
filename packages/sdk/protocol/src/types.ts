/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: its
 * request/result pairs and server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock, ReasoningEffortId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Enable server-to-client approval/request calls; omission leaves existing answerers in control. */
  approvalRequests?: boolean
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: ReasoningEffortId
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
  /** Host-provided capabilities; omission retains native in-process answerers. */
  capabilities?: { userQuestions?: boolean }
}

/** Runtime-to-host request for one SDK-owned Session's structured user input. */
export interface SdkUserQuestionRequest {
  /** Correlates cancellation with this request independently of the JSON-RPC id. */
  requestId: string
  /** Session whose tool or approval is waiting. */
  sessionId: string
  /** Original questions, including any plan-review detail and presentation intent. */
  questions: AskUserQuestionItem[]
}

/** Host answers, one item per original question id. */
export type SdkUserQuestionAnswer = AskUserQuestionAnswer

/** Host answers or an explicit user dismissal; dismissal never means approval. */
export type SdkUserQuestionResult = SdkUserQuestionAnswer | { cancelled: true }

/** Runtime cancellation of a pending host question. Late answers are ignored. */
export interface SdkUserQuestionCancelled {
  /** Identity from the original question request. */
  requestId: string
  /** Session that stopped waiting. */
  sessionId: string
}

/** Runtime-to-host requests, handled independently of outbound Session requests. */
export interface HarnessSdkHostRequestMap {
  'user-question/ask': { params: SdkUserQuestionRequest; result: SdkUserQuestionResult }
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/** Delivery mode for one queued prompt, mirroring the gateway `session/prompt` contract. */
export type SessionPromptMode = 'followup' | 'steer'

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: SdkPromptContentBlock[]
  /**
   * Delivery target: `'followup'` (default) queues the message for the next
   * turn boundary; `'steer'` splices it into the next-step queue so an active
   * turn consumes it at its next step boundary. Unknown values fall back to
   * the default, so hosts never lose a message across kernel generations.
   */
  mode?: SessionPromptMode
}

/** Inline raster input admitted into the runtime's durable attachment store. */
export interface SdkEncodedImageBlock {
  type: 'image'
  /** Canonical base64-encoded raster bytes. */
  data: string
  /** Declared raster MIME type, verified during admission. */
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** Optional display name; never interpreted as a filesystem path. */
  name?: string
}

/** SDK prompt input: ordinary durable blocks plus inline images awaiting admission. */
export type SdkPromptContentBlock = ContentBlock | SdkEncodedImageBlock

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Content submitted through the SDK's ordinary-input and slash-command entry. */
export interface SessionQueryParams {
  /** SDK-owned Session identity; an unknown id creates its Agent. */
  sessionId: SessionId
  /** Ordered prompt blocks; a native command occupies its only text block and may accompany encoded images. */
  contentBlocks: SdkPromptContentBlock[]
}

/**
 * A prompt's enqueue receipt or a settled native command; neither means all Session work ended.
 * Command lifecycle notifications precede the command response on the same stream.
 * High-level command activity ends with its correlated session.query.completed notification.
 */
export type SessionQueryResult =
  | ({ kind: 'prompt' } & SessionPromptResult)
  | { kind: 'command'; execution: CommandExecution }

/** Native command outcome, including its logged lifecycle identity. */
export type { CommandExecution }

/** Restore a persisted session without enqueueing a prompt. */
export interface SessionResumeParams {
  /** Persisted session identity; missing or already owned sessions are rejected. */
  sessionId: string
}

/** Wait for an existing SDK session and its managed descendants to finish. */
export interface SessionWaitParams {
  /** An SDK-owned session id; waiting never creates a session. */
  sessionId: string
}

/** Session whose effective working directory is requested; an unknown id creates the Session. */
export interface SessionWorkingDirectoryParams {
  /** SDK-side Session identity. */
  sessionId: string
}

/** Change one Session's effective directory without changing its origin or permissions. */
export interface SessionWorkingDirectorySetParams extends SessionWorkingDirectoryParams {
  /** Directory to enter; relative paths resolve against the Session's current directory. */
  path: string
}

/** Validated effective directory after a read, change, or missing-directory recovery. */
export interface SessionWorkingDirectoryResult {
  /** Absolute directory used by future independent operations and new processes. */
  cwd: string
}

/** `session/interrupt` params: abort the target session's active activity. */
export interface SessionInterruptParams {
  /** The SDK-side session id; must already exist (interrupt never creates). */
  sessionId: string
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/**
 * One process-local assistant stream frame in its SDK wire form, isomorphic to
 * the session-controller history projection's `SessionAssistantStreamFrame`:
 * every LLM attempt publishes `start` → `chunk`* → `end` exactly once, frames
 * are live notifications only (never persisted), and the terminal `end` frame
 * settles the attempt — `committed` names the durable event that superseded
 * the streamed text, `abandoned` marks an attempt with no durable commit
 * (including interrupted prefixes that could not land).
 *
 * This face carries live deltas ONLY. Reconciliation is against the durable
 * `session.event` notification face, whose `event.seq` is the same
 * `@deepseek-ai/dsh-session` seq space: `startedAfterSeq` is the last durable
 * seq committed when the attempt started, so a host may either read that
 * cursor or track the last `session.event` seq itself; `end.outcome.seq`
 * names the committed durable event. No durable event is re-emitted here.
 */
export type SessionStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: string
    /** Monotone within one attached Agent lifecycle; replacement restarts at 1. */
    readonly revision: number
    /** Last durable session seq committed when this attempt started; -1 before any event. */
    readonly startedAfterSeq: number
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: string
    readonly revision: number
    /** Dense zero-based position within the attempt. */
    readonly index: number
    /** Safe-integer timestamp reused by the durable embedded stream. */
    readonly time: number
    readonly chunk: StreamChunk
  }
  | {
    readonly type: 'end'
    readonly attemptId: string
    readonly revision: number
    /** Number of chunk frames emitted by this attempt. */
    readonly index: number
    /** Durable settlement committed before this frame, or live abandonment without one. */
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: number
      }
      | { readonly kind: 'abandoned' }
  }

/** `session.stream` payload: one live assistant stream frame, forwarded as it publishes. */
export interface SessionStreamNotification {
  /** Session whose agent is streaming (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The frame in wire form. */
  frame: SessionStreamFrame
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'user-question.cancelled': SdkUserQuestionCancelled
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  /** Completion of a command query, including model activity and automatic goal rounds it starts. */
  'session.query.completed': {
    sessionId: SessionId
    commandId: CommandExecution['commandId']
    finalResponse: string
    finishReason: string
  }
  'session.stream': SessionStreamNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/query': { params: SessionQueryParams; result: SessionQueryResult }
  'session/resume': { params: SessionResumeParams; result: Record<string, never> }
  'session/wait': { params: SessionWaitParams; result: Record<string, never> }
  'session/working-directory/get': { params: SessionWorkingDirectoryParams; result: SessionWorkingDirectoryResult }
  'session/working-directory/set': { params: SessionWorkingDirectorySetParams; result: SessionWorkingDirectoryResult }
  'session/interrupt': { params: SessionInterruptParams; result: Record<string, never> }
  'shutdown': { params: undefined; result: Record<string, never> }
}

/** Internal approval projected to the SDK client without live runtime objects. */
export interface ApprovalRequestParams {
  /** Session owning the operation, including an in-process SDK descendant. */
  sessionId: string
  /** Tool whose operation needs approval. */
  toolName: string
  /** Exact tool call, when the asker supplied one. */
  callId?: string
  /** Asker-supplied explanation, when available. */
  reason?: string
}

/** One-shot client decision; grants never persist beyond this operation. */
export interface ApprovalRequestResult {
  /** Only allowed-once permits the operation. */
  outcome: 'allowed-once' | 'rejected' | 'cancelled'
}

/** Requests sent by the server after the client explicitly enables them. */
export interface HarnessSdkClientRequestMap {
  'approval/request': { params: ApprovalRequestParams; result: ApprovalRequestResult }
}
