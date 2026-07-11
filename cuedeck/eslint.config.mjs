import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['.vite/**', 'out/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
      },
    },
  },
);
