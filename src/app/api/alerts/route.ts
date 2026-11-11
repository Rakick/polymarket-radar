import {NextRequest,NextResponse} from "next/server";
import {adminClient} from "@/lib/supabase";
import {hasAuthenticatedUser} from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(r:NextRequest){
  if(!await hasAuthenticatedUser(r)) return NextResponse.json({error:"unauthorized"},{status:401});
  const{data,error}=await adminClient().from("alerts").select("*").order("score",{ascending:false}).limit(200);
  return error?NextResponse.json({error:error.message},{status:500}):NextResponse.json({alerts:data??[]});
}
