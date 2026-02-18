import { createClient } from "@supabase/supabase-js";
import geocodeAddress from "./geocodeAddress.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function roundUpTo10(mins) {
  return Math.ceil(mins / 10) * 10;
}

async function fetchGoogleRoute(origin, destination) {
  const url = "https://routes.googleapis.com/directions/v2:computeRoutes";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY
    },
    body: JSON.stringify({
      origin: { location: { latLng: origin } },
      destination: { location: { latLng: destination } },
      travelMode: "DRIVE"
    })
  });

  const data = await res.json();
  const seconds = data.routes[0].duration.replace("s", "");
  return Number(seconds) / 60;
}

export default async function getTravelMinutes(originAddress, destAddress) {
  const origin = await geocodeAddress(originAddress);
  const dest = await geocodeAddress(destAddress);

  // 1️⃣ Check cache
  const { data: cached } = await supabase
    .from("travel_cache")
    .select("*")
    .match({
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      dest_lat: dest.lat,
      dest_lng: dest.lng
    })
    .single();

  if (cached) return cached.minutes_rounded;

  // 2️⃣ Call Google Routes
  const minutes = await fetchGoogleRoute(origin, dest);
  const rounded = roundUpTo10(minutes);

  // 3️⃣ Save cache
  await supabase.from("travel_cache").upsert({
    origin_lat: origin.lat,
    origin_lng: origin.lng,
    dest_lat: dest.lat,
    dest_lng: dest.lng,
    minutes_rounded: rounded
  });

  return rounded;
}
