/**
 * agent-to-IM v0.3 design contracts. Implementation follows docs/implementation-plan.md.
 * These interfaces describe business state; platform SDK types stay in adapters.
 */

export type SessionId = string;
export type ConversationId = string;
export type PrincipalId = string;
export type RuntimeId = string;
export type MessageId = string;
export type IsoDateTime = string;
export type PlatformId = string;

export type SessionState =
  | 'ready'
  | 'running'
  | 'waiting_user'
  | 'waiting_approval'
  | 'stopping'
  | 'stopped'
  | 'offline'
  | 'error'
  | 'stop_incomplete';

export type StopScope = 'owned_process_tree' | 'tracked_resources';
export type RuntimeHealth = 'online' | 'offline' | 'reconciling';
export type NativeHistoryState = 'pending_persistence' | 'resumable' | 'missing';
export type RuntimeOwner = 'none' | 'broker' | 'native_client' | 'unknown';
export type SessionWakePolicy = 'on_user_message' | 'manual_registration';

export interface PlatformIdentity {
  platform: PlatformId;
  accountId: string;
  tenantId: string;
  userId: string;
}

export interface ConversationAddress {
  platform: PlatformId;
  accountId: string;
  tenantId: string;
  chatId: string;
  kind: 'direct' | 'group' | 'thread';
  threadId?: string;
}

export interface AuthenticatedInboundEvent {
  eventId: string;
  platformMessageId: string;
  address: ConversationAddress;
  sender: PlatformIdentity;
  text: string;
  replyToPlatformMessageId?: string;
  occurredAt: IsoDateTime;
  receivedAt: IsoDateTime;
  authentication: 'platform_gateway' | 'verified_webhook';
  rawEvidenceRef: string;
}

export interface ConversationSelection {
  conversationId: ConversationId;
  principalId: PrincipalId;
  activeSessionId?: SessionId;
  revision: number;
}

export interface SessionRoute {
  sessionId: SessionId;
  conversationId: ConversationId;
  principalId: PrincipalId;
  address: ConversationAddress;
}

export interface NativeIdentity {
  agent: string;
  agentHomeId: string;
  nativeThreadId: string;
}

export interface SessionRecord {
  sessionId: SessionId;
  shortId: string;
  ownerId: PrincipalId;
  title: string;
  workspaceAlias: string;
  workingDirectory: string;
  /** Verified existing native identity, stable across registration and reconnection. */
  native: NativeIdentity;
  /** The current carrier process; absent while offline. */
  runtimeId?: RuntimeId;
  historyState: NativeHistoryState;
  runtimeOwner: RuntimeOwner;
  wakePolicy: SessionWakePolicy;
  controlEpoch: number;
  state: SessionState;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Added by the authenticated runtime/sidecar; supplied outside model arguments. */
export interface VerifiedCallerContext {
  ownerId: PrincipalId;
  localClient: VerifiedLocalClient;
  runtimeId: RuntimeId;
  native: NativeIdentity;
  nativeTurnId?: string;
  controlEpoch: number;
  descriptorId: string;
  verifiedAt: IsoDateTime;
}

export interface ImCapabilities {
  receiveMode: 'events' | 'poll';
  directMessages: boolean;
  groupMessages: boolean;
  replyReferences: boolean;
  providerIdempotency: boolean;
  maxTextCharacters: number;
  proactiveSend: 'allowed' | 'windowed';
}

export interface OutboundText {
  messageId: MessageId;
  idempotencyKey: string;
  route: SessionRoute;
  controlEpoch: number;
  authorization: AuthorizationStamp;
  text: string;
  purpose: 'notice' | 'progress' | 'result' | 'question' | 'control';
  replyToPlatformMessageId?: string;
  nativeTurnId?: string;
}

export type DeliveryReceipt =
  | { status: 'delivered'; platformMessageId: string; sentAt: IsoDateTime }
  | { status: 'retryable'; retryAfterMs?: number; reason: string }
  | { status: 'unknown'; reason: string }
  | { status: 'failed'; reason: string };

export interface ImAdapter {
  readonly platform: PlatformId;
  readonly accountId: string;
  readonly capabilities: ImCapabilities;
  /** Resolve sink only after durable ingress, so the adapter can acknowledge safely. */
  start(sink: (event: AuthenticatedInboundEvent) => Promise<void>): Promise<void>;
  send(message: OutboundText, signal: AbortSignal): Promise<DeliveryReceipt>;
  stop(): Promise<void>;
}

export interface RuntimeCapabilities {
  observeTurns: boolean;
  queueInputs: boolean;
  clearNativeQueue: boolean;
  interruptTurns: boolean;
  enumerateDescendants: boolean;
  cancelBackgroundTerminals: boolean;
  clearGoals: boolean;
  stopScope: StopScope;
}

export interface RuntimeHandle {
  runtimeId: RuntimeId;
  native: NativeIdentity;
  controlMode: 'queue_relay';
  endpointRef: string;
  processGeneration: string;
  capabilities: RuntimeCapabilities;
}

export interface RuntimeSnapshot {
  runtimeId: RuntimeId;
  health: RuntimeHealth;
  activeTurnIds: string[];
  nativeQueueIds: string[];
  descendants: NativeIdentity[];
  resources: OwnedResource[];
  observationComplete: boolean;
  observedAt: IsoDateTime;
}

export interface OwnedResource {
  resourceId: string;
  sessionId: SessionId;
  controlEpoch: number;
  nativeThreadId: string;
  parentResourceId?: string;
  kind: 'turn' | 'agent' | 'terminal' | 'process' | 'goal' | 'external_job';
  cancelHandleRef: string;
  ownershipEvidenceRef: string;
}

export interface AcceptedTask {
  jobId: string;
  sessionId: SessionId;
  controlEpoch: number;
  authorization: AuthorizationStamp;
  originMessageId: MessageId;
  text: string;
  selectedAtRevision: number;
  acceptedAt: IsoDateTime;
}

export type DispatchReceipt =
  | { status: 'accepted'; nativeTurnId?: string; nativeQueueId?: string }
  | { status: 'unknown'; reconciliationRef: string }
  | { status: 'rejected'; reason: string };

export interface RuntimeEvent {
  eventId: string;
  runtimeId: RuntimeId;
  nativeThreadId: string;
  nativeTurnId?: string;
  type:
    | 'turn_started'
    | 'turn_completed'
    | 'queue_changed'
    | 'final_message'
    | 'approval_pending'
    | 'resource_created'
    | 'resource_ended'
    | 'runtime_closed';
  payload: Readonly<Record<string, unknown>>;
  observedAt: IsoDateTime;
}

export interface StopPlan {
  operationId: string;
  sessionId: SessionId;
  cancelledEpoch: number;
  fenceEpoch: number;
  root: NativeIdentity;
  resources: OwnedResource[];
  graceDeadline: IsoDateTime;
}

export interface StopReport {
  operationId: string;
  sessionId: SessionId;
  scope: StopScope;
  complete: boolean;
  cancelledJobs: number;
  cancelledWaits: number;
  interruptedTurns: number;
  terminatedProcesses: number;
  residuals: Array<{ resourceId: string; reason: string; nextAction: string }>;
  finishedAt: IsoDateTime;
}

export interface AgentRuntimeAdapter {
  readonly agent: string;
  attach(descriptorId: string, ownerId: PrincipalId): Promise<RuntimeHandle>;
  inspect(handle: RuntimeHandle): Promise<RuntimeSnapshot>;
  submit(handle: RuntimeHandle, task: AcceptedTask): Promise<DispatchReceipt>;
  events(handle: RuntimeHandle, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  stopWorkTree(handle: RuntimeHandle, plan: StopPlan): Promise<StopReport>;
}

export interface RegisterArgs {
  connection_alias?: string;
  title: string;
  idempotency_key: string;
  native_thread_id?: string;
  activate?: boolean;
}

export interface RegisterResult {
  session_id: SessionId;
  short_id: string;
  title: string;
  connection_id: ConversationId;
  runtime_id: RuntimeId;
  native_thread_id: string;
  control_mode: 'queue_relay';
  stop_scope: StopScope;
  active: boolean;
  control_epoch: number;
}

export interface SendMessageArgs {
  job_id?: string;
  session_id: SessionId;
  text: string;
  idempotency_key: string;
  purpose?: 'notice' | 'progress' | 'result';
}

export interface SendMessageResult {
  message_id: MessageId;
  session_id: SessionId;
  conversation_id: ConversationId;
  delivery_status: 'queued' | 'delivered' | 'unknown';
  platform_message_id?: string;
}

export type WaitForUserArgs = {
  session_id: SessionId;
  request_key: string;
  timeout_seconds?: number;
} & (
  | { mode: 'ask'; prompt: string; reply_ttl_seconds?: number }
  | { mode: 'resume'; prompt?: never; reply_ttl_seconds?: never }
);

export interface UserReply {
  message_id: MessageId;
  platform_message_id: string;
  principal_id: PrincipalId;
  text: string;
  received_at: IsoDateTime;
}

export type WaitForUserResult = {
  session_id: SessionId;
  request_id: string;
  question_short_id: string;
} & (
  | { status: 'answered'; reply: UserReply }
  | { status: 'waiting'; expires_at: IsoDateTime }
  | { status: 'expired' }
  | { status: 'cancelled'; reason: string }
  | { status: 'delivery_failed'; reason: string }
);

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export interface VerifiedLocalClient {
  clientId: string;
  installationId: string;
  osUserId: string;
  credentialRecordId: string;
  verifiedAt: IsoDateTime;
}

export type AccessSubject = { kind: 'im_user'; identity: PlatformIdentity };

export interface AccessGrant {
  grantId: string;
  subject: AccessSubject;
  channelId: string;
  channelIdentityVersion: number;
  conversationId: ConversationId;
  status: 'active' | 'revoked';
  revision: number;
  approvedBy: string;
  approvedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

/** Snapshots are audit references; execution checks current stored grants again. */
export interface AuthorizationStamp {
  channelId: string;
  channelIdentityVersion: number;
  requiredGrants: Array<{ grantId: string; revision: number }>;
}

export interface AccessRequest {
  requestId: string;
  subject: AccessSubject;
  channelId: string;
  conversationId: ConversationId;
  revision: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  requestedAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

export interface SanitizedImChannel {
  channel_id: string;
  channel_alias: string;
  display_name: string;
  provider: string;
  app_id: string;
  credential_configured: boolean;
  revision: number;
  identity_version: number;
  state: 'draft' | 'validated' | 'enabled' | 'disabled' | 'error';
}

export type ConfigureImChannelArgs =
  | { operation: 'inspect'; provider: 'feishu' | 'wechat' | 'qq'; channel_id?: string }
  | {
      operation: 'upsert';
      provider: 'feishu';
      channel_alias: string;
      display_name: string;
      app_id: string;
      credential_ref: string;
      expected_revision: number;
      idempotency_key: string;
    }
  | { operation: 'validate'; channel_id: string; expected_revision: number; idempotency_key: string }
  | {
      operation: 'set_enabled';
      channel_id: string;
      enabled: boolean;
      expected_revision: number;
      idempotency_key: string;
    };

export type ConfigureImChannelResult =
  | { operation: 'inspect'; provider: string; requirements: string[]; channels: SanitizedImChannel[] }
  | { operation: 'upsert' | 'validate' | 'set_enabled'; channel: SanitizedImChannel; diagnostics: string[] };

/** Constructed by the Web authentication/CSRF middleware, outside request bodies. */
export interface VerifiedWebAdmin {
  adminId: string;
  adminSessionId: string;
  authenticatedAt: IsoDateTime;
  csrfVerified: true;
}

/** Web-only control plane. This interface is deliberately separate from MCP tools. */
export interface WebApprovalService {
  approve(requestId: string, expectedRevision: number, admin: VerifiedWebAdmin): Promise<AccessGrant>;
  deny(requestId: string, expectedRevision: number, admin: VerifiedWebAdmin): Promise<void>;
  revoke(grantId: string, expectedRevision: number, admin: VerifiedWebAdmin): Promise<void>;
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

export interface AgentToImTools {
  configureImChannel(
    args: ConfigureImChannelArgs,
    caller: VerifiedLocalClient,
  ): Promise<ToolResult<ConfigureImChannelResult>>;
  register(args: RegisterArgs, caller: VerifiedCallerContext): Promise<ToolResult<RegisterResult>>;
  sendMessageToUser(
    args: SendMessageArgs,
    caller: VerifiedCallerContext,
  ): Promise<ToolResult<SendMessageResult>>;
  waitForUserMessage(
    args: WaitForUserArgs,
    caller: VerifiedCallerContext,
    signal: AbortSignal,
  ): Promise<ToolResult<WaitForUserResult>>;
}
