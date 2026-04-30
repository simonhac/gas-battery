'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const VIEW_ITEMS = [
  { label: '28-day rolling', view: '28d' },
  { label: '12-month rolling', view: '12mo' },
  { label: 'Years', view: 'years' },
] as const;

export function Nav() {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const isHome = pathname === '/' || pathname === '';
  const isCompleteness = pathname.startsWith('/completeness');
  const currentView = searchParams.get('view') ?? '28d';

  function todHref(view: string): string {
    const qs = new URLSearchParams(searchParams.toString());
    qs.delete('view');
    if (view !== '28d') qs.set('view', view);
    const s = qs.toString();
    return s ? `/?${s}` : '/';
  }

  const items = [
    ...VIEW_ITEMS.map((vi) => ({
      label: vi.label,
      href: todHref(vi.view),
      active: isHome && currentView === vi.view,
    })),
    {
      label: 'Data completeness',
      href: '/completeness/',
      active: isCompleteness,
    },
  ];

  return (
    <nav className="px-8 pt-4 max-w-7xl mx-auto w-full text-sm text-zinc-600 dark:text-zinc-400 flex flex-wrap items-center">
      {items.map((item, i) => (
        <span key={item.label} className="flex items-center">
          {i > 0 && (
            <span className="px-2 text-zinc-400 dark:text-zinc-600 select-none" aria-hidden="true">
              •
            </span>
          )}
          {item.active ? (
            <span className="font-semibold text-zinc-900 dark:text-zinc-100" aria-current="page">
              {item.label}
            </span>
          ) : (
            <Link
              href={item.href}
              className="hover:text-zinc-900 dark:hover:text-zinc-100 underline-offset-4 hover:underline"
            >
              {item.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
