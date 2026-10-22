import { toolConfig } from "@vosu-tools/tool-web/vite";
export default toolConfig({
  build: { rollupOptions: { input: ["index.html", "export.html"] } },
});
