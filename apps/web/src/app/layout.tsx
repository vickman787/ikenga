import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ikenga — Agents do the work, the CFO runs the money",
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
