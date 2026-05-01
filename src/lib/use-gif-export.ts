'use client';

import { useCallback, useRef, useState, type RefObject } from 'react';
import { domToCanvas, type Options as ScreenshotOptions } from 'modern-screenshot';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';

export type GifExportPhase = 'capturing' | 'encoding';
export type GifExportProgress = { phase: GifExportPhase; current: number; total: number };

export function useGifExport(opts: {
  captureRef: RefObject<HTMLElement | null>;
  getRange: () => { first: number; last: number } | null;
  getDurationSec: () => number;
  setFrameIdx: (f: number) => void;
  paddingPx: number;
  fps: number;
  filename: string;
}) {
  const { captureRef, getRange, getDurationSec, setFrameIdx, paddingPx, fps, filename } = opts;
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<GifExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  const exportGif = useCallback(async () => {
    if (runningRef.current) return;
    const range = getRange();
    const node = captureRef.current;
    if (!range || !node) return;
    const span = range.last - range.first;
    if (span <= 0) {
      setError('No frames to export — From and To dates resolve to the same frame.');
      return;
    }

    const totalFrames = Math.max(1, Math.round(getDurationSec() * fps));

    runningRef.current = true;
    setError(null);
    setIsExporting(true);
    setProgress({ phase: 'capturing', current: 0, total: totalFrames });

    type RawFrame = { data: Uint8ClampedArray; width: number; height: number };
    const frames: RawFrame[] = [];
    let lockedWidth = 0;
    let lockedHeight = 0;

    try {
      // Allow visibility:hidden on CSV buttons (and other isExporting-driven UI) to take effect.
      await yieldFrame();
      await yieldFrame();

      for (let i = 0; i < totalFrames; i++) {
        const f =
          i === totalFrames - 1
            ? range.last
            : range.first + Math.floor((i / totalFrames) * span);
        setFrameIdx(f);
        await yieldFrame();
        await yieldFrame();

        const captureOpts: ScreenshotOptions = {
          scale: 1,
          backgroundColor: '#ffffff',
          style: { padding: `${paddingPx}px`, margin: '0', boxSizing: 'content-box' },
        };
        if (lockedWidth > 0 && lockedHeight > 0) {
          captureOpts.width = lockedWidth;
          captureOpts.height = lockedHeight;
        }
        const canvas = await domToCanvas(node, captureOpts);
        if (lockedWidth === 0) {
          lockedWidth = canvas.width;
          lockedHeight = canvas.height;
        }
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Failed to acquire 2D context');
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        frames.push({ data: img.data, width: canvas.width, height: canvas.height });
        setProgress({ phase: 'capturing', current: i + 1, total: totalFrames });
      }

      setProgress({ phase: 'encoding', current: 0, total: frames.length });
      const gif = GIFEncoder();
      const delayMs = Math.round(1000 / fps);
      for (let i = 0; i < frames.length; i++) {
        const { data, width, height } = frames[i];
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, width, height, { palette, delay: delayMs });
        if (i % 8 === 7) await yieldFrame();
        setProgress({ phase: 'encoding', current: i + 1, total: frames.length });
      }
      gif.finish();

      const bytes = gif.bytes();
      const blob = new Blob([bytes as BlobPart], { type: 'image/gif' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setIsExporting(false);
      runningRef.current = false;
    }
  }, [captureRef, getRange, getDurationSec, setFrameIdx, paddingPx, fps, filename]);

  return { exportGif, isExporting, progress, error };
}

// Yields to layout/paint. requestAnimationFrame is the right primitive when the tab is visible,
// but Chrome throttles rAF (and setTimeout) to ~1 Hz on hidden tabs, which would freeze a long
// export. Fall back to MessageChannel — it's not subject to background throttling and still lets
// React flush queued state updates before the next capture.
function yieldFrame(): Promise<void> {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}
