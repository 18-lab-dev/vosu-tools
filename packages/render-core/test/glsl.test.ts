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

test("per-instance values reach the fragment stage flat", () => {
  // The fragment stage turns shape.x/w into integers and region.w into the
  // slider body profile. Interpolating a constant can land just below the
  // integer (SwiftShader does), which drew slider bodies as another shape:
  // MAP_PREVIEW_RASTERISER=swiftshader
  // tools/map-preview/tests/slider_bodies_e2e.py.
  const vertex = shader.slice(shader.indexOf("struct Vertex"));
  for (const field of ["shape", "region", "layer", "band"])
    expect(vertex).toMatch(new RegExp(`@interpolate\\(flat\\) ${field}:`));
  for (const location of [3, 5])
    for (const stage of [glsl.vs, glsl.fs, glsl.fs_slider])
      expect(stage.code).toContain(
        `flat ${stage === glsl.vs ? "out" : "in"} vec4 _vs2fs_location${location}`,
      );
});
