import { Form, Input } from 'antd';

export function FeishuChannelFields({ credentialConfigured }: { credentialConfigured: boolean }) {
  return (
    <>
      <Form.Item label="App ID" name="app_id" rules={[{ required: true, pattern: /^cli_[A-Za-z0-9]+$/ }]}>
        <Input placeholder="cli_…" />
      </Form.Item>
      <Form.Item label="App Secret（保存时加密）" name="secret" rules={[{ required: !credentialConfigured }]}>
        <Input.Password autoComplete="off" />
      </Form.Item>
    </>
  );
}
