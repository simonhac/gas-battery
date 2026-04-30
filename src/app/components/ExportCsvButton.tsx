'use client';

import { useState } from 'react';
import { downloadCsv } from '@/lib/tod/csv-export';

function formatRowCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}

export function ExportCsvButton({
  label = 'Export CSV',
  filename,
  getCsv,
  rowCount,
  disabled,
}: {
  label?: string;
  filename: string;
  getCsv: () => string;
  rowCount?: number;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const onClick = () => {
    setBusy(true);
    // Defer so the button repaints as "busy" before the (potentially slow) build.
    setTimeout(() => {
      try {
        const csv = getCsv();
        downloadCsv(filename, csv);
      } finally {
        setBusy(false);
      }
    }, 0);
  };

  const fullLabel =
    rowCount !== undefined ? `${label} (${formatRowCount(rowCount)} row CSV)` : label;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
    >
      {busy ? 'Exporting…' : fullLabel}
    </button>
  );
}
