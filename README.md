# StayFinder backend

Hono + TypeScript API on top of Supabase (Postgres, Auth, RLS).

## Run

```
npm install
npx supabase start          # needs Docker; applies supabase/migrations
cp .env.example .env        # fill SUPABASE_PUBLISHABLE_KEY from `npx supabase status`
npm run dev                 # http://localhost:8787
npm test                    # integration tests = the "test calls" file (test/api.test.ts)
```

## Where rules live

| Rule | API | Database |
|---|---|---|
| Login state | cookie session, `/auth/*` | Supabase Auth |
| Ownership (G6, VG1) | 401/403/404 mapping | RLS policies |
| Input validation (G10) | zod, 400 with per-field messages | CHECK constraints |
| No double booking (VG2) | maps 23P01 to 409 | `EXCLUDE USING gist` |
| Capacity, past check-in, price, status flow, time rules (VG3-VG6) | maps trigger errors | `bookings_guard` trigger |
| Availability search (VG7) | `/properties?from=&to=` | `available_property_ids()` (security definer) |
| Sorting/filters (G5, G8) | query building | indexes/ORDER BY |

The API always calls PostgREST with the user's JWT, so RLS applies to every query.

## Criteria

G1-G16 and VG1-VG7 are implemented (see the tests, one `describe` per criterion).
