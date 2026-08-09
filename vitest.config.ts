import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    // 統合テストが共有 DB(koto_test)を truncate しながら使うためファイルは直列実行する
    fileParallelism: false,
    restoreMocks: true,
    // vi.stubEnv をテストごとに巻き戻す(承認ダイアログのテストが KOTO_REVIEWER を差し替えるため)
    unstubEnvs: true,
    globalSetup: "./packages/core/tests/helpers/global-setup.ts",
    env: {
      DATABASE_URL: "postgres://koto:koto@localhost:5432/koto_test",
      EMBEDDING_PROVIDER: "none",
      // 承認ダイアログは KOTO_REVIEWER の候補から確認者を選ばせる(未設定だと承認できない)
      KOTO_REVIEWER: "野中,山田税理士",
    },
  },
});
