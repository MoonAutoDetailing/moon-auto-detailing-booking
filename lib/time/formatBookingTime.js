export function formatBookingTimeRange(startISO, endISO) {
  const optionsDate = {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  };

  const optionsTime = {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit"
  };

  const start = new Date(startISO);
  const end = new Date(endISO);

  const datePart = start.toLocaleDateString("en-US", optionsDate);
  const startTime = start.toLocaleTimeString("en-US", optionsTime);
  const endTime = end.toLocaleTimeString("en-US", optionsTime);

  return `${datePart} • ${startTime} – ${endTime} (Eastern Time)`;
}
