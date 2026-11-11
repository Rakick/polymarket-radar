import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase";

/** Validate a Supabase access token against Auth; never trust client-supplied user data. */
export async function hasAuthenticatedUser(request: NextRequest): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;

  try {
    const { data, error } = await adminClient().auth.getUser(match[1]);
    return !error && !!data.user;
  } catch {
    return false;
  }
}

/** Protect machine-triggered scans with a server-only shared secret. */
export function hasValidCronSecret(request: NextRequest): boolean {
  const configured = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!configured || !match) return false;

  // Length check avoids timingSafeEqual throwing for differently sized buffers.
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(configured);
  if (supplied.length !== expected.length) return false;
  // Compare bytes without an early-exit string comparison.
  return require("node:crypto").timingSafeEqual(supplied, expected);
}
