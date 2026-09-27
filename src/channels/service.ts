import type { Store } from '../db/store.js';
import type { Vault } from '../credentials/vault.js';
import type { Policy } from '../access/policy.js';
import { agentSubject, emptyResources } from '../access/policy.js';
import type { Channel, Client } from '../core/model.js';
import type { ConfigureImChannelArgs } from '../../spec/contracts.js';
import type { ImConnection, ImEvent, ImFactory } from '../adapters/im/port.js';
import { AppError, ensure } from '../core/errors.js';
import { digest, id, now } from '../core/util.js';
import { KeyedLock } from '../core/lock.js';

export const safeChannel = (c: Channel) => ({ channel_id: c.id, channel_alias: c.alias, display_name: c.name, provider: 'feishu', app_id: c.appId,
  credential_configured: !!c.credentialRef, revision: c.revision, identity_version: c.identityVersion, state: c.state, last_error: c.lastError });

export class ChannelService {
  private lock = new KeyedLock();
  readonly connections = new Map<string, ImConnection>();
  onMessage: (channel: Channel, event: ImEvent) => Promise<void> = async () => {};
  onChange: () => void = () => {};
  constructor(private store: Store, private vault: Vault, private policy: Policy, private factory: ImFactory) {}
  list() { return this.store.list('channel').map(c => ({ ...safeChannel(c), health: this.connections.get(c.id)?.health() ?? { state: 'disconnected' } })); }
  private authorization(client: Client | undefined, channel: Pick<Channel,'id'|'identityVersion'>, args: ConfigureImChannelArgs, read = false) {
    if (!client) return;
    this.policy.requireOrRequest({ subject: agentSubject(client.id), subjectKind: 'agent', subjectLabel: client.name, channelId: channel.id, identityVersion: channel.identityVersion,
      scopes: read ? ['channel.read'] : ['channel.read','channel.configure'], resources: emptyResources(), proposal: { ...args }, proposalDigest: digest(args) });
  }
  async execute(args: ConfigureImChannelArgs, client?: Client): Promise<unknown> {
    return this.lock.run('configuration', () => this.executeLocked(args, client));
  }
  private async executeLocked(args: ConfigureImChannelArgs, client?: Client): Promise<unknown> {
    if (args.operation === 'approval_status') {
      const req = this.store.get('request', args.approval_request_id);
      ensure(req && (!client || req.subject === agentSubject(client.id)), 'ACCESS_DENIED', '该申请不可访问。', 403);
      const revoked = req.state === 'approved' && !this.store.list('grant').some(g => g.requestId === req.id && g.state === 'active');
      return { operation: args.operation, approval_request_id: req.id, status: revoked ? 'revoked' : req.state };
    }
    if (args.operation === 'inspect') {
      let channels = this.store.list('channel');
      if (args.channel_id) { const selected = channels.find(c => c.id === args.channel_id); ensure(selected, 'CHANNEL_NOT_FOUND', '渠道不存在。', 404); this.authorization(client, selected, args, true); channels = [selected]; }
      else if (client) channels = channels.filter(c => this.policy.find(agentSubject(client.id), c, 'channel.read'));
      return { operation: args.operation, provider: 'feishu', requirements: ['飞书自建应用机器人','App ID','Portal 安全录入的 credential_ref','长连接与 im.message.receive_v1','读取单聊消息及机器人发送权限'], channels: channels.map(safeChannel) };
    }
    let channel: Channel | undefined;
    if (args.operation === 'upsert') {
      channel = this.store.list('channel').find(c => c.alias === args.channel_alias);
      const channelId = channel?.id ?? this.store.claim('channel-alias', args.channel_alias, id('ch'));
      const version = channel?.identityVersion ?? 1;
      this.authorization(client, { id: channelId, identityVersion: version }, args);
      const requestDigest = digest(args); const memoId = `channel:${client?.id ?? 'admin'}:${args.idempotency_key}`;
      const memo = this.store.get('idempotency', memoId);
      if (memo) { ensure(memo.digest === requestDigest, 'IDEMPOTENCY_CONFLICT', '幂等键的配置载荷已变化。', 409); return memo.result; }
      ensure((channel?.revision ?? 0) === args.expected_revision, 'CONFIG_REVISION_CONFLICT', '渠道配置已变化，请刷新。', 409);
      this.vault.verify(args.credential_ref, 'feishu');
      const identityChanged = channel && channel.appId !== args.app_id;
      if (identityChanged && client) throw new AppError('CHANNEL_IDENTITY_CHANGE_REQUIRES_ADMIN', '应用身份变化请由 Web 管理员确认并重新审批。', 403);
      if (channel) await this.stop(channel.id);
      this.authorization(client, { id: channelId, identityVersion: version }, args);
      const result: Channel = { id: channelId, alias: args.channel_alias, name: args.display_name, appId: args.app_id, credentialRef: args.credential_ref,
        revision: (channel?.revision ?? 0) + 1, identityVersion: identityChanged ? version + 1 : version, state: 'draft', fingerprint: identityChanged ? undefined : channel?.fingerprint,
        botId: identityChanged ? undefined : channel?.botId, tenantId: identityChanged ? undefined : channel?.tenantId, createdAt: channel?.createdAt ?? now() };
      this.store.transaction(() => { this.store.put('channel', result); if (identityChanged) this.policy.invalidateChannel(channelId); });
      const response = { operation: args.operation, channel: safeChannel(result), diagnostics: ['配置已保存，请验证连接后启用。'] };
      this.store.put('idempotency', { id: memoId, digest: requestDigest, result: response }); this.store.audit('channel.saved', client?.id ?? 'web-admin', channelId, { revision: result.revision }); this.onChange(); return response;
    }
    channel = this.store.get('channel', args.channel_id);
    ensure(channel, 'CHANNEL_NOT_FOUND', '渠道不存在。', 404); this.authorization(client, channel, args);
    const memoId = `channel:${client?.id ?? 'admin'}:${args.idempotency_key}`; const requestDigest = digest(args);
    const memo = this.store.get('idempotency', memoId);
    if (memo) { ensure(memo.digest === requestDigest, 'IDEMPOTENCY_CONFLICT', '幂等键的载荷已变化。', 409); return memo.result; }
    ensure(channel.revision === args.expected_revision, 'CONFIG_REVISION_CONFLICT', '渠道配置已变化，请刷新。', 409);
    if (args.operation === 'validate') {
      const verified = await this.factory.validate(channel.appId, await this.vault.read(channel.credentialRef, 'feishu'));
      this.authorization(client, channel, args);
      await this.stop(channel.id);
      this.authorization(client, channel, args);
      ensure(this.store.get('channel', channel.id)?.revision === channel.revision, 'CONFIG_REVISION_CONFLICT', '验证期间配置已变化。', 409);
      if (channel.fingerprint && channel.fingerprint !== verified.fingerprint) {
        await this.stop(channel.id); channel.identityVersion++; this.policy.invalidateChannel(channel.id);
      }
      channel.fingerprint = verified.fingerprint; channel.botId = verified.botId; channel.tenantId = verified.tenantId;
      channel.state = 'validated'; channel.validationRevision = channel.revision + 1; channel.revision++; channel.lastError = undefined;
    } else {
      if (args.enabled) {
        ensure(channel.fingerprint && channel.validationRevision === channel.revision, 'CHANNEL_NOT_VALIDATED', '请验证当前版本后启用。');
        channel.state = 'enabled'; this.store.put('channel', channel);
        try { await this.start(channel); this.authorization(client, channel, args); }
        catch (error) { await this.stop(channel.id); channel.state = 'error'; channel.lastError = '启用失败，请重新验证'; this.store.put('channel', channel); throw error; }
      } else { await this.stop(channel.id); this.authorization(client, channel, args); channel.state = 'disabled'; }
      channel.revision++; if (channel.fingerprint) channel.validationRevision = channel.revision;
    }
    this.store.put('channel', channel);
    const response = { operation: args.operation, channel: safeChannel(channel), diagnostics: [] };
    this.store.put('idempotency', { id: memoId, digest: requestDigest, result: response }); this.store.audit(`channel.${args.operation}`, client?.id ?? 'web-admin', channel.id, { revision: channel.revision }); this.onChange(); return response;
  }
  async start(channel: Channel) {
    await this.stop(channel.id); const connection = this.factory.create(channel, await this.vault.read(channel.credentialRef, 'feishu'));
    this.connections.set(channel.id, connection);
    try { await connection.start(async event => {
      const live = this.store.get('channel', channel.id);
      // A closing/replaced socket may still deliver buffered events. Trust is
      // attached to the authenticated connection generation and app identity.
      if (this.connections.get(channel.id) === connection && live?.state === 'enabled' && live.identityVersion === channel.identityVersion && live.appId === channel.appId) await this.onMessage(live, event);
    }); }
    catch { this.connections.delete(channel.id); await connection.close(); throw new AppError('CHANNEL_CONNECTION_FAILED', '渠道连接失败，请核对凭据、网络和平台配置。'); }
  }
  async stop(channelId: string) { const connection = this.connections.get(channelId); this.connections.delete(channelId); if (connection) await connection.close(); }
  async restore() { for (const c of this.store.list('channel').filter(c => c.state === 'enabled')) { try { await this.start(c); } catch { c.lastError = '连接恢复失败'; this.store.put('channel', c); } } }
  async close() { for (const channelId of [...this.connections.keys()]) await this.stop(channelId); }
}
