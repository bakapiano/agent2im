import { ensure } from '../core/errors.js';
import { codeCliProviders, type CodeCliProviderId } from './catalog.js';
import type { NativeContext, RuntimeFactory } from './port.js';
import type { RuntimeLink } from '../core/model.js';

export class CodeCliRegistry {
  constructor(private factories: Partial<Record<CodeCliProviderId, RuntimeFactory>>) {}

  list() {
    return codeCliProviders.map((provider) => ({
      ...provider,
      status: this.factories[provider.id] ? 'ready' : 'planned',
    }));
  }

  get(id: CodeCliProviderId): RuntimeFactory {
    const provider = this.list().find((provider) => provider.id === id);
    ensure(provider, 'CODE_CLI_PROVIDER_UNKNOWN', 'Code CLI 平台标识无效。');
    const factory = this.factories[id];
    ensure(factory, 'CODE_CLI_PROVIDER_PLANNED', `${provider.displayName} 接入处于调研阶段。`);
    return factory;
  }

  validateContext(context: NativeContext) {
    this.get(context.provider).validateContext(context);
  }

  create(link: RuntimeLink) {
    return this.get(link.provider).create(link);
  }
}
