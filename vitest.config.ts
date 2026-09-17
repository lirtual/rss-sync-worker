import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          READER_USERNAME: "test-reader",
          READER_TOKEN: "test-reader-token",
          ADMIN_TOKEN: "test-admin-token",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
