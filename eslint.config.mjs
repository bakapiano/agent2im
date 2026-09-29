import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = [
  'src/**/*.{ts,tsx}',
  'tests/**/*.ts',
  'spec/**/*.ts',
  'scripts/**/*.mjs',
  '*.{ts,mjs}',
];
const typescriptFiles = ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'spec/**/*.ts', '*.ts'];

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '.local/**',
    '.tools/**',
    '.test-data/**',
    'coverage/**',
    'test-results/**',
    'playwright-report/**',
  ]),
  {
    files: sourceFiles,
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: typescriptFiles,
    extends: [tseslint.configs.recommended],
    rules: {
      // JSON/RPC payloads and test doubles currently use explicit any at their boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  {
    files: ['src/portal/**/*.{ts,tsx}', 'src/im/**/channel-fields.tsx'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  prettier,
  {
    files: sourceFiles,
    plugins: { '@stylistic': stylistic },
    rules: {
      curly: ['error', 'all'],
      'one-var': ['error', 'never'],
      '@stylistic/max-statements-per-line': ['error', { max: 1 }],
      '@stylistic/lines-between-class-members': ['error', 'always'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: ['function', 'class'], next: '*' },
        { blankLine: 'always', prev: '*', next: ['function', 'class'] },
      ],
    },
  },
]);
