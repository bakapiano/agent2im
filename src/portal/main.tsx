import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  App,
  Button,
  Card,
  ConfigProvider,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import 'antd/dist/reset.css';
import './style.css';
import { FeishuChannelFields } from '../im/feishu/channel-fields.js';

const setupToken = new URLSearchParams(location.hash.slice(1)).get('setup');
if (setupToken) {
  history.replaceState(null, '', location.pathname + location.search);
}
type State = {
  im_providers: any[];
  code_cli_providers: any[];
  channels: any[];
  requests: any[];
  grants: any[];
  sessions: any[];
  conversations: any[];
  workspaces: Record<string, string>;
  audit: any[];
  runtime_links: any[];
};

function Portal() {
  const [auth, setAuth] = useState<any>();
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<any>();
  const [approval, setApproval] = useState<any>();
  const [detail, setDetail] = useState<any>();
  const [credential, setCredential] = useState<string>();
  const [form] = Form.useForm();

  const csrf = auth?.csrf;
  const api = useCallback(
    async (path: string, data?: unknown) => {
      const r = await fetch(`/api${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        signal: AbortSignal.timeout(25_000),
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const b = await r.json();
      if (!b.ok) {
        throw new Error(`${b.error?.code}: ${b.error?.message}`);
      }
      return b.data;
    },
    [csrf],
  );

  const refresh = useCallback(async () => {
    const a = await api('/auth');
    setAuth(a);
    if (a.authenticated) {
      setState(await api('/state'));
    }
  }, [api]);

  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    if (!auth?.authenticated) {
      return;
    }
    const timer = setInterval(() => {
      void api('/state')
        .then(setState)
        .catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [api, auth?.authenticated]);
  const mutateChannel = (c: any, operation: string, enabled?: boolean) =>
    action(async () => {
      await api('/channels', {
        operation,
        channel_id: c.channel_id,
        expected_revision: c.revision,
        idempotency_key: crypto.randomUUID(),
        ...(enabled === undefined ? {} : { enabled }),
      });
    });
  if (!auth) {
    return (
      <main>
        <h1>Agent to IM</h1>
        <p>正在连接本地控制台…</p>
        {error && <Alert type="error" title={error} />}
      </main>
    );
  }
  if (!auth.authenticated) {
    return (
      <main className="login">
        <Tag color="blue">LOCAL CONTROL PLANE</Tag>
        <h1>Agent to IM</h1>
        <p>把正在工作的 Agent 接入你的私聊。</p>
        <Card title={auth.configured ? '登录本地控制台' : '设置本地管理员'}>
          {error && <Alert type="error" title={error} />}
          <Form
            layout="vertical"
            initialValues={{ bootstrap_token: setupToken ?? undefined }}
            onFinish={(v) =>
              action(async () => {
                const a = await api(auth.configured ? '/login' : '/bootstrap', v);
                setAuth({ ...auth, ...a, authenticated: true });
              })
            }
          >
            {!auth.configured && (
              <>
                <Alert type="info" title="首次设置令牌显示在启动服务的终端中。" />
                <Form.Item name="bootstrap_token" label="首次设置令牌" rules={[{ required: true }]}>
                  <Input.Password autoComplete="off" />
                </Form.Item>
              </>
            )}
            <Form.Item
              name="password"
              label="管理员密码"
              rules={[{ required: true, min: auth.configured ? 1 : 12 }]}
            >
              <Input.Password
                autoComplete={auth.configured ? 'current-password' : 'new-password'}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={busy}>
              进入控制台
            </Button>
          </Form>
        </Card>
        <p className="muted">管理会话使用本地 Cookie，Agent 使用独立身份凭据。</p>
      </main>
    );
  }
  const s = state;
  return (
    <main>
      <header>
        <div>
          <Tag color="blue">LOCAL · CODEX × FEISHU</Tag>
          <h1>Agent to IM</h1>
          <p>会话在原生终端继续，消息在私聊中流动。</p>
        </div>
        <Space>
          <Button onClick={() => void action(refresh)}>刷新</Button>
          <Button
            onClick={() =>
              void action(async () => {
                await api('/logout', {});
                setState(undefined);
              })
            }
          >
            退出
          </Button>
        </Space>
      </header>
      {error && (
        <Alert
          className="banner"
          type="error"
          showIcon
          title={error}
          closable
          onClose={() => setError('')}
        />
      )}
      <div className="metrics">
        <Card>
          <small>IM 渠道</small>
          <strong>
            {s?.channels.filter((c) => c.state === 'enabled').length ?? 0}
            <span> 已启用</span>
          </strong>
        </Card>
        <Card>
          <small>已注册会话</small>
          <strong>{s?.sessions.length ?? 0}</strong>
        </Card>
        <Card>
          <small>等待人工审批</small>
          <strong>{s?.requests.filter((r) => r.state === 'pending').length ?? 0}</strong>
        </Card>
      </div>
      <Tabs
        items={[
          {
            key: 'channels',
            label: '渠道与连接',
            children: (
              <>
                <Card className="section" title="平台适配">
                  <p>
                    IM：
                    {s?.im_providers.map((p) => (
                      <Tag key={p.id} color={p.status === 'ready' ? 'green' : 'default'}>
                        {p.displayName} · {p.status === 'ready' ? '已接入' : '规划中'}
                      </Tag>
                    ))}
                  </p>
                  <p>
                    Code CLI：
                    {s?.code_cli_providers.map((p) => (
                      <Tag key={p.id} color={p.status === 'ready' ? 'green' : 'default'}>
                        {p.displayName} · {p.status === 'ready' ? '已接入' : '调研中'}
                      </Tag>
                    ))}
                  </p>
                </Card>
                <Space className="toolbar">
                  <Button
                    type="primary"
                    onClick={() => {
                      setChannel({ provider: 'feishu' });
                      setCredential(undefined);
                      form.resetFields();
                    }}
                  >
                    添加飞书渠道
                  </Button>
                  <Typography.Text type="secondary">
                    App Secret 在此录入，MCP 使用 credential_ref。
                  </Typography.Text>
                </Space>
                <Table
                  rowKey="channel_id"
                  dataSource={s?.channels}
                  pagination={false}
                  columns={[
                    {
                      title: '渠道',
                      render: (_, c) => (
                        <>
                          <b>{c.display_name}</b>
                          <div className="muted">{c.channel_alias}</div>
                        </>
                      ),
                    },
                    { title: '平台', dataIndex: 'provider' },
                    { title: 'App ID', dataIndex: 'app_id' },
                    {
                      title: '状态',
                      render: (_, c) => (
                        <>
                          <Tag color={c.state === 'enabled' ? 'green' : 'default'}>{c.state}</Tag>
                          <small>{c.health?.state}</small>
                        </>
                      ),
                    },
                    { title: '版本', dataIndex: 'revision' },
                    {
                      title: '操作',
                      render: (_, c) => (
                        <Space wrap>
                          <Button
                            disabled={busy}
                            onClick={() => {
                              setChannel(c);
                              setCredential(undefined);
                              form.setFieldsValue({
                                channel_alias: c.channel_alias,
                                display_name: c.display_name,
                                app_id: c.app_id,
                              });
                            }}
                          >
                            编辑
                          </Button>
                          <Button disabled={busy} onClick={() => void mutateChannel(c, 'validate')}>
                            验证
                          </Button>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void mutateChannel(c, 'set_enabled', c.state !== 'enabled')
                            }
                          >
                            {c.state === 'enabled' ? '停用' : '启用'}
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
                <Card className="section" title="已发现的私聊连接">
                  <Table
                    rowKey="id"
                    dataSource={s?.conversations}
                    pagination={false}
                    columns={[
                      {
                        title: '连接别名',
                        render: (_, c) => (
                          <Typography.Text copyable={!!c.alias}>
                            {c.alias ?? '等待 Web 审批'}
                          </Typography.Text>
                        ),
                      },
                      { title: '平台用户', dataIndex: 'userId' },
                      { title: '租户', dataIndex: 'tenantId' },
                      { title: '身份版本', dataIndex: 'identityVersion' },
                    ]}
                  />
                  <p className="muted">
                    飞书应用启用机器人、消息权限和长连接事件后，用户首次私聊会生成审批申请。
                  </p>
                </Card>
              </>
            ),
          },
          {
            key: 'approvals',
            label: `IM 访问审批 (${s?.requests.filter((r) => r.state === 'pending').length ?? 0})`,
            children: (
              <>
                <Alert
                  type="info"
                  title="核对 IM 平台用户、租户和渠道，决定谁可以与 Agent 互动。"
                />
                <Table
                  rowKey="id"
                  dataSource={s?.requests}
                  columns={[
                    {
                      title: 'IM 使用者',
                      render: (_, r) => (
                        <>
                          <b>{r.subjectLabel}</b>
                          <div className="muted">{r.subject}</div>
                        </>
                      ),
                    },
                    { title: '渠道', dataIndex: 'channelId' },
                    { title: '状态', dataIndex: 'state' },
                    {
                      title: '操作',
                      render: (_, r) => (
                        <Button disabled={r.state !== 'pending'} onClick={() => setApproval(r)}>
                          审阅
                        </Button>
                      ),
                    },
                  ]}
                />
                <h2>已审核的 IM 使用者</h2>
                <Table
                  rowKey="id"
                  dataSource={s?.grants}
                  columns={[
                    { title: 'IM 身份', dataIndex: 'subject' },
                    { title: '渠道', dataIndex: 'channelId' },
                    { title: '状态', dataIndex: 'state' },
                    {
                      title: '操作',
                      render: (_, r) => (
                        <Popconfirm
                          title="撤销此 IM 使用者与 Agent 互动的资格？"
                          onConfirm={() =>
                            action(async () => {
                              await api(`/grants/${r.id}/revoke`, { revision: r.revision });
                            })
                          }
                        >
                          <Button danger disabled={r.state !== 'active'}>
                            撤销
                          </Button>
                        </Popconfirm>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'sessions',
            label: '会话',
            children: (
              <>
                <Alert
                  type="info"
                  title="Agent 会话自动登记；IM 使用者经审核后可以互动。历史与原生执行权限由 Codex 保管。"
                />
                <Table
                  rowKey="id"
                  dataSource={s?.sessions}
                  columns={[
                    {
                      title: '会话',
                      render: (_, r) => (
                        <>
                          <b>{r.title}</b>
                          <div>{r.shortId}</div>
                        </>
                      ),
                    },
                    { title: 'Code CLI', dataIndex: 'provider' },
                    { title: '工作目录', dataIndex: 'cwd' },
                    { title: '状态', dataIndex: 'state' },
                    { title: '原生 thread', dataIndex: 'threadId' },
                    {
                      title: '操作',
                      render: (_, r) => (
                        <Button
                          onClick={() =>
                            void action(async () => setDetail(await api(`/sessions/${r.id}`)))
                          }
                        >
                          查看状态
                        </Button>
                      ),
                    },
                  ]}
                />
                <h2>可选目录显示别名</h2>
                <Descriptions
                  items={Object.entries(s?.workspaces ?? {}).map(([key, value]) => ({
                    key,
                    label: key,
                    children: value,
                  }))}
                />
              </>
            ),
          },
          {
            key: 'audit',
            label: '审计',
            children: (
              <Table
                rowKey="seq"
                dataSource={s?.audit}
                columns={[
                  { title: '时间', render: (_, r) => new Date(r.at).toLocaleString() },
                  { title: '操作', dataIndex: 'action' },
                  { title: '身份', dataIndex: 'subject' },
                  { title: '对象', dataIndex: 'target' },
                ]}
              />
            ),
          },
        ]}
      />
      <Modal
        title={channel?.channel_id ? '编辑飞书渠道' : '添加飞书渠道'}
        open={!!channel}
        onCancel={() => {
          setChannel(undefined);
          form.resetFields();
        }}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) =>
            void action(async () => {
              let ref = credential;
              if (v.secret) {
                ref = (await api('/credentials', { purpose: channel.provider, secret: v.secret }))
                  .credential_ref;
                setCredential(ref);
                form.setFieldValue('secret', '');
              }
              ensureRef(ref);
              await api('/channels', {
                operation: 'upsert',
                provider: channel.provider,
                channel_alias: v.channel_alias,
                display_name: v.display_name,
                app_id: v.app_id,
                credential_ref: ref,
                expected_revision: channel.revision ?? 0,
                idempotency_key: crypto.randomUUID(),
              });
              setChannel(undefined);
              form.resetFields();
            })
          }
        >
          <Form.Item
            label="渠道别名"
            name="channel_alias"
            rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/ }]}
          >
            <Input disabled={!!channel?.channel_id} placeholder="feishu-main" />
          </Form.Item>
          <Form.Item label="显示名称" name="display_name" rules={[{ required: true, max: 120 }]}>
            <Input />
          </Form.Item>
          <FeishuChannelFields credentialConfigured={!!credential} />
          {credential && (
            <Alert
              type="success"
              title={
                <span>
                  凭据引用：<Typography.Text copyable>{credential}</Typography.Text>
                </span>
              }
            />
          )}
          <Space>
            <Button
              onClick={() =>
                void action(async () => {
                  const secret = form.getFieldValue('secret');
                  if (!secret) {
                    throw new Error('请先输入 App Secret');
                  }
                  setCredential(
                    (await api('/credentials', { purpose: channel.provider, secret }))
                      .credential_ref,
                  );
                  form.setFieldValue('secret', '');
                })
              }
            >
              仅保存凭据引用
            </Button>
            <Button type="primary" htmlType="submit" loading={busy}>
              保存渠道
            </Button>
          </Space>
          <p className="muted">应用身份变更会触发重新审批；保存后依次验证与启用。</p>
        </Form>
      </Modal>
      <Modal
        title="审阅 IM 使用者"
        open={!!approval}
        onCancel={() => setApproval(undefined)}
        footer={
          <Space>
            <Button
              danger
              onClick={() =>
                void action(async () => {
                  await api(`/requests/${approval.id}/deny`, { revision: approval.revision });
                  setApproval(undefined);
                })
              }
            >
              拒绝
            </Button>
            <Button
              type="primary"
              loading={busy}
              onClick={() =>
                void action(async () => {
                  await api(`/requests/${approval.id}/approve`, { revision: approval.revision });
                  setApproval(undefined);
                })
              }
            >
              允许此用户互动
            </Button>
          </Space>
        }
      >
        {approval && (
          <Descriptions
            column={1}
            items={[
              { key: 'subject', label: 'IM 稳定身份', children: approval.subject },
              {
                key: 'channel',
                label: '渠道 / 身份版本',
                children: `${approval.channelId} / ${approval.identityVersion}`,
              },
              { key: 'conversation', label: '私聊', children: approval.conversationId },
              {
                key: 'expires',
                label: '申请有效至',
                children: new Date(approval.expiresAt).toLocaleString(),
              },
            ]}
          />
        )}
      </Modal>
      <Modal
        title="原生会话状态"
        open={!!detail}
        onCancel={() => setDetail(undefined)}
        footer={null}
      >
        <pre>{JSON.stringify(detail, null, 2)}</pre>
      </Modal>
      <footer>Agent to IM v0.2 · 本地优先 · 审批持久化 · 凭据由 Windows DPAPI 加密</footer>
    </main>
  );
}

function ensureRef(ref: unknown): asserts ref is string {
  if (typeof ref !== 'string') {
    throw new Error('请先保存凭据。');
  }
}

createRoot(document.getElementById('root')!).render(
  <ConfigProvider
    button={{ autoInsertSpace: false }}
    theme={{
      token: {
        colorPrimary: '#315ee8',
        borderRadius: 10,
        fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      },
    }}
  >
    <App>
      <Portal />
    </App>
  </ConfigProvider>,
);
