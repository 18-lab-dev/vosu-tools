import { toolConfig } from "@vosu-tools/tool-web/vite";

export default toolConfig({
  plugins: [
    {
      /**
       * Emits `editor-prefetch.json`: the files the lazily imported skin.ini
       * editor (src/editor.ts) needs that the first view does not already
       * load (its chunks, CSS and font). The page prefetches them when idle,
       * so opening the skin.ini tab only runs code already in the HTTP cache.
       */
      name: "skin-studio-editor-prefetch",
      generateBundle(_options, bundle) {
        const chunk = (name: string) => {
          const item = bundle[name];
          return item?.type === "chunk" ? item : undefined;
        };
        const chunks = Object.keys(bundle).flatMap((name) => chunk(name) ?? []);
        const editor = chunks.find((c) =>
          c.facadeModuleId?.endsWith("/src/editor.ts"),
        );
        const entry = chunks.find((c) => c.isEntry);
        if (!editor || !entry)
          throw new Error("editor or entry chunk not found");
        // Chunks the first view loads anyway (bridge imports are external).
        const eager = new Set<string>();
        const walkEager = (name: string) => {
          const c = chunk(name);
          if (!c || eager.has(name)) return;
          eager.add(name);
          c.imports.forEach(walkEager);
        };
        walkEager(entry.fileName);
        const files = new Set<string>();
        const walk = (name: string) => {
          const c = chunk(name);
          if (!c || eager.has(name) || files.has(name)) return;
          files.add(name);
          for (const css of c.viteMetadata?.importedCss ?? []) files.add(css);
          for (const asset of c.viteMetadata?.importedAssets ?? [])
            files.add(asset);
          c.imports.forEach(walk);
        };
        walk(editor.fileName);
        // The codicon font its CSS references.
        for (const name of Object.keys(bundle))
          if (/codicon.*\.ttf$/.test(name)) files.add(name);
        this.emitFile({
          type: "asset",
          fileName: "editor-prefetch.json",
          source: JSON.stringify([...files]),
        });
      },
    },
  ],
});
