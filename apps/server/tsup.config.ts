import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  outDir: "dist",
  // Bundle the workspace package into the output so the runtime image doesn't
  // need to ship the shared source.
  noExternal: ["@kanco/shared"],
});
