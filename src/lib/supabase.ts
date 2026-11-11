import { createClient, SupabaseClient } from "@supabase/supabase-js";
export function supabaseUrl(){return process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL||"";}
export function browserClient():SupabaseClient{return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:true}});}
export function adminClient():SupabaseClient{const url=supabaseUrl(),key=process.env.SUPABASE_SERVICE_ROLE_KEY!;if(!url||!key)throw new Error("Variables SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requises cote serveur.");return createClient(url,key,{auth:{persistSession:false}});}
