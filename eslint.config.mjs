import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // 0. Global ignores. Build output, plus scripts that run in non-Node
  //    runtimes (k6 and mongosh) and therefore have their own globals.
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', 'test/load/', 'docker/'],
  },

  eslint.configs.recommended,

  {
    // 1. Type-aware linting applies to TypeScript sources only. Scoping this
    //    with `files` matters: the typed rules cannot run against plain JS
    //    config files, which are not part of any TS project.
    files: ['**/*.ts'],

    // 2. Upgrade from 'recommended' to 'strictTypeChecked' for lead-level safety
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],

    // 3. Tell ESLint to use TypeScript's type checker
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest, // Keeps Jest global keywords (describe, test, expect) safe
      },
      parserOptions: {
        // Type-aware rules need every linted file to belong to a project.
        // tsconfig.test.json extends the base config and includes BOTH src/
        // and test/, so it covers everything ESLint looks at here.
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },

    // 4. Production API Rules
    rules: {
      // Catches all flavors of broken async operations (vital for 5,000 req/sec)
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Prohibit bypass hacks
      '@typescript-eslint/no-explicit-any': 'error',

      // This codebase is built on async ports (BannerRepository, BannerCache,
      // SingleFlightCoordinator). An adapter that satisfies an async contract
      // with a synchronous body is correct, not a mistake, so the rule would
      // only generate noise here.
      '@typescript-eslint/require-await': 'off',

      // Enforce clean logging (force structured logging over stray console.logs)
      'no-console': ['warn', { allow: ['info', 'warn', 'error', 'debug'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    // 5. Tooling/config JavaScript (eslint.config.mjs, jest.config.cjs, ...).
    //    Type-aware rules are explicitly disabled here.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    // 6. Relax strict rules for test files so fakes and mocks stay readable.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/helpers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // 7. CRITICAL: Completely silences formatting rules that fight Prettier
  prettierConfig,
);
