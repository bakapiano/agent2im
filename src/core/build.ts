declare const __AGENT_IM_BUILD_ID__: string | undefined;
export const buildId = typeof __AGENT_IM_BUILD_ID__ === 'string' ? __AGENT_IM_BUILD_ID__ : 'source';
export const appVersion = '0.3.0';
