import { Suspense } from 'react';
import { TodView } from './components/TodView';

export default function Home() {
  return (
    <main className="flex flex-col gap-4 px-8 pt-3 pb-8 max-w-6xl mx-auto w-full">
      <header>
        <h1 className="text-2xl font-semibold">Time-of-day generation profile — Gas & Batteries</h1>
      </header>
      <Suspense fallback={null}>
        <TodView />
      </Suspense>
    </main>
  );
}
