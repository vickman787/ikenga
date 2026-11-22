import type { NextConfig } from "next";

// The ledger package reads its SQL schema from packages/ledger/dist/schema.sql
// at runtime; include it in file tracing so server functions can find it.
const ledgerSchema = [
  "../../packages/ledger/dist/schema.sql",
  "packages/ledger/dist/schema.sql",
];

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/": ledgerSchema,
    "/api/jobs": ledgerSchema,
  },
};

export default nextConfig;
