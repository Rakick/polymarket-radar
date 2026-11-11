import {NextRequest,NextResponse} from "next/server";
import {runScan} from "@/lib/scan";
import {hasValidCronSecret} from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration=300;

export async function POST(r:NextRequest){
  if(!hasValidCronSecret(r)) return NextResponse.json({error:"unauthorized"},{status:401});
  try{return NextResponse.json(await runScan())}
  catch(e){return NextResponse.json({error:(e as Error).message},{status:500})}
}
