import { codex } from './codex/provider.js';
import { claude } from './claude/provider.js';
import { ghcp } from './ghcp/provider.js';

export const codeCliProviders = [codex, claude, ghcp] as const;
export type CodeCliProviderId = (typeof codeCliProviders)[number]['id'];
