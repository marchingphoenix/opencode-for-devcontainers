import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    alias: {
      vscode: new URL("./src/__mocks__/vscode.ts", import.meta.url).pathname,
    },
  },
});
