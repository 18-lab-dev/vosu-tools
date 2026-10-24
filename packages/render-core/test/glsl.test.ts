import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { shader } from "../src/shader";
import { glsl, wgslSha256 } from "../src/shader-glsl";

test("the WebGL2 GLSL is generated from the current WGSL (bun run glsl)", () => {
  expect(createHash("sha256").update(shader).digest("hex")).toBe(wgslSha256);
});

test("the generated GLSL is WebGL2's dialect with the names webgl2.ts binds", () => {
  for (const stage of [glsl.vs, glsl.fs]) {
    expect(stage.code.startsWith("#version 300 es")).toBe(true);
    expect(stage.code).toContain(stage.uniforms.g);
  }
  // Six instance attributes, bound by name to locations 0-5.
  for (let i = 0; i < 6; i++)
    expect(glsl.vs.code).toContain(`_p2vs_location${i}`);
  expect(glsl.vs.code).toContain(`sampler2D ${glsl.vs.textures.frameTable}`);
  expect(glsl.fs.code).toContain(`sampler2DArray ${glsl.fs.textures.atlas}`);
  // WebGPU's clip space is kept (no y flip, z untouched).
  expect(glsl.vs.code).not.toContain("gl_Position.yz");
});
