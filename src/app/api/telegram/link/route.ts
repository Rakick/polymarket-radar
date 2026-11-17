import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { getAuthenticatedUser } from "@/lib/api-auth";
export const dynamic = "force-dynamic";
const botUsername = "PLpolyMalertBot";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data, error } = await adminClient().from("telegram_connections").select("telegram_username,enabled").eq("user_id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connected: !!data?.enabled, username: data?.telegram_username ?? null });
}
export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const code = randomBytes(24).toString("base64url");
  const { error } = await adminClient().from("telegram_link_codes").insert({ code_hash: digest(code), user_id: user.id, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ url: `https://t.me/${botUsername}?start=${code}`, expiresInMinutes: 10 });
}