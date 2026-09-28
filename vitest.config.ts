import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
export default defineConfig({
  define: {
    __AGENT_IM_BUILD_ID__: JSON.stringify(JSON.parse(readFileSync('dist/build.json', 'utf8')).buildId),
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 30_000, fileParallelism: false },
});
