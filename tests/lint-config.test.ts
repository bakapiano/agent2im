import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const eslint = new ESLint({ cwd: resolve('.') });

it.each([
  {
    rule: 'curly',
    code: 'export function choose(value: boolean) { if (value) return 1; return 0; }',
  },
  {
    rule: '@stylistic/max-statements-per-line',
    code: 'export const first = 1; export const second = 2;',
  },
  {
    rule: 'one-var',
    code: 'export function sum() { const first = 1, second = 2; return first + second; }',
  },
  {
    rule: '@typescript-eslint/no-unused-vars',
    code: 'const unused = 1; export {};',
  },
])('ESLint rejects $rule violations', async ({ rule, code }) => {
  const [result] = await eslint.lintText(code, { filePath: 'src/lint-probe.ts' });
  expect(result.messages.some((message) => message.ruleId === rule && message.severity === 2)).toBe(
    true,
  );
});

it('ESLint checks Hook dependencies in Portal code', async () => {
  const [result] = await eslint.lintText(
    "import { useEffect } from 'react';\nexport function Probe({ value }: { value: string }) { useEffect(() => { console.log(value); }, []); return null; }",
    { filePath: 'src/portal/lint-probe.tsx' },
  );
  expect(result.messages.some((message) => message.ruleId === 'react-hooks/exhaustive-deps')).toBe(
    true,
  );
});

it('ESLint accepts formatted TypeScript', async () => {
  const [result] = await eslint.lintText(
    'export function increment(value: number): number {\n  return value + 1;\n}\n',
    { filePath: 'src/lint-probe.ts' },
  );
  expect(result.messages).toEqual([]);
});

it('ESLint excludes runtime data, dependencies and generated artifacts', async () => {
  for (const path of [
    '.local/private.ts',
    '.test-data/private.ts',
    'dist/cli.js',
    'node_modules/a.ts',
  ]) {
    expect(await eslint.isPathIgnored(resolve(path))).toBe(true);
  }
});
