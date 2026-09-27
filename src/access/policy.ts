import type { Store } from '../db/store.js';
import type { AccessRequest, AuthStamp, Channel, Grant, Resources, Scope } from '../core/model.js';
import { AppError, ensure } from '../core/errors.js';
import { digest, id, now } from '../core/util.js';

export const agentSubject = (clientId: string) => `agent:${clientId}`;
export const imSubject = (channel: Pick<Channel,'id'|'identityVersion'>, tenant: string, user: string) => `im:${channel.id}:${channel.identityVersion}:${tenant}:${user}`;
export const emptyResources = (): Resources => ({ conversations: [], workspaces: [], sessions: [], futureSessions: false });
export interface ResourceCheck { conversationId?: string; workspace?: string; sessionId?: string }
export class Policy {
  onChange: () => void = () => {};
  constructor(private store: Store, private portalUrl: string) {}
  find(subject: string, channel: Pick<Channel,'id'|'identityVersion'>, scope: Scope, resource: ResourceCheck = {}): Grant | undefined {
    return this.store.list('grant').find(g => g.subject === subject && g.channelId === channel.id && g.identityVersion === channel.identityVersion &&
      g.state === 'active' && (!g.expiresAt || g.expiresAt > now()) && g.scopes.includes(scope) &&
      (!resource.conversationId || g.resources.conversations.includes(resource.conversationId)) &&
      (!resource.workspace || g.resources.workspaces.includes(resource.workspace)) &&
      (!resource.sessionId || g.resources.futureSessions || g.resources.sessions.includes(resource.sessionId)));
  }
  require(subject: string, channel: Pick<Channel,'id'|'identityVersion'>, scope: Scope, resource: ResourceCheck = {}): Grant {
    const grant = this.find(subject, channel, scope, resource);
    ensure(grant, 'ACCESS_DENIED', '当前身份在该渠道和资源范围内缺少有效授权。', 403);
    return grant;
  }
  check(stamp: AuthStamp) {
    const channel = this.store.get('channel', stamp.channelId);
    ensure(channel && channel.identityVersion === stamp.identityVersion && channel.state === 'enabled', 'ACCESS_REVOKED', '渠道已停用或身份已变化。', 403);
    for (const needed of stamp.required) {
      this.require(needed.subject, channel, needed.scope, stamp);
      for (const resource of stamp.resourceChecks ?? []) this.require(needed.subject, channel, needed.scope, { ...stamp, ...resource });
    }
  }
  request(input: Omit<AccessRequest,'id'|'state'|'revision'|'createdAt'|'expiresAt'>): AccessRequest {
    return this.store.transaction(() => {
      const key = digest({ subject: input.subject, channel: input.channelId, identity: input.identityVersion, scopes: [...input.scopes].sort(), resources: input.resources, proposal: input.proposalDigest });
      const proposed = id('apr'); const existingId = this.store.claim('access-request', key, proposed);
      const existing = this.store.get('request', existingId);
      if (existing) {
        if (existing.state === 'pending' && existing.expiresAt <= now()) { existing.state = 'expired'; existing.revision++; this.store.put('request', existing); }
        return existing;
      }
      const request: AccessRequest = { ...input, id: existingId, state: 'pending', revision: 1, createdAt: now(), expiresAt: now() + 86_400_000 };
      this.store.put('request', request); this.store.audit('access.requested', input.subject, request.id, { scopes: input.scopes, channelId: input.channelId });
      this.onChange(); return request;
    });
  }
  requireOrRequest(input: Omit<AccessRequest,'id'|'state'|'revision'|'createdAt'|'expiresAt'>, resource: ResourceCheck = {}) {
    if (input.scopes.every(scope => this.find(input.subject, { id: input.channelId, identityVersion: input.identityVersion }, scope, resource))) return;
    const request = this.request(input);
    if (request.state !== 'pending') throw new AppError('ACCESS_DENIED', '该申请已结束或授权已撤销，请在 Web 管理端重新审阅。', 403, { approval_request_id: request.id });
    throw new AppError('APPROVAL_REQUIRED', '请管理员在本地 Web Portal 批准首次访问。', 403, {
      approval_request_id: request.id, portal_url: `${this.portalUrl}/?approval=${encodeURIComponent(request.id)}`, requested_scopes: input.scopes,
    }, true);
  }
  approve(requestId: string, revision: number, selectedScopes: Scope[], resources: Resources): Grant {
    const grant = this.store.transaction(() => {
      const request = this.store.get('request', requestId);
      ensure(request && request.state === 'pending' && request.expiresAt > now(), 'APPROVAL_STATE_CONFLICT', '申请已结束或过期。', 409);
      ensure(request.revision === revision, 'APPROVAL_REVISION_CONFLICT', '申请已变更，请刷新审批页。', 409);
      const channel = this.store.get('channel', request.channelId);
      ensure(!channel || channel.identityVersion === request.identityVersion, 'APPROVAL_REVISION_CONFLICT', '渠道身份已变化，请重新申请。', 409);
      ensure(selectedScopes.length > 0 && selectedScopes.every(s => request.scopes.includes(s)), 'INVALID_SCOPES', '请选择申请范围内的权限。');
      ensure(resources.conversations.every(c => request.resources.conversations.includes(c)) && resources.workspaces.every(w => request.resources.workspaces.includes(w)) &&
        resources.sessions.every(s => request.resources.sessions.includes(s)) && (!resources.futureSessions || request.resources.futureSessions), 'INVALID_RESOURCE_SCOPE', '授权范围必须包含于申请范围。');
      const result: Grant = { id: id('grant'), requestId, subject: request.subject, channelId: request.channelId, identityVersion: request.identityVersion,
        scopes: selectedScopes, resources, state: 'active', revision: 1, approvedAt: now() };
      this.store.put('grant', result); request.state = 'approved'; request.revision++; this.store.put('request', request);
      this.store.audit('access.approved', 'web-admin', result.id, { requestId, scopes: selectedScopes, resources });
      if (request.subjectKind === 'im') {
        for (const conversationId of resources.conversations) {
          const c = this.store.get('conversation', conversationId);
          if (c && !c.alias) { c.alias = `dm-${c.id.slice(-8)}`; this.store.put('conversation', c); }
        }
      }
      return result;
    });
    this.onChange(); return grant;
  }
  deny(requestId: string, revision: number) {
    const request = this.store.get('request', requestId);
    ensure(request && request.state === 'pending' && request.revision === revision, 'APPROVAL_REVISION_CONFLICT', '申请状态已变化。', 409);
    request.state = 'denied'; request.revision++; this.store.put('request', request); this.store.audit('access.denied', 'web-admin', request.id); this.onChange();
  }
  revoke(grantId: string, revision: number) {
    const grant = this.store.get('grant', grantId);
    ensure(grant && grant.revision === revision, 'GRANT_REVISION_CONFLICT', '授权已变化，请刷新。', 409);
    grant.state = 'revoked'; grant.revision++; this.store.put('grant', grant); this.store.audit('access.revoked', 'web-admin', grantId); this.onChange();
  }
  invalidateChannel(channelId: string) {
    this.store.transaction(() => {
      for (const grant of this.store.list('grant').filter(g => g.channelId === channelId && g.state === 'active')) { grant.state = 'revoked'; grant.revision++; this.store.put('grant', grant); }
    });
    this.onChange();
  }
}
