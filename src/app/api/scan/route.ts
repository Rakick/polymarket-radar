import { NextRequest, NextResponse } from "next/server";
import { hasValidCronSecret } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The legacy Next.js scanner used the retired V1/V2 scoring engines.
 * Production scans now run exclusively through the authenticated
 * polymarket-hourly-scan Supabase Edge Function.
 */
export async function POST(request: NextRequest) {
  if (!hasValidCronSecret(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    { error: "Scanner historique désactivé. Le scan BUY unifié est exécuté par Supabase Edge Functions." },
    { status: 410 },
  );
}
