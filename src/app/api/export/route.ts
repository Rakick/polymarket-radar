import {NextRequest,NextResponse} from "next/server";
import {adminClient} from "@/lib/supabase";
import {hasAuthenticatedUser} from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(r:NextRequest){
  if(!await hasAuthenticatedUser(r)) return NextResponse.json({error:"unauthorized"},{status:401});
  const{data,error}=await adminClient().from("alerts").select("*").limit(10000);
  if(error) return NextResponse.json({error:error.message},{status:500});
  if(r.nextUrl.searchParams.get("format")==="json") return NextResponse.json(data??[]);
  const rows=data??[];
  const head=Object.keys(rows[0]??{score:""}).join(",");
  const csv=[head,...rows.map(x=>Object.values(x).map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(","))].join("\n");
  return new NextResponse(csv,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=alerts.csv"}});
}
