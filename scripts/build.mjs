import { build } from 'esbuild';
await build({
  entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external',
  banner: { js: '#!/usr/bin/env node' }, sourcemap: true,
});
