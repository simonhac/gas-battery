import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DM_Sans } from 'next/font/google';
import { Nav } from './components/Nav';
import './globals.css';
import 'react-day-picker/style.css';

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin'],
});

const SITE_URL = 'https://simonhac.github.io/gas-battery/';
const TITLE = 'Gas & Batteries in Australia';
const DESCRIPTION =
  'Time-of-day generation profile for the National Electricity Market — peaking gas and battery discharging, at 5-minute resolution.';
// Relative URL (no leading slash) so it resolves against metadataBase including the /gas-battery/ basePath.
const OG_IMAGE = 'og-image.png';
const OG_IMAGE_ALT =
  'NEM 12-month time-of-day generation profile — peaking gas and battery discharging.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: TITLE,
    type: 'website',
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        type: 'image/png',
        alt: OG_IMAGE_ALT,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Suspense fallback={null}>
          <Nav />
        </Suspense>
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
