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
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": "routes.duration"
    },
    body: JSON.stringify({
  origin: {
    location: {
      latLng: {
        latitude: origin.lat,
        longitude: origin.lng
      }
    }
  },
  destination: {
    location: {
      latLng: {
        latitude: destination.lat,
        longitude: destination.lng
      }
    }
  },
  travelMode: "DRIVE"
})

  });

  // HTTP failure guard
  if (!res.ok) {
    console.error("ROUTES HTTP ERROR", await res.text());
    return null;
  }

  const data = await res.json();

  // ⭐ CRITICAL DEFENSIVE GUARDS
  if (!data.routes || data.routes.length === 0) {
    console.warn("ROUTES: no route returned", data);
    return null;
  }

  const durationStr = data.routes[0]?.duration;
  if (!durationStr) {
    console.warn("ROUTES: duration missing", data.routes[0]);
    return null;
  }

  const seconds = Number(durationStr.replace("s", ""));
  if (!Number.isFinite(seconds)) {
    console.warn("ROUTES: invalid duration", durationStr);
    return null;
  }

  return seconds / 60; // minutes
}


export default async function getTravelMinutes(originAddress, destAddress, memoryCache = {}) {
  const geocodeCache = memoryCache.geocodeCache;
  const routeCache = memoryCache.routeCache;

  const origin = await geocodeAddress(originAddress, geocodeCache);
  const dest = await geocodeAddress(destAddress, geocodeCache);
  const routeKey = `${origin.lat},${origin.lng}|${dest.lat},${dest.lng}`;

  if (routeCache?.has(routeKey)) {
    return routeCache.get(routeKey);
  }

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

  if (cached) {
    routeCache?.set(routeKey, cached.minutes_rounded);
    return cached.minutes_rounded;
  }

  // 2️⃣ Call Google Routes
let minutes = await fetchGoogleRoute(origin, dest);

// ⭐ FAIL-SAFE: routing must never break booking
if (!minutes) {
  console.warn("Travel routing fallback used");
  minutes = 30; // safe default travel time
}

const rounded = roundUpTo10(minutes);


  // 3️⃣ Save cache
  await supabase.from("travel_cache").upsert({
    origin_lat: origin.lat,
    origin_lng: origin.lng,
    dest_lat: dest.lat,
    dest_lng: dest.lng,
    minutes_rounded: rounded
  });

  routeCache?.set(routeKey, rounded);

  return rounded;
}
