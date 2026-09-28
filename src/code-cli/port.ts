import type { RuntimeLink, Job } from '../core/model.js';
import type { CodeCliProviderId } from './catalog.js';

export interface HostIdentity {
  pid: number;
  createdAt: string;
  executable: string;
}
export interface HostProcess extends HostIdentity {
  parentPid: number;
  commandLine: string;
}
export interface NativeContext {
  provider: CodeCliProviderId;
  threadId: string;
  homeId: string;
  owner: HostIdentity;
}
export interface RuntimeSnapshot {
  threadId: string;
  cwd: string;
  status: string;
  activeTurns: string[];
  activeFlags?: string[];
  executionState?: 'unobserved';
  controlMode?: 'queue_relay';
}
export interface RuntimeNotification {
  method: string;
  params: Record<string, any>;
}
export interface RuntimeStop {
  complete: boolean;
  scope: 'tracked_resources';
  interruptedTurns: number;
  cancelledNativeQueue: number;
  terminatedTerminals: number;
  residuals: Array<{ resourceId: string; reason: string }>;
}
export interface LiveRuntime {
  connect(): Promise<RuntimeSnapshot>;
  inspect(): Promise<RuntimeSnapshot>;
  submit(job: Job): Promise<{ queueId: string }>;
  cancelQueued(queueId: string): Promise<void>;
  stop(): Promise<RuntimeStop>;
  onEvent(listener: (event: RuntimeNotification) => void): void;
  close(): Promise<void>;
}
export interface RuntimeFactory {
  validateContext(context: NativeContext): void;
  create(link: RuntimeLink): LiveRuntime;
}
