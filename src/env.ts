import "dotenv/config";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const env = {
  supabaseUrl: need("SUPABASE_URL"),
  supabaseKey: need("SUPABASE_PUBLISHABLE_KEY"),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",
  port: Number(process.env.PORT ?? 8787),
  secureCookies: process.env.NODE_ENV === "production",
};
