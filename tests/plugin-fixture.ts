import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Outside the checkout so ancestor node_modules cannot hide missing packaged dependencies. */
export async function packageForTest() {
  const root = mkdtempSync(join(tmpdir(), 'agent-to-im-plugin-'));
  const plugin = join(root, 'plugins', 'agent-to-im');
  await promisify(execFile)(process.execPath, [resolve('scripts/package-plugin.mjs'), plugin], {
    windowsHide: true,
    timeout: 90_000,
  });
  return { root, plugin };
}

export function testMarketplace(root: string) {
  const directory = join(root, '.agents/plugins');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'marketplace.json'),
    JSON.stringify({
      name: 'agent-im-fixture',
      interface: { displayName: 'Isolated plugin acceptance' },
      plugins: [
        {
          name: 'agent-to-im',
          source: { source: 'local', path: './plugins/agent-to-im' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    }),
  );
}
