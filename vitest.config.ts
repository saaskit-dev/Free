import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@saaskit-dev\/acp-runtime$/,
        replacement: resolve(__dirname, "../acp-runtime/src/index.ts"),
      },
      {
        find: /^@saaskit-dev\/acp-runtime\/internal\/(.*)$/,
        replacement: `${resolve(__dirname, "../acp-runtime/src/internal")}/$1.ts`,
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "packages/**/*.test.ts", "relay/src/**/*.test.ts"],
  },
});
