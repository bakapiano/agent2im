// Isolated browser fixture. Never imported by the production CLI.
import { fixture } from '../fixture.js';
import { createServers } from '../../src/server.js';

const f = await fixture(':memory:', { portalPort: 19643, agentPort: 19642 });
await f.inbound('/sessions');
const servers = await createServers(
  f.broker,
  'browser-installation-fixture',
  'browser-bootstrap-fixture',
);
await servers.listen();
console.log('Browser fixture ready');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void servers.close().then(() => f.close());
  });
}
