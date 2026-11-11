import {NextRequest,NextResponse} from "next/server";
import {getSettings,saveSettings} from "@/lib/settings";
import {hasAuthenticatedUser} from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(r:NextRequest){
  if(!await hasAuthenticatedUser(r)) return NextResponse.json({error:"unauthorized"},{status:401});
  return NextResponse.json(await getSettings());
}

export async function PUT(r:NextRequest){
  if(!await hasAuthenticatedUser(r)) return NextResponse.json({error:"unauthorized"},{status:401});
  let settings: unknown;
  try { settings=await r.json(); } catch { return NextResponse.json({error:"invalid_json"},{status:400}); }
  if(!settings || typeof settings!=="object" || Array.isArray(settings)) return NextResponse.json({error:"invalid_settings"},{status:400});
  try {
    await saveSettings(settings as Awaited<ReturnType<typeof getSettings>>);
    return NextResponse.json(settings);
  } catch(e) {
    return NextResponse.json({error:(e as Error).message},{status:500});
  }
}
