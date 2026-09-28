import type { Store } from '../db/store.js';
import type { AccessRequest, AuthStamp, Channel, Grant } from '../core/model.js';
import { ensure } from '../core/errors.js';
import { digest, id, now } from '../core/util.js';

export const imSubject = (channel: Pick<Channel,'id'|'identityVersion'>, tenant: string, user: string) => `im:${channel.id}:${channel.identityVersion}:${tenant}:${user}`;
export class Policy {
  onChange: () => void = () => {};
  constructor(private store: Store) {}
  find(subject: string, channel: Pick<Channel,'id'|'identityVersion'>, conversationId: string): Grant | undefined {
    return this.store.list('grant').find(g => g.subject === subject && g.channelId === channel.id &&
      g.identityVersion === channel.identityVersion && g.conversationId === conversationId &&
      g.state === 'active' && (!g.expiresAt || g.expiresAt > now()));
  }
  require(subject: string, channel: Pick<Channel,'id'|'identityVersion'>, conversationId: string): Grant {
    const grant = this.find(subject, channel, conversationId);
    ensure(grant, 'ACCESS_DENIED', '该 IM 使用者尚未获准互动，或授权已结束。', 403);
    return grant;
  }
  check(stamp: AuthStamp) {
    const channel = this.store.get('channel', stamp.channelId);
    ensure(channel && channel.identityVersion === stamp.identityVersion && channel.state === 'enabled', 'ACCESS_REVOKED', '渠道已停用或身份已变化。', 403);
    this.require(stamp.subject, channel, stamp.conversationId);
  }
  request(input: Omit<AccessRequest,'id'|'state'|'revision'|'createdAt'|'expiresAt'>): AccessRequest {
    const conversation=this.store.get('conversation',input.conversationId);
    ensure(conversation && input.subject===imSubject({id:input.channelId,identityVersion:input.identityVersion},conversation.tenantId,conversation.userId) &&
      conversation.channelId===input.channelId && conversation.identityVersion===input.identityVersion,
      'IM_IDENTITY_INVALID','审批申请必须对应实际 IM 使用者。',403);
    return this.store.transaction(() => {
      const key = digest({subject:input.subject,channel:input.channelId,identity:input.identityVersion,conversation:input.conversationId});
      const existingId = this.store.claim('im-access-request', key, id('apr'));
      const existing = this.store.get('request', existingId);
      if(existing) {
        if(existing.state==='pending' && existing.expiresAt<=now()) {existing.state='expired';existing.revision++;this.store.put('request',existing);}
        return existing;
      }
      const request:AccessRequest={...input,id:existingId,state:'pending',revision:1,createdAt:now(),expiresAt:now()+86_400_000};
      this.store.put('request',request);this.store.audit('access.requested',input.subject,request.id,{channelId:input.channelId,conversationId:input.conversationId});
      this.onChange();return request;
    });
  }
  approve(requestId:string,revision:number):Grant {
    const grant=this.store.transaction(()=>{
      const request=this.store.get('request',requestId);
      ensure(request && request.state==='pending' && request.expiresAt>now(),'APPROVAL_STATE_CONFLICT','申请已结束或过期。',409);
      ensure(request.revision===revision,'APPROVAL_REVISION_CONFLICT','申请已变更，请刷新。',409);
      const channel=this.store.get('channel',request.channelId);
      const conversation=this.store.get('conversation',request.conversationId);
      ensure(channel && channel.identityVersion===request.identityVersion && conversation?.channelId===channel.id &&
        conversation.identityVersion===channel.identityVersion && request.subject===imSubject(channel,conversation.tenantId,conversation.userId),
        'APPROVAL_REVISION_CONFLICT','IM 身份已变化，请重新申请。',409);
      const result:Grant={id:id('grant'),requestId,subject:request.subject,channelId:request.channelId,identityVersion:request.identityVersion,
        conversationId:request.conversationId,state:'active',revision:1,approvedAt:now()};
      this.store.put('grant',result);request.state='approved';request.revision++;this.store.put('request',request);
      this.store.audit('access.approved','web-admin',result.id,{requestId,subject:request.subject,conversationId:request.conversationId});
      if(!conversation.alias){conversation.alias=`dm-${conversation.id.slice(-8)}`;this.store.put('conversation',conversation);}
      return result;
    });this.onChange();return grant;
  }
  deny(requestId:string,revision:number) {
    const request=this.store.get('request',requestId);
    ensure(request && request.state==='pending' && request.revision===revision,'APPROVAL_REVISION_CONFLICT','申请状态已变化。',409);
    request.state='denied';request.revision++;this.store.put('request',request);this.store.audit('access.denied','web-admin',request.id);this.onChange();
  }
  revoke(grantId:string,revision:number) {
    const grant=this.store.get('grant',grantId);
    ensure(grant && grant.revision===revision,'GRANT_REVISION_CONFLICT','授权已变化，请刷新。',409);
    grant.state='revoked';grant.revision++;this.store.put('grant',grant);this.store.audit('access.revoked','web-admin',grantId);this.onChange();
  }
  invalidateChannel(channelId:string) {
    this.store.transaction(()=>{for(const grant of this.store.list('grant').filter(g=>g.channelId===channelId&&g.state==='active')){grant.state='revoked';grant.revision++;this.store.put('grant',grant);}});
    this.onChange();
  }
}
