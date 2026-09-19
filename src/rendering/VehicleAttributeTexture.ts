/**
 * Static per-vehicle attributes on the GPU: (type, colour index, flags, unused) as RGBA8,
 * indexed by vehicle id like the state texture. Uploaded when vehicles are (re)assigned,
 * not per frame, so LOD buckets only need to rewrite id lists.
 */

import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType } from "three";
import type { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import { STATE_TEXTURE_WIDTH } from "./VehicleStateTexture.ts";

export class VehicleAttributeTexture {
  readonly width = STATE_TEXTURE_WIDTH;
  readonly height: number;
  readonly texture: DataTexture;
  private readonly data: Uint8Array;

  constructor(capacity: number) {
    this.height = Math.max(1, Math.ceil(capacity / this.width));
    this.data = new Uint8Array(this.width * this.height * 4);
    this.texture = new DataTexture(this.data, this.width, this.height, RGBAFormat, UnsignedByteType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  upload(buffer: VehicleBuffer): void {
    const { type, color, flags } = buffer;
    const d = this.data;
    for (let i = 0, o = 0; i < buffer.count; i++, o += 4) {
      d[o] = type[i] as number;
      d[o + 1] = color[i] as number;
      d[o + 2] = flags[i] as number;
      d[o + 3] = 255;
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
