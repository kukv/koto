import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    // 統合テストが共有 DB(koto_test)を truncate しながら使うためファイルは直列実行する
    fileParallelism: false,
    restoreMocks: true,
    globalSetup: "./packages/core/tests/helpers/global-setup.ts",
    env: {
      DATABASE_URL: "postgres://koto:koto@localhost:5432/koto_test",
      EMBEDDING_PROVIDER: "none",
    },
  },
});
