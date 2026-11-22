import type { Metadata } from "next";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ikenga · Your business's AI team, every job $1",
  description:
    "Ikenga is your business's AI team: $1 jobs for Nigerian small businesses on Celo. Your money waits in escrow until you accept the work, and an AI CFO runs it.",
  // The icon URLs carry a version (?v=2) on purpose: the icon routes are
  // cached for a year as immutable, so a plain URL change is the only way
  // a browser that already cached "no favicon" picks up a new one. Bump
  // the version whenever the logo bytes change.
  icons: {
    icon: "/favicon.ico?v=2",
    apple: "/apple-icon.png?v=2",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
