import { expect, it } from 'vitest';
import { fixture, FakeAgents, FakeIm } from '../fixture.js';
import { ImRegistry } from '../../src/im/registry.js';
import { CodeCliRegistry } from '../../src/code-cli/registry.js';
import { validateTool } from '../../src/core/validation.js';

it('provider inspection routes guides and reports ready versus planned accurately', async () => {
  const f = await fixture();
  try {
    const feishu = (await f.broker.channels.execute({
      operation: 'inspect',
      provider: 'feishu',
    })) as any;
    expect(feishu).toMatchObject({
      provider: 'feishu',
      status: 'ready',
      guide: 'references/im/feishu.md',
    });
    expect(feishu.channels[0].provider).toBe('feishu');
    for (const provider of ['wechat', 'qq'] as const) {
      expect(() =>
        validateTool('configure_im_channel', { operation: 'inspect', provider }),
      ).not.toThrow();
      expect(await f.broker.channels.execute({ operation: 'inspect', provider })).toMatchObject({
        provider,
        status: 'planned',
        channels: [],
        guide: `references/im/${provider}.md`,
      });
      expect(() => f.broker.channels.providers.get(provider)).toThrow(/规划/);
    }
    expect(f.broker.agents.list().map((p) => [p.id, p.status])).toEqual([
      ['codex', 'ready'],
      ['claude', 'planned'],
      ['ghcp', 'planned'],
    ]);
    expect(() => f.broker.agents.get('claude')).toThrow(/调研/);
    expect(() => f.broker.agents.get('ghcp')).toThrow(/调研/);
  } finally {
    await f.close();
  }
});

it('registry dispatch is provider-specific and rejects missing discriminators', () => {
  const first = new FakeIm();
  const second = new FakeIm();
  const registry = new ImRegistry({ feishu: first, qq: second });
  expect(registry.get('feishu')).toBe(first);
  expect(registry.get('qq')).toBe(second);
  expect(() => registry.get(undefined as any)).toThrow(/标识/);
  const agents = new CodeCliRegistry({ codex: new FakeAgents() });
  expect(() => agents.get(undefined as any)).toThrow(/标识/);
});

it('provider participates in native identity, even with the same home and thread ID', async () => {
  const f = await fixture();
  try {
    const a = await f.connect();
    // Inject a second test adapter; production keeps this provider at the planned stage.
    const other = new FakeAgents();
    other.validateContext = () => {};
    const alternate = new CodeCliRegistry({ codex: f.agents, claude: other });
    const create = f.broker.agents.create.bind(alternate);
    const validate = f.broker.agents.validateContext.bind(alternate);
    f.broker.agents.create = create;
    f.broker.agents.validateContext = validate;
    const result = (await f.broker.tool(
      'register',
      { ...a.registerArgs, idempotency_key: 'other-platform' },
      {
        ...a.caller,
        nativeContext: { ...a.caller.nativeContext!, provider: 'claude' },
      },
    )) as any;
    expect(result.session_id).not.toBe(a.session.id);
    expect(f.store.list('runtime')).toHaveLength(2);
    expect(f.store.list('session').map((s) => s.provider)).toEqual(['codex', 'claude']);
    expect(f.store.list('grant')).toHaveLength(1);
  } finally {
    await f.close();
  }
});
