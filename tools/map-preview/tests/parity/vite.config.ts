// Builds the backend parity page; the packages resolve to workspace sources.
// A plain object (no `vite` import) so the config loads from this directory.
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(
  new URL("../../../../packages/", import.meta.url),
);
export default {
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: {
    alias: {
      "@vosu-tools/render-core": `${packages}render-core/src/index.ts`,
      "@vosu-tools/osu-parse": `${packages}osu-parse/src/index.ts`,
      "@vosu-tools/skin-spec": `${packages}skin-spec/index.ts`,
      "@vosu-tools/ruleset-convert": `${packages}ruleset-convert/src/index.ts`,
      "@vosu-tools/demo-maps": `${packages}demo-maps/src/index.ts`,
    },
  },
  build: { target: "es2023", emptyOutDir: true },
};
