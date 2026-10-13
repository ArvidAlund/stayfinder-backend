import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthUser } from "./types.js";

// Variables set by the auth middleware and read in routes.
export type AppEnv = {
  Variables: {
    db: SupabaseClient; // acts as the logged-in user (or anon) so RLS applies
    user: AuthUser | null;
  };
};
