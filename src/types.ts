export type BookingStatus = "pending" | "confirmed" | "cancelled";

export type Property = {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  location: string;
  price_per_night: number;
  max_guests: number;
  created_at: string;
};

export type Booking = {
  id: string;
  property_id: string;
  guest_id: string;
  guest_email: string;
  check_in: string;
  check_out: string;
  guests: number;
  status: BookingStatus;
  price_per_night: number;
  total_price: number;
  created_at: string;
};

export type AuthUser = { id: string; email: string };
