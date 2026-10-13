import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/** Client that sends the user's JWT to PostgREST, so Postgres RLS sees auth.uid(). */
export function clientFor(accessToken?: string) {
  return createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}
