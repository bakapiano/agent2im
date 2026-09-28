import { ensure } from '../core/errors.js';
import { imProviders, type ImProviderId } from './catalog.js';
import type { ImFactory } from './port.js';

/** One registry per Broker; each connection is still scoped to a channel identity. */
export class ImRegistry {
  constructor(private factories: Partial<Record<ImProviderId, ImFactory>>) {}

  list() {
    return imProviders.map((provider) => ({
      ...provider,
      status: this.factories[provider.id] ? 'ready' : 'planned',
    }));
  }

  describe(id: ImProviderId) {
    const provider = this.list().find((provider) => provider.id === id);
    ensure(provider, 'IM_PROVIDER_UNKNOWN', 'IM 平台标识无效。');
    return provider;
  }

  get(id: ImProviderId): ImFactory {
    const provider = this.describe(id);
    const factory = this.factories[id];
    ensure(factory, 'IM_PROVIDER_PLANNED', `${provider.displayName} 渠道处于扩展规划阶段。`);
    return factory;
  }
}
