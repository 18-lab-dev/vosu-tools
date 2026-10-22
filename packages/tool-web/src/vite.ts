import type { UserConfig } from "vite";

/**
 * Shared Vite settings for tool UIs. Tool pages are served by vosu at
 * /tools/<id>/, so assets use relative URLs, and the host-provided bridge
 * stays an external module rather than being bundled.
 *
 * Link the host theme in index.html with the `vite-ignore` attribute:
 * `<link rel="stylesheet" href="/tools/_host/v1/theme.css" vite-ignore>`.
 * Without it Vite processes the link, and the `external` rule below would turn
 * the stylesheet into a JavaScript import of a CSS file.
 */
export function toolConfig(overrides: UserConfig = {}): UserConfig {
  return {
    base: "./",
    ...overrides,
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2023",
      assetsInlineLimit: 0,
      ...overrides.build,
      rollupOptions: {
        ...overrides.build?.rollupOptions,
        external: [/^\/tools\/_host\/v1\//],
      },
    },
  };
}
