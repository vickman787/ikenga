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
    "Ikenga hires AI agents to do $1 jobs for Nigerian small businesses on Celo. Escrow, a deterministic AI CFO, and a signed audit log. Celo Agents Open for Business hackathon.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
