// Root ESLint flat config (NFR-14). Type-aware rules are enabled per workspace once tsconfig projects exist (Phase 1).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/build/**",
      "**/.gradle/**",
      "**/.venv/**",
      "packages/contracts/generated/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "error",
    },
  },
  {
    // NestJS (ADR-0013): modules are empty classes configured by decorators.
    files: ["gateway/nest-http/**/*.ts"],
    rules: { "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }] },
  },
  {
    // mongosh init scripts run inside the MongoDB shell, which provides these globals.
    files: ["deploy/compose/init/mongo/**/*.js"],
    languageOptions: { globals: { db: "readonly", process: "readonly", print: "readonly" } },
  },
  {
    // CommonJS config/migration files required by migrate-mongo.
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly", __dirname: "readonly", process: "readonly" },
    },
  },
);
