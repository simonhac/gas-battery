import { CompletenessTable } from '../components/CompletenessTable';

export const metadata = {
  title: 'Data completeness — Gas & Batteries',
  description:
    'Percentage of expected 5-minute samples present per region, fueltech and year for the AU NEM and WEM.',
};

export default function CompletenessPage() {
  return (
    <main className="flex flex-col gap-4 px-8 pt-3 pb-8 mx-auto w-full">
      <header>
        <h1 className="text-2xl font-semibold">Data completeness</h1>
      </header>
      <CompletenessTable />
    </main>
  );
}
