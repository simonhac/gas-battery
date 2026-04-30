'use client';

import { useEffect, useRef, useState } from 'react';
import { DayPicker, type Matcher } from 'react-day-picker';

const MONTHS_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatDateDisplay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_ABBR[m - 1]} ${y}`;
}

/** Parse "30 Apr 2025", "2025-04-30", or "30/04/2025" → ISO 'YYYY-MM-DD', else null. */
export function parseUserDate(input: string): string | null {
  const s = input.trim();
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m) {
    const day = Number.parseInt(m[1], 10);
    const monthName = m[2].slice(0, 3).toLowerCase();
    const month = MONTHS_ABBR.findIndex((mm) => mm.toLowerCase() === monthName);
    const year = Number.parseInt(m[3], 10);
    if (month >= 0 && day >= 1 && day <= 31) return iso(year, month, day);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const day = Number.parseInt(m[1], 10);
    const month = Number.parseInt(m[2], 10) - 1;
    const year = Number.parseInt(m[3], 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) return iso(year, month, day);
  }
  return null;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isoToDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function DateInput({
  value,
  onChange,
  minDate,
  maxDate,
}: {
  value: string;
  onChange: (iso: string) => void;
  minDate?: string;
  maxDate?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>(formatDateDisplay(value));
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Sync text to external value changes (e.g. picker selection, programmatic update).
  useEffect(() => {
    setText(formatDateDisplay(value));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const commitText = () => {
    const parsed = parseUserDate(text);
    if (parsed) {
      // Clamp to [minDate, maxDate] if provided.
      let next = parsed;
      if (minDate && next < minDate) next = minDate;
      if (maxDate && next > maxDate) next = maxDate;
      onChange(next);
      setText(formatDateDisplay(next));
    } else {
      // Reject invalid input — revert.
      setText(formatDateDisplay(value));
    }
  };

  const selected = isoToDate(value);
  const disabled: Matcher[] = [];
  if (minDate) disabled.push({ before: isoToDate(minDate) });
  if (maxDate) disabled.push({ after: isoToDate(maxDate) });

  return (
    <div ref={wrapperRef} className="relative inline-flex items-stretch">
      <input
        type="text"
        value={text}
        placeholder="30 Apr 2025"
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setText(formatDateDisplay(value));
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        className="w-28 rounded-l border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <button
        type="button"
        aria-label="Open calendar"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center rounded-r border border-l-0 border-zinc-300 bg-zinc-50 px-2 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700"
      >
        <CalendarIcon />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 rounded-md border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={(d) => {
              if (d) {
                onChange(dateToIso(d));
                setOpen(false);
              }
            }}
            defaultMonth={selected}
            disabled={disabled}
            weekStartsOn={1}
            showOutsideDays
          />
        </div>
      )}
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}
