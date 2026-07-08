import tseslint from 'typescript-eslint';

const nondeterminismMessage =
  'Nondeterminism banned in the simulation core — use SeededRng and the virtual clock (DESIGN_PLAN §5).';

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
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: nondeterminismMessage },
        { object: 'Date', property: 'now', message: nondeterminismMessage },
        { object: 'performance', property: 'now', message: nondeterminismMessage },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: nondeterminismMessage },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
