import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const hash = createHash('sha256');
function hashTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hashTree(path);
    else {
      hash.update(path.replaceAll('\\', '/'));
      hash.update(readFileSync(path));
    }
  }
}
for (const dir of ['src', 'spec', 'plugins']) hashTree(dir);
hash.update(readFileSync('scripts/build.mjs'));
hash.update(readFileSync('scripts/package-plugin.mjs'));
hash.update(readFileSync('pnpm-lock.yaml'));
const buildId = hash.digest('hex').slice(0, 16);
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  define: { __AGENT_IM_BUILD_ID__: JSON.stringify(buildId) },
});
writeFileSync(
  'dist/build.json',
  JSON.stringify(
    {
      version: '0.3.0',
      buildId,
      cliSha256: createHash('sha256').update(readFileSync('dist/cli.js')).digest('hex'),
    },
    null,
    2,
  ),
);
