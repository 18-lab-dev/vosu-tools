/** The WebGPU backend (see gpu.ts). */
import { init } from "vgpu";
import {
  bitmapPresentation,
  frameTableRows,
  INSTANCE_FLOATS,
  MAX_OVERLAYS,
  UNIFORM_FLOATS,
  type DrawCall,
  type Gpu,
  type GpuOptions,
  type RenderTarget,
} from "./gpu";
import { FRAME_TABLE_WIDTH, shader } from "./shader";

class Target implements RenderTarget {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  private readonly buffer: GPUBuffer;
  private readonly stride: number;
  private pending = false;
  constructor(
    private readonly device: GPUDevice,
    readonly width: number,
    readonly height: number,
  ) {
    this.stride = Math.ceil((width * 4) / 256) * 256;
    this.texture = device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.view = this.texture.createView();
    this.buffer = device.createBuffer({
      size: this.stride * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }
  /** Appends the copy into the readback buffer to a frame's commands. */
  copy(encoder: GPUCommandEncoder): void {
    encoder.copyTextureToBuffer(
      { texture: this.texture },
      { buffer: this.buffer, bytesPerRow: this.stride },
      { width: this.width, height: this.height },
    );
    this.pending = true;
  }
  async read(into?: Uint8Array): Promise<Uint8Array> {
    if (!this.pending) throw new Error("Nothing was rendered into the target");
    this.pending = false;
    await this.buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(this.buffer.getMappedRange()),
      rowBytes = this.width * 4,
      out = into ?? new Uint8Array(rowBytes * this.height);
    if (this.stride === rowBytes) out.set(source);
    else
      for (let y = 0; y < this.height; y++)
        out.set(
          source.subarray(y * this.stride, y * this.stride + rowBytes),
          y * rowBytes,
        );
    this.buffer.unmap();
    return out;
  }
  destroy(): void {
    this.texture.destroy();
    this.buffer.destroy();
  }
}

/**
 * Throws when WebGPU cannot draw (no `navigator.gpu`, no adapter, no device,
 * a lost device or a failing shader), before the canvas gets a WebGPU
 * context, so the caller can still fall back to WebGL2 on the same canvas.
 */
export async function createWebGpu(
  options: GpuOptions & { device?: GPUDevice; format?: GPUTextureFormat },
): Promise<Gpu> {
  const owned = options.device ? null : await init(),
    device = options.device ?? owned!.device.gpu;
  const fail = (error: Error): never => {
    owned?.dispose();
    throw error;
  };
  let lostReason: string | null = null;
  const lost = device.lost.then((info) => {
    lostReason = info.message || info.reason || "WebGPU device lost";
    return lostReason;
  });
  const format =
    options.format ??
    (options.canvas ? navigator.gpu.getPreferredCanvasFormat() : "rgba8unorm");
  const module = device.createShaderModule({ code: shader });
  const errors = (await module.getCompilationInfo()).messages.filter(
    (m) => m.type === "error",
  );
  if (errors.length)
    fail(
      new Error(
        errors
          .map((m) => `WGSL ${m.lineNum}:${m.linePos}: ${m.message}`)
          .join("\n"),
      ),
    );
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { viewDimension: "2d-array" },
      },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      {
        binding: 3,
        visibility: GPUShaderStage.VERTEX,
        texture: { sampleType: "unfilterable-float" },
      },
    ],
  });
  const pipeline = await device
    .createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: INSTANCE_FLOATS * 4,
            stepMode: "instance",
            attributes: Array.from({ length: 6 }, (_, i) => ({
              shaderLocation: i,
              offset: i * 16,
              format: "float32x4" as GPUVertexFormat,
            })),
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    })
    .catch((error: unknown) =>
      fail(error instanceof Error ? error : new Error(String(error))),
    );
  // A device lost while starting up (e.g. a GPU reset) cannot draw either.
  await Promise.resolve();
  if (lostReason) fail(new Error(lostReason));
  // Only now does the canvas get its WebGPU context.
  const shown = bitmapPresentation(options);
  const context = (shown?.offscreen ?? options.canvas)?.getContext(
    "webgpu",
  ) as GPUCanvasContext | null;
  if (options.canvas && !context)
    fail(new Error("The canvas has no WebGPU context"));
  context?.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    }),
    overlayBuffer = device.createBuffer({
      size: MAX_OVERLAYS * INSTANCE_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  let atlas: GPUTexture | undefined,
    table: GPUTexture | undefined,
    bindings: GPUBindGroup | undefined,
    instances: GPUBuffer | undefined,
    textureBytes = 0;
  const attachment: GPURenderPassColorAttachment = {
      view: undefined as unknown as GPUTextureView,
      loadOp: "clear",
      storeOp: "store",
      clearValue: options.clear,
    },
    passDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [attachment],
    },
    commands: GPUCommandBuffer[] = [];

  const gpu: Gpu = {
    backend: "webgpu",
    device,
    format,
    limits: device.limits,
    lost,
    get textureBytes() {
      return textureBytes;
    },
    setAtlas(build) {
      let next: GPUTexture | undefined,
        bytes = 0;
      const frames = build({
        limits: device.limits,
        allocate(width, height, pages) {
          next = device.createTexture({
            size: [width, height, pages],
            format: "rgba8unorm",
            usage:
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.RENDER_ATTACHMENT,
          });
          bytes = width * height * pages * 4;
        },
        upload(page, x, y, source, [fromX, fromY], size) {
          device.queue.copyExternalImageToTexture(
            { source, origin: { x: fromX, y: fromY } },
            { texture: next!, origin: [x, y, page], premultipliedAlpha: false },
            size,
          );
        },
      });
      const texels = frames.length / 4,
        rows = frameTableRows(texels, FRAME_TABLE_WIDTH),
        padded = new Float32Array(rows * FRAME_TABLE_WIDTH * 4);
      padded.set(frames);
      const nextTable = device.createTexture({
        size: [FRAME_TABLE_WIDTH, rows],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: nextTable },
        padded,
        { bytesPerRow: FRAME_TABLE_WIDTH * 16 },
        [FRAME_TABLE_WIDTH, rows],
      );
      atlas?.destroy();
      table?.destroy();
      atlas = next!;
      table = nextTable;
      textureBytes = bytes + padded.byteLength;
      bindings = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          {
            binding: 1,
            resource: atlas.createView({ dimension: "2d-array" }),
          },
          { binding: 2, resource: sampler },
          { binding: 3, resource: table.createView() },
        ],
      });
    },
    setInstances(data) {
      instances?.destroy();
      instances = device.createBuffer({
        size: Math.max(INSTANCE_FLOATS * 4, data.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      if (data.length) device.queue.writeBuffer(instances, 0, data);
    },
    resize(width, height) {
      if (!options.canvas) return;
      options.canvas.width = width;
      options.canvas.height = height;
      if (shown) {
        shown.offscreen.width = width;
        shown.offscreen.height = height;
      }
    },
    draw(call) {
      device.queue.writeBuffer(uniformBuffer, 0, call.uniforms);
      const target = call.target as Target | undefined;
      attachment.view =
        target?.view ?? context!.getCurrentTexture().createView();
      passDescriptor.timestampWrites = call.timestampWrites;
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginRenderPass(passDescriptor);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings!);
      pass.setVertexBuffer(0, instances!);
      for (const chunk of call.chunks)
        pass.draw(6, chunk.count, 0, chunk.first);
      if (call.overlayCount) {
        device.queue.writeBuffer(
          overlayBuffer,
          0,
          call.overlays.buffer,
          call.overlays.byteOffset,
          call.overlayCount * INSTANCE_FLOATS * 4,
        );
        pass.setVertexBuffer(0, overlayBuffer);
        pass.draw(6, call.overlayCount);
      }
      pass.end();
      target?.copy(encoder);
      commands[0] = encoder.finish();
      device.queue.submit(commands);
      if (!target && shown)
        shown.bitmap.transferFromImageBitmap(
          shown.offscreen.transferToImageBitmap(),
        );
    },
    createTarget(width, height) {
      return new Target(device, width, height);
    },
    finished: () => device.queue.onSubmittedWorkDone(),
    destroy() {
      instances?.destroy();
      uniformBuffer.destroy();
      overlayBuffer.destroy();
      atlas?.destroy();
      table?.destroy();
      context?.unconfigure();
      owned?.dispose();
    },
  };
  return gpu;
}
