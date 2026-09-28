import { feishu } from './feishu/provider.js';
import { wechat } from './wechat/provider.js';
import { qq } from './qq/provider.js';

export const imProviders = [feishu, wechat, qq] as const;
export type ImProviderId = (typeof imProviders)[number]['id'];
