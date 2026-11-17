import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/supabase";
export const dynamic = "force-dynamic";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function safeEqual(a: string, b: string) { const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
async function sendTelegram(chatId: number, text: string) {
  const token=process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});
  if (!response.ok) throw new Error(`Telegram API returned ${response.status}`);
}
export async function POST(request: NextRequest) {
  const secret=process.env.TELEGRAM_WEBHOOK_SECRET??"", supplied=request.headers.get("x-telegram-bot-api-secret-token")??"";
  if (!secret || !safeEqual(secret,supplied)) return NextResponse.json({error:"unauthorized"},{status:401});
  let update:any; try { update=await request.json(); } catch { return NextResponse.json({ok:true}); }
  const message=update?.message, text=String(message?.text??""), chatId=Number(message?.chat?.id);
  if (!Number.isSafeInteger(chatId) || !text.startsWith("/start ")) return NextResponse.json({ok:true});
  const code=text.slice(7).trim();
  if (!/^[A-Za-z0-9_-]{24,80}$/.test(code)) return NextResponse.json({ok:true});
  const db=adminClient(), digest=sha256(code);
  const {data:link,error}=await db.from("telegram_link_codes").select("user_id,expires_at,consumed_at").eq("code_hash",digest).maybeSingle();
  if(error || !link || link.consumed_at || Date.parse(link.expires_at)<=Date.now()) {
    await sendTelegram(chatId,"Lien de connexion invalide ou expiré. Retournez dans Polymarket Radar pour en générer un nouveau.");
    return NextResponse.json({ok:true});
  }
  const username=typeof message.from?.username==="string"?message.from.username:null;
  const {error:saveError}=await db.from("telegram_connections").upsert({user_id:link.user_id,chat_id:chatId,telegram_username:username,enabled:true,updated_at:new Date().toISOString()},{onConflict:"user_id"});
  if(saveError) return NextResponse.json({error:"connection_failed"},{status:500});
  await db.from("telegram_link_codes").update({consumed_at:new Date().toISOString()}).eq("code_hash",digest).is("consumed_at",null);
  await sendTelegram(chatId,"✅ Polymarket Radar est connecté. Vous recevrez un message uniquement lorsqu'une alerte valide les 6 critères.");
  return NextResponse.json({ok:true});
}