/**
 * The WebGL2 backend (see gpu.ts), for browsers or machines without WebGPU.
 * It draws the same instances with GLSL ES 3.00 that naga generates from the
 * WGSL (shader-glsl.ts): same blending, sampling, atlas pages and frame
 * table, so the two backends draw the same pixels. WebGL2 has no base
 * instance, so each chunk re-points the instance attributes at its first
 * instance; framebuffer rows are bottom-up, so readback flips them.
 */
import {
  bitmapPresentation,
  frameTableRows,
  INSTANCE_FLOATS,
  MAX_OVERLAYS,
  type Gpu,
  type GpuOptions,
  type RenderTarget,
} from "./gpu";
import { FRAME_TABLE_WIDTH } from "./shader";
import { glsl } from "./shader-glsl";

const ATTRIBUTES = 6,
  STRIDE = INSTANCE_FLOATS * 4;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  code: string,
): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, code);
  gl.compileShader(shader);
  return shader;
}

class Target implements RenderTarget {
  readonly framebuffer: WebGLFramebuffer;
  private readonly colour: WebGLRenderbuffer;
  private rendered = false;
  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
  ) {
    this.colour = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.colour);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.RENDERBUFFER,
      this.colour,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  drawn(): void {
    this.rendered = true;
  }
  async read(into?: Uint8Array): Promise<Uint8Array> {
    if (!this.rendered) throw new Error("Nothing was rendered into the target");
    this.rendered = false;
    const { gl, width, height } = this,
      rowBytes = width * 4,
      pixels = into ?? new Uint8Array(rowBytes * height);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    // Bottom-up rows to top-down, as WebGPU returns them.
    const row = new Uint8Array(rowBytes);
    for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
      const a = top * rowBytes,
        b = bottom * rowBytes;
      row.set(pixels.subarray(a, a + rowBytes));
      pixels.copyWithin(a, b, b + rowBytes);
      pixels.set(row, b);
    }
    return pixels;
  }
  destroy(): void {
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteRenderbuffer(this.colour);
  }
}

/** Throws when WebGL2 is unavailable or the generated shaders do not link. */
export function createWebGl2(options: GpuOptions): Gpu {
  const shown = bitmapPresentation(options),
    // Without a canvas only offscreen targets are drawn: a 1×1 surface.
    surface = shown?.offscreen ?? options.canvas ?? new OffscreenCanvas(1, 1);
  if (options.canvas) {
    surface.width = options.width;
    surface.height = options.height;
  }
  const gl = surface.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error("WebGL2 is unavailable");
  const program = gl.createProgram()!,
    vertex = compile(gl, gl.VERTEX_SHADER, glsl.vs.code),
    fragment = compile(gl, gl.FRAGMENT_SHADER, glsl.fs.code);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  for (let i = 0; i < ATTRIBUTES; i++)
    gl.bindAttribLocation(program, i, `_p2vs_location${i}`);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = [
      gl.getShaderInfoLog(vertex),
      gl.getShaderInfoLog(fragment),
      gl.getProgramInfoLog(program),
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`GLSL: ${log || "program did not link"}`);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  gl.useProgram(program);
  // WGSL's `g` is one uniform block per stage; both read binding point 0.
  const uniformBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.UNIFORM_BUFFER, uniformBuffer);
  gl.bufferData(gl.UNIFORM_BUFFER, 96, gl.DYNAMIC_DRAW);
  for (const block of [glsl.vs.uniforms.g, glsl.fs.uniforms.g]) {
    const index = gl.getUniformBlockIndex(program, block);
    if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, index, 0);
  }
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, uniformBuffer);
  gl.uniform1i(gl.getUniformLocation(program, glsl.fs.textures.atlas), 0);
  gl.uniform1i(gl.getUniformLocation(program, glsl.vs.textures.frameTable), 1);

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  for (let i = 0; i < ATTRIBUTES; i++) {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribDivisor(i, 1);
  }
  const instanceBuffer = gl.createBuffer()!,
    overlayBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, MAX_OVERLAYS * STRIDE, gl.DYNAMIC_DRAW);
  const point = (buffer: WebGLBuffer, first: number) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let i = 0; i < ATTRIBUTES; i++)
      gl.vertexAttribPointer(
        i,
        4,
        gl.FLOAT,
        false,
        STRIDE,
        first * STRIDE + i * 16,
      );
  };
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
  );
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const clear = options.clear,
    [r, g, b, a] = Array.isArray(clear)
      ? clear
      : [
          (clear as GPUColorDict).r,
          (clear as GPUColorDict).g,
          (clear as GPUColorDict).b,
          (clear as GPUColorDict).a,
        ];
  gl.clearColor(r, g, b, a);

  let atlas: WebGLTexture | null = null,
    table: WebGLTexture | null = null,
    textureBytes = 0,
    width = options.width,
    height = options.height,
    lostReason: string | null = null,
    disposed = false;
  const lost = new Promise<string>((resolve) =>
    surface.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      lostReason = "WebGL2 context lost";
      resolve(lostReason);
    }),
  );
  const fences: { sync: WebGLSync; done: () => void }[] = [];
  let polling = 0;
  const poll = () => {
    polling = 0;
    while (fences.length) {
      const status = gl.clientWaitSync(fences[0].sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) break;
      const fence = fences.shift()!;
      gl.deleteSync(fence.sync);
      fence.done();
    }
    if (fences.length) polling = setTimeout(poll, 1) as unknown as number;
  };

  const gpu: Gpu = {
    backend: "webgl2",
    device: null,
    format: "rgba8unorm",
    limits: {
      maxTextureDimension2D: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxTextureArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    },
    lost,
    get textureBytes() {
      return textureBytes;
    },
    setAtlas(build) {
      const next = gl.createTexture()!;
      let bytes = 0;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, next);
      const frames = build({
        limits: gpu.limits,
        allocate(w, h, pages) {
          gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, h, pages);
          bytes = w * h * pages * 4;
        },
        upload(page, source) {
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            0,
            0,
            page,
            source.width,
            source.height,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            source,
          );
        },
      });
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(
        gl.TEXTURE_2D_ARRAY,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE,
      );
      gl.texParameteri(
        gl.TEXTURE_2D_ARRAY,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE,
      );
      const texels = frames.length / 4,
        rows = frameTableRows(texels, FRAME_TABLE_WIDTH),
        padded = new Float32Array(rows * FRAME_TABLE_WIDTH * 4);
      padded.set(frames);
      const nextTable = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, nextTable);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, FRAME_TABLE_WIDTH, rows);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        FRAME_TABLE_WIDTH,
        rows,
        gl.RGBA,
        gl.FLOAT,
        padded,
      );
      // Float textures are only complete unfiltered; the shader uses texelFetch.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.deleteTexture(atlas);
      gl.deleteTexture(table);
      atlas = next;
      table = nextTable;
      textureBytes = bytes + padded.byteLength;
    },
    setInstances(data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        data.length ? data : new Float32Array(INSTANCE_FLOATS),
        gl.STATIC_DRAW,
      );
    },
    resize(w, h) {
      width = w;
      height = h;
      if (!options.canvas) return;
      options.canvas.width = w;
      options.canvas.height = h;
      if (shown) {
        shown.offscreen.width = w;
        shown.offscreen.height = h;
      }
    },
    draw(call) {
      if (lostReason) return;
      const target = call.target as Target | undefined;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
      gl.viewport(0, 0, target?.width ?? width, target?.height ?? height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.UNIFORM_BUFFER, uniformBuffer);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, call.uniforms);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, table);
      for (const chunk of call.chunks) {
        point(instanceBuffer, chunk.first);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, chunk.count);
      }
      if (call.overlayCount) {
        gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          call.overlays,
          0,
          call.overlayCount * INSTANCE_FLOATS,
        );
        point(overlayBuffer, 0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, call.overlayCount);
      }
      if (target) {
        target.drawn();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else if (shown)
        shown.bitmap.transferFromImageBitmap(
          shown.offscreen.transferToImageBitmap(),
        );
    },
    createTarget(w, h) {
      return new Target(gl, w, h);
    },
    finished() {
      if (lostReason || disposed) return Promise.resolve();
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) return Promise.resolve();
      gl.flush();
      return new Promise<void>((done) => {
        fences.push({ sync, done });
        if (!polling) polling = setTimeout(poll, 0) as unknown as number;
      });
    },
    destroy() {
      disposed = true;
      clearTimeout(polling);
      for (const fence of fences.splice(0)) {
        gl.deleteSync(fence.sync);
        fence.done();
      }
      gl.deleteTexture(atlas);
      gl.deleteTexture(table);
      gl.deleteBuffer(instanceBuffer);
      gl.deleteBuffer(overlayBuffer);
      gl.deleteBuffer(uniformBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
  return gpu;
}
