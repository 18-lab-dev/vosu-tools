import type { UserConfig } from "vite";

/**
 * Shared Vite settings for tool UIs. Tool pages are served by vosu at
 * /tools/<id>/, so assets use relative URLs, and the host-provided bridge and
 * theme stay external rather than being bundled.
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
