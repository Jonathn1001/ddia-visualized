import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', 'docs'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/engine/**/*.ts', 'src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', 'react/*', '*react*', 'zustand', 'zustand/*', 'motion', 'motion/*'],
              message: 'Simulation core must stay free of UI dependencies (DESIGN_PLAN §5).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Virtual clock only — schedule events instead.' },
        { name: 'setInterval', message: 'Virtual clock only — schedule events instead.' },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
