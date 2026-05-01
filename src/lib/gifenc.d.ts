declare module 'gifenc' {
  export type RgbPalette = number[][];

  export interface QuantizeOptions {
    format?: 'rgb565' | 'rgb444' | 'rgba4444';
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): RgbPalette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: RgbPalette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;

  export interface WriteFrameOptions {
    palette?: RgbPalette;
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    repeat?: number;
    dispose?: number;
  }

  export interface GIFEncoderInstance {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      options?: WriteFrameOptions,
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
    bytesView: () => Uint8Array;
    writeHeader: () => void;
    reset: () => void;
    readonly buffer: ArrayBuffer;
  }

  export interface GIFEncoderOptions {
    auto?: boolean;
    initialCapacity?: number;
  }

  export function GIFEncoder(options?: GIFEncoderOptions): GIFEncoderInstance;
}
