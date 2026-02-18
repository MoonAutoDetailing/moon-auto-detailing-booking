import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchGoogleGeocode(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.results?.length) {
  console.error("GEOCODE FAILED", address, data);
  throw new Error("Geocode failed");
}

  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

export default async function geocodeAddress(address, memoryCache) {
  if (memoryCache?.has(address)) {
    return memoryCache.get(address);
  }

  // 1️⃣ Check cache first
  const { data: cached } = await supabase
    .from("geocode_cache")
    .select("*")
    .eq("address_text", address)
    .single();

  if (cached) {
    const cachedCoords = { lat: cached.lat, lng: cached.lng };
    memoryCache?.set(address, cachedCoords);
    return cachedCoords;
  }

  // 2️⃣ Call Google if cache miss
  const coords = await fetchGoogleGeocode(address);

  // 3️⃣ Save to cache (fire and forget)
  await supabase.from("geocode_cache").upsert({
    address_text: address,
    lat: coords.lat,
    lng: coords.lng
  });

  memoryCache?.set(address, coords);

  return coords;
}
