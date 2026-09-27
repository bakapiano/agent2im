import type { Channel, Conversation, Outbox } from '../../core/model.js';
export interface ImEvent { eventId: string; messageId: string; tenantId: string; userId: string; chatId: string; chatType: string; text: string; replyTo?: string; displayName?: string; receivedAt: number; }
export type ImReceipt = { status: 'delivered'; messageId: string } | { status: 'unknown' | 'failed' | 'retryable'; reason: string; retryAfterMs?: number };
export interface ImConnection {
  start(onMessage: (message: ImEvent) => Promise<void>): Promise<void>;
  send(conversation: Conversation, message: Outbox): Promise<ImReceipt>;
  close(): Promise<void>;
  health(): { state: string; error?: string };
}
export interface ImFactory {
  validate(appId: string, secret: string): Promise<{ fingerprint: string; botId: string; tenantId?: string }>;
  create(channel: Channel, secret: string): ImConnection;
}
