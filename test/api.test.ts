// Integration tests / "test calls" against the API. Needs `npx supabase start` running.
// Each test user gets its own cookie jar, just like separate browsers.
import { execSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { clientFor } from "../src/supabase.js";

class Client {
  private cookies = new Map<string, string>();
  async call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split("; ");
      const k = pair.slice(0, pair.indexOf("="));
      const v = pair.slice(pair.indexOf("=") + 1);
      if (v === "" || attrs.some((a) => /^Max-Age=0$/i.test(a))) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const run = Date.now();
const email = (n: string) => `${n}-${run}@test.se`;
const anon = new Client();
const owner = new Client();
const guest = new Client();
const other = new Client();
let propertyId = "";
let bookingId = "";

const book = (c: Client, over: object = {}) =>
  c.call("POST", `/properties/${propertyId}/bookings`, {
    guest_email: "g@test.se",
    check_in: day(10),
    check_out: day(13),
    guests: 2,
    ...over,
  });

beforeAll(async () => {
  for (const [c, n] of [[owner, "owner"], [guest, "guest"], [other, "other"]] as const) {
    const r = await c.call("POST", "/auth/register", { email: email(n), password: "secret1" });
    expect(r.status).toBe(201);
  }
  const p = await owner.call("POST", "/properties", {
    title: "Test loft",
    location: "Gothenburg",
    price_per_night: 1000,
    max_guests: 3,
  });
  propertyId = p.body.id;
});

describe("G1-G3 auth", () => {
  it("rejects duplicate registration (409) and bad credentials (401)", async () => {
    expect((await anon.call("POST", "/auth/register", { email: email("owner"), password: "secret1" })).status).toBe(409);
    expect((await anon.call("POST", "/auth/login", { email: email("owner"), password: "wrong-pass" })).status).toBe(401);
  });
  it("login sets a session that /me reads; logout clears it", async () => {
    const c = new Client();
    expect((await c.call("POST", "/auth/login", { email: email("guest"), password: "secret1" })).status).toBe(200);
    expect((await c.call("GET", "/auth/me")).body.email).toBe(email("guest"));
    expect((await c.call("POST", "/auth/logout")).status).toBe(204);
    expect((await c.call("GET", "/auth/me")).status).toBe(401);
  });
});

describe("properties (G4-G8, G14, VG1)", () => {
  it("anyone can list and read; unknown id is 404", async () => {
    expect((await anon.call("GET", "/properties")).status).toBe(200);
    expect((await anon.call("GET", `/properties/${propertyId}`)).status).toBe(200);
    expect((await anon.call("GET", "/properties/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
  it("anonymous create is 401, invalid data is 400", async () => {
    expect((await anon.call("POST", "/properties", { title: "x", location: "y", price_per_night: 1, max_guests: 1 })).status).toBe(401);
    expect((await owner.call("POST", "/properties", { title: "", location: "y", price_per_night: 0, max_guests: 1 })).status).toBe(400);
  });
  it("filters and sorts in the backend", async () => {
    await owner.call("POST", "/properties", { title: "Cheap", location: "Gothenburg", price_per_night: 100, max_guests: 1 });
    const asc = (await anon.call("GET", "/properties?location=gothenburg&sort=price_asc")).body;
    const desc = (await anon.call("GET", "/properties?location=gothenburg&sort=price_desc")).body;
    expect(asc[0].price_per_night).toBeLessThanOrEqual(asc.at(-1).price_per_night);
    expect(desc[0].price_per_night).toBeGreaterThanOrEqual(desc.at(-1).price_per_night);
    const maxPrice = (await anon.call("GET", "/properties?location=gothenburg&max_price=500&guests=1")).body;
    expect(maxPrice.length).toBeGreaterThan(0);
    expect(maxPrice.every((p: { price_per_night: number }) => p.price_per_night <= 500)).toBe(true);
    const guests = (await anon.call("GET", "/properties?location=gothenburg&guests=3")).body;
    expect(guests.every((p: { max_guests: number }) => p.max_guests >= 3)).toBe(true);
  });
  it("only the owner can change or delete (403)", async () => {
    expect((await other.call("PATCH", `/properties/${propertyId}`, { title: "hacked" })).status).toBe(403);
    expect((await other.call("DELETE", `/properties/${propertyId}`)).status).toBe(403);
    expect((await anon.call("PATCH", `/properties/${propertyId}`, { title: "hacked" })).status).toBe(401);
    expect((await owner.call("PATCH", `/properties/${propertyId}`, { title: "Test loft" })).status).toBe(200);
  });
  it("G15: calling the database directly without a session is blocked by RLS", async () => {
    const db = clientFor(); // anon key, no user
    const { data } = await db.from("properties").update({ title: "hacked" }).eq("id", propertyId).select();
    expect(data).toEqual([]);
    const ins = await db.from("properties").insert({ title: "a", location: "b", price_per_night: 1, max_guests: 1 });
    expect(ins.error).not.toBeNull();
    const bookings = await db.from("bookings").select("*");
    expect(bookings.error).not.toBeNull();
  });
});

describe("bookings: validation (G9-G10)", () => {
  it("anonymous booking is 401", async () => expect((await book(anon)).status).toBe(401));
  it("rejects invalid email, zero guests and check-in after check-out (400)", async () => {
    expect((await book(guest, { guest_email: "nope" })).body.details.guest_email).toBeDefined();
    expect((await book(guest, { guests: 0 })).body.details.guests).toBeDefined();
    expect((await book(guest, { check_in: day(13), check_out: day(10) })).body.details.check_out).toBeDefined();
  });
});

describe("VG3 capacity, VG5 past, VG6 price", () => {
  it("denies more guests than the property allows (422)", async () => {
    const r = await book(guest, { guests: 4 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("CAPACITY_EXCEEDED");
  });
  it("denies check-in in the past (422)", async () => {
    const r = await book(guest, { check_in: day(-2), check_out: day(1) });
    expect(r.body.code).toBe("CHECKIN_IN_PAST");
  });
  it("calculates total on the server and ignores client price/status", async () => {
    const r = await book(guest, { total_price: 1, price_per_night: 1, status: "confirmed", guest_id: "x" });
    expect(r.status).toBe(201);
    expect(r.body.total_price).toBe(3000);
    expect(r.body.status).toBe("pending");
    bookingId = r.body.id;
  });
  it("later price changes do not affect existing bookings", async () => {
    await owner.call("PATCH", `/properties/${propertyId}`, { price_per_night: 5000 });
    expect((await guest.call("GET", `/bookings/${bookingId}`)).body.total_price).toBe(3000);
    const upd = await guest.call("PATCH", `/bookings/${bookingId}`, { check_out: day(14) });
    expect(upd.body.total_price).toBe(4000); // snapshot price 1000 x 4 nights
  });
});

describe("VG2 no double bookings", () => {
  it("denies overlapping dates with 409 BOOKING_OVERLAP", async () => {
    const r = await book(other, { check_in: day(12), check_out: day(15) });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("BOOKING_OVERLAP");
  });
  it("allows back-to-back (check-out day = next check-in)", async () => {
    expect((await book(other, { check_in: day(14), check_out: day(16) })).status).toBe(201);
  });
  it("a booking does not conflict with itself when edited, but does with others when moved", async () => {
    expect((await guest.call("PATCH", `/bookings/${bookingId}`, { check_in: day(11) })).status).toBe(200);
    expect((await guest.call("PATCH", `/bookings/${bookingId}`, { check_out: day(15) })).body.code).toBe("BOOKING_OVERLAP");
  });
  it("cancelled bookings free the dates", async () => {
    const tmp = (await book(guest, { check_in: day(30), check_out: day(32) })).body.id;
    expect((await book(other, { check_in: day(30), check_out: day(32) })).status).toBe(409);
    await guest.call("PATCH", `/bookings/${tmp}`, { status: "cancelled" });
    expect((await book(other, { check_in: day(30), check_out: day(32) })).status).toBe(201);
  });
});

describe("VG1 ownership of bookings", () => {
  it("guest sees own, owner sees all, a stranger sees none", async () => {
    const ownerSees = (await owner.call("GET", `/properties/${propertyId}/bookings`)).body.length;
    const guestSees = (await guest.call("GET", `/properties/${propertyId}/bookings`)).body.length;
    expect(ownerSees).toBeGreaterThan(guestSees);
    const third = new Client();
    await third.call("POST", "/auth/register", { email: email("third"), password: "secret1" });
    expect((await third.call("GET", `/properties/${propertyId}/bookings`)).body).toEqual([]);
    expect((await third.call("GET", `/bookings/${bookingId}`)).status).toBe(404);
    expect((await third.call("PATCH", `/bookings/${bookingId}`, { guests: 1 })).status).toBe(404);
    expect((await third.call("DELETE", `/bookings/${bookingId}`)).status).toBe(404);
  });
});

describe("VG4 status flow", () => {
  it("guest cannot confirm; owner can; owner cannot edit details", async () => {
    expect((await guest.call("PATCH", `/bookings/${bookingId}`, { status: "confirmed" })).body.code).toBe("FORBIDDEN_TRANSITION");
    expect((await owner.call("PATCH", `/bookings/${bookingId}`, { guests: 1 })).body.code).toBe("FORBIDDEN_EDIT");
    expect((await owner.call("PATCH", `/bookings/${bookingId}`, { status: "confirmed" })).body.status).toBe("confirmed");
  });
  it("both can cancel; cancelled booking cannot be changed", async () => {
    expect((await guest.call("PATCH", `/bookings/${bookingId}`, { status: "cancelled" })).body.status).toBe("cancelled");
    const r = await guest.call("PATCH", `/bookings/${bookingId}`, { guests: 1 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("BOOKING_CANCELLED");
    const b2 = (await book(guest, { check_in: day(40), check_out: day(41) })).body.id;
    expect((await owner.call("PATCH", `/bookings/${b2}`, { status: "cancelled" })).body.status).toBe("cancelled");
  });
  it("status 'pending' is not accepted from clients (400)", async () => {
    expect((await guest.call("PATCH", `/bookings/${bookingId}`, { status: "pending" })).status).toBe(400);
  });
});

describe("VG5 time rules on existing bookings", () => {
  it("booking whose check-in has passed cannot be changed, cancelled or deleted", async () => {
    const id = (await book(guest, { check_in: day(50), check_out: day(52) })).body.id;
    // simulate time passing: move it into the past directly in the DB with the trigger off
    const sql = `alter table bookings disable trigger bookings_guard_trg; update bookings set check_in = current_date - 3, check_out = current_date - 1 where id = '${id}'; alter table bookings enable trigger bookings_guard_trg;`;
    execSync(`docker exec supabase_db_backend psql -U postgres -c "${sql}"`);
    expect((await guest.call("PATCH", `/bookings/${id}`, { guests: 1 })).body.code).toBe("CHECKIN_PASSED");
    expect((await guest.call("PATCH", `/bookings/${id}`, { status: "cancelled" })).body.code).toBe("CHECKIN_PASSED");
    expect((await guest.call("DELETE", `/bookings/${id}`)).body.code).toBe("CHECKIN_PASSED");
  });
});

describe("G12 delete + VG7 availability search", () => {
  it("guest can delete own booking (204)", async () => {
    const id = (await book(guest, { check_in: day(60), check_out: day(61) })).body.id;
    expect((await guest.call("DELETE", `/bookings/${id}`)).status).toBe(204);
  });
  it("lists only free properties for a period, combinable with filters; bad period is 400", async () => {
    await book(guest, { check_in: day(70), check_out: day(75) });
    const q = (from: string, to: string) => anon.call("GET", `/properties?from=${from}&to=${to}&location=gothenburg&sort=price_asc`);
    const busy = (await q(day(71), day(73))).body.map((p: { id: string }) => p.id);
    expect(busy).not.toContain(propertyId);
    const free = (await q(day(75), day(77))).body.map((p: { id: string }) => p.id);
    expect(free).toContain(propertyId);
    expect((await q(day(77), day(75))).status).toBe(400);
    expect((await anon.call("GET", `/properties?from=${day(1)}`)).status).toBe(400);
  });
});
