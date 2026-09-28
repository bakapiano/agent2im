import * as lark from '@larksuiteoapi/node-sdk';
import type { Channel, Conversation, Outbox } from '../../core/model.js';
import type { ImConnection, ImEvent, ImFactory, ImReceipt } from '../port.js';
import { AppError, ensure } from '../../core/errors.js';
import { hash } from '../../core/util.js';
const quietLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
export class FeishuFactory implements ImFactory {
  async validate(appId: string, secret: string) {
    try {
      const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: secret }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as any;
      ensure(
        response.ok && data.code === 0 && data.tenant_access_token,
        'FEISHU_AUTH_FAILED',
        '飞书凭据验证失败。',
      );
      const botResponse = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${data.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const bot = (await botResponse.json()) as any;
      ensure(
        botResponse.ok && bot.code === 0 && bot.bot?.open_id,
        'FEISHU_BOT_REQUIRED',
        '请启用机器人能力并发布应用。',
      );
      return { fingerprint: hash(`${appId}:${bot.bot.open_id}`), botId: bot.bot.open_id };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('FEISHU_VALIDATION_FAILED', '飞书验证失败，请检查网络与平台配置。');
    }
  }
  create(channel: Channel, secret: string) {
    return new FeishuConnection(channel, secret);
  }
}
class FeishuConnection implements ImConnection {
  private client: lark.Client;
  private ws: lark.WSClient;
  private state = 'disconnected';
  constructor(
    private channel: Channel,
    secret: string,
  ) {
    const config = {
      appId: channel.appId,
      appSecret: secret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      logger: quietLogger,
    };
    this.client = new lark.Client(config);
    this.ws = new lark.WSClient({ ...config, handshakeTimeoutMs: 10_000 });
  }
  async start(onMessage: (message: ImEvent) => Promise<void>) {
    this.state = 'connecting';
    await this.ws.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          const m = data.message;
          const sender = data.sender;
          if (m?.chat_type !== 'p2p' || m.message_type !== 'text' || sender?.sender_type !== 'user') return;
          let content: any;
          try {
            content = JSON.parse(m.content);
          } catch {
            return;
          }
          const userId = sender.sender_id?.open_id;
          const tenantId = sender.tenant_key;
          if (!userId || !tenantId || typeof content.text !== 'string') return;
          await onMessage({
            eventId: m.message_id,
            messageId: m.message_id,
            tenantId,
            userId,
            chatId: m.chat_id,
            chatType: 'p2p',
            text: content.text,
            replyTo: m.parent_id,
            receivedAt: Date.now(),
          });
        },
      }),
    });
    this.state = this.ws.getConnectionStatus().state;
  }
  async send(conversation: Conversation, message: Outbox): Promise<ImReceipt> {
    try {
      const result = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: conversation.chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: message.text }),
          uuid: hash(message.businessKey).slice(0, 40),
        },
      });
      if (result.code === 0 && result.data?.message_id)
        return { status: 'delivered', messageId: result.data.message_id };
      if (result.code === 99991400) return { status: 'retryable', reason: '平台限流', retryAfterMs: 5000 };
      return { status: 'failed', reason: `飞书返回错误码 ${result.code ?? 'unknown'}` };
    } catch {
      return { status: 'unknown', reason: '平台请求已发出，回执状态需要核对' };
    }
  }
  async close() {
    this.ws.close({ force: true });
    this.state = 'disconnected';
  }
  health() {
    return this.state === 'disconnected'
      ? { state: this.state }
      : { state: this.ws.getConnectionStatus().state };
  }
}
