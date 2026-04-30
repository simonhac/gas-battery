'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Track the width of a container via ResizeObserver. Pair with a wrapper that
 * has fluid CSS width (e.g. `className="w-full"`) so the rendered child can
 * size its SVG/canvas to exact CSS pixels — keeping intrinsic margins, axes,
 * and labels at fixed pixel sizes while the chart canvas shrinks/grows with
 * the page.
 *
 *   const [width, ref] = useContainerWidth(initial);
 *   return (
 *     <div ref={ref} className="w-full">
 *       <svg width={width} height={height} />
 *     </div>
 *   );
 *
 * `initial` is used for SSR + first paint before the observer fires.
 */
export function useContainerWidth(initial: number): [number, (node: HTMLDivElement | null) => void] {
  const [width, setWidth] = useState(initial);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (node) {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = Math.round(entry.contentRect.width);
          if (w > 0) setWidth(w);
        }
      });
      ro.observe(node);
      observerRef.current = ro;
      const w = Math.round(node.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    }
  }, []);

  return [width, ref];
}
