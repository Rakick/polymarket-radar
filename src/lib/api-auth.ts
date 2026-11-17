import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/supabase";
export async function getAuthenticatedUser(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\\s+(.+)$/i.exec(authorization);
  if (!match) return null;
  try {
    const { data, error } = await adminClient().auth.getUser(match[1]);
    return !error ? data.user ?? null : null;
  } catch { return null; }
}
export async function hasAuthenticatedUser(request: NextRequest): Promise<boolean> {
  return !!(await getAuthenticatedUser(request));
}
export function hasValidCronSecret(request: NextRequest): boolean {
  const configured = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\\s+(.+)$/i.exec(authorization);
  if (!configured || !match) return false;
  const supplied = Buffer.from(match[1]), expected = Buffer.from(configured);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}