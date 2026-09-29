import type { ImProviderId } from '../im/catalog.js';
import type { CodeCliProviderId } from '../code-cli/catalog.js';

export interface Client {
  id: string;
  name: string;
  secretHash: string;
  installationId: string;
  osUser: string;
  state: 'active' | 'revoked';
  createdAt: number;
}
export interface Credential {
  id: string;
  owner: string;
  purpose: ImProviderId;
  ciphertext: string;
  createdAt: number;
}
export interface Channel {
  id: string;
  provider: ImProviderId;
  alias: string;
  name: string;
  appId: string;
  credentialRef: string;
  revision: number;
  identityVersion: number;
  state: 'draft' | 'validated' | 'enabled' | 'disabled' | 'error';
  fingerprint?: string;
  validationRevision?: number;
  botId?: string;
  tenantId?: string;
  lastError?: string;
  createdAt: number;
}
export interface Conversation {
  id: string;
  channelId: string;
  identityVersion: number;
  tenantId: string;
  userId: string;
  chatId: string;
  displayName: string;
  alias?: string;
  createdAt: number;
}
export interface AccessRequest {
  id: string;
  subject: string;
  subjectLabel: string;
  channelId: string;
  identityVersion: number;
  conversationId: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  revision: number;
  createdAt: number;
  expiresAt: number;
}
export interface Grant {
  id: string;
  requestId: string;
  subject: string;
  channelId: string;
  identityVersion: number;
  conversationId: string;
  state: 'active' | 'revoked';
  revision: number;
  approvedAt: number;
  expiresAt?: number;
}
export interface RuntimeLink {
  id: string;
  provider: CodeCliProviderId;
  clientId: string;
  threadId: string;
  homeId: string;
  cwd: string;
  workspace: string;
  owner: { pid: number; createdAt: string; executable: string };
  createdAt: number;
}
export interface Session {
  id: string;
  provider: CodeCliProviderId;
  shortId: string;
  title: string;
  clientId: string;
  runtimeId: string;
  threadId: string;
  homeId: string;
  cwd: string;
  workspace: string;
  channelId: string;
  conversationId: string;
  epoch: number;
  state:
    | 'ready'
    | 'running'
    | 'waiting_user'
    | 'waiting_approval'
    | 'stopping'
    | 'stopped'
    | 'offline'
    | 'error'
    | 'stop_incomplete';
  createdAt: number;
  lastSeenAt: number;
}
export interface AuthStamp {
  channelId: string;
  identityVersion: number;
  subject: string;
  conversationId: string;
}
export interface Inbox {
  id: string;
  channelId: string;
  conversationId: string;
  platformMessageId: string;
  text: string;
  replyTo?: string;
  receivedAt: number;
  targetSessionId?: string;
  state: 'received' | 'consumed' | 'queued' | 'rejected';
}
export interface Job {
  id: string;
  sessionId: string;
  epoch: number;
  inboxId: string;
  prompt: string;
  state:
    'queued' | 'dispatching' | 'queued_native' | 'completed' | 'cancelled' | 'unknown' | 'failed';
  auth: AuthStamp;
  nativeTurnId?: string;
  nativeQueueId?: string;
  createdAt: number;
  error?: string;
}
export interface Outbox {
  id: string;
  sessionId?: string;
  epoch?: number;
  channelId: string;
  conversationId: string;
  text: string;
  purpose: 'notice' | 'progress' | 'result' | 'question' | 'control' | 'access_notice';
  state: 'queued' | 'sending' | 'delivered' | 'unknown' | 'failed' | 'cancelled';
  auth?: AuthStamp;
  platformMessageId?: string;
  replyTo?: string;
  businessKey: string;
  payloadDigest: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  nativeTurnId?: string;
  error?: string;
}
export interface WaitRequest {
  id: string;
  shortId: string;
  sessionId: string;
  epoch: number;
  conversationId: string;
  requestKey: string;
  prompt: string;
  payloadDigest: string;
  outboxId: string;
  state: 'open' | 'answered' | 'expired' | 'cancelled' | 'delivery_failed';
  auth: AuthStamp;
  createdAt: number;
  expiresAt: number;
  reason?: string;
  reply?: {
    message_id: string;
    platform_message_id: string;
    principal_id: string;
    text: string;
    received_at: string;
  };
}
export interface StopRecord {
  id: string;
  sessionId: string;
  state: 'running' | 'completed' | 'incomplete';
  report?: Record<string, unknown>;
  createdAt: number;
}
export interface Idempotency {
  id: string;
  digest: string;
  result: unknown;
}
export interface AdminSession {
  id: string;
  csrf: string;
  createdAt: number;
  expiresAt: number;
}
export interface Config {
  dataDir: string;
  portalHost: string;
  portalPort: number;
  agentPort: number;
  workspaces: Record<string, string>;
  webRoot: string;
}
export interface Kinds {
  client: Client;
  credential: Credential;
  channel: Channel;
  conversation: Conversation;
  request: AccessRequest;
  grant: Grant;
  runtime: RuntimeLink;
  session: Session;
  inbox: Inbox;
  job: Job;
  outbox: Outbox;
  wait: WaitRequest;
  stop: StopRecord;
  idempotency: Idempotency;
  adminSession: AdminSession;
  setting: { id: string; value: unknown };
}
export type Kind = keyof Kinds;
