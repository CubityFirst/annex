export interface TimezoneGroup {
  offset: string;
  offsetMinutes: number;
  iana: string;
  cities: string[];
  coords: [number, number]; // [lon, lat] - d3-geo convention
}

export const TIMEZONE_GROUPS: TimezoneGroup[] = [
  { offset: "UTC-12", offsetMinutes: -720, iana: "Etc/GMT+12", cities: ["Baker Island", "Howland Island"], coords: [-176.5, 0.2] },
  { offset: "UTC-11", offsetMinutes: -660, iana: "Pacific/Niue", cities: ["Niue", "Pago Pago", "Midway Island"], coords: [-169.9, -19.1] },
  { offset: "UTC-10", offsetMinutes: -600, iana: "Pacific/Honolulu", cities: ["Honolulu", "Tahiti", "Papeete"], coords: [-157.8, 21.3] },
  { offset: "UTC-9", offsetMinutes: -540, iana: "America/Anchorage", cities: ["Anchorage", "Juneau", "Fairbanks"], coords: [-149.9, 61.2] },
  { offset: "UTC-8", offsetMinutes: -480, iana: "America/Los_Angeles", cities: ["Los Angeles", "San Francisco", "Seattle", "Vancouver"], coords: [-118.2, 34.1] },
  { offset: "UTC-7", offsetMinutes: -420, iana: "America/Denver", cities: ["Denver", "Phoenix", "Calgary", "Salt Lake City"], coords: [-104.9, 39.7] },
  { offset: "UTC-6", offsetMinutes: -360, iana: "America/Chicago", cities: ["Chicago", "Houston", "Dallas", "Mexico City"], coords: [-87.6, 41.9] },
  { offset: "UTC-5", offsetMinutes: -300, iana: "America/New_York", cities: ["New York", "Toronto", "Miami", "Bogotá"], coords: [-74.0, 40.7] },
  { offset: "UTC-4", offsetMinutes: -240, iana: "America/Halifax", cities: ["Halifax", "Caracas", "La Paz", "Manaus"], coords: [-63.6, 44.6] },
  { offset: "UTC-3", offsetMinutes: -180, iana: "America/Sao_Paulo", cities: ["São Paulo", "Buenos Aires", "Montevideo"], coords: [-46.6, -23.5] },
  { offset: "UTC-2", offsetMinutes: -120, iana: "Atlantic/South_Georgia", cities: ["South Georgia"], coords: [-36.5, -54.3] },
  { offset: "UTC-1", offsetMinutes: -60, iana: "Atlantic/Cape_Verde", cities: ["Cape Verde", "Azores"], coords: [-23.6, 15.1] },
  { offset: "UTC+0", offsetMinutes: 0, iana: "Europe/London", cities: ["London", "Dublin", "Lisbon", "Casablanca"], coords: [-0.1, 51.5] },
  { offset: "UTC+1", offsetMinutes: 60, iana: "Europe/Paris", cities: ["Paris", "Berlin", "Madrid", "Rome", "Lagos"], coords: [2.3, 48.9] },
  { offset: "UTC+2", offsetMinutes: 120, iana: "Europe/Athens", cities: ["Athens", "Cairo", "Johannesburg", "Kyiv"], coords: [23.7, 37.9] },
  { offset: "UTC+3", offsetMinutes: 180, iana: "Europe/Moscow", cities: ["Moscow", "Nairobi", "Riyadh", "Istanbul"], coords: [37.6, 55.8] },
  { offset: "UTC+3:30", offsetMinutes: 210, iana: "Asia/Tehran", cities: ["Tehran"], coords: [51.4, 35.7] },
  { offset: "UTC+4", offsetMinutes: 240, iana: "Asia/Dubai", cities: ["Dubai", "Baku", "Tbilisi", "Muscat"], coords: [55.3, 25.2] },
  { offset: "UTC+4:30", offsetMinutes: 270, iana: "Asia/Kabul", cities: ["Kabul"], coords: [69.2, 34.5] },
  { offset: "UTC+5", offsetMinutes: 300, iana: "Asia/Karachi", cities: ["Karachi", "Tashkent", "Islamabad"], coords: [67.0, 24.9] },
  { offset: "UTC+5:30", offsetMinutes: 330, iana: "Asia/Kolkata", cities: ["Mumbai", "Delhi", "Kolkata", "Chennai"], coords: [72.9, 19.1] },
  { offset: "UTC+5:45", offsetMinutes: 345, iana: "Asia/Kathmandu", cities: ["Kathmandu"], coords: [85.3, 27.7] },
  { offset: "UTC+6", offsetMinutes: 360, iana: "Asia/Dhaka", cities: ["Dhaka", "Almaty", "Omsk"], coords: [90.4, 23.7] },
  { offset: "UTC+6:30", offsetMinutes: 390, iana: "Asia/Yangon", cities: ["Yangon", "Mandalay"], coords: [96.2, 16.9] },
  { offset: "UTC+7", offsetMinutes: 420, iana: "Asia/Bangkok", cities: ["Bangkok", "Jakarta", "Hanoi", "Ho Chi Minh City"], coords: [100.5, 13.8] },
  { offset: "UTC+8", offsetMinutes: 480, iana: "Asia/Shanghai", cities: ["Beijing", "Shanghai", "Singapore", "Kuala Lumpur"], coords: [121.5, 31.2] },
  { offset: "UTC+9", offsetMinutes: 540, iana: "Asia/Tokyo", cities: ["Tokyo", "Seoul", "Osaka"], coords: [139.7, 35.7] },
  { offset: "UTC+9:30", offsetMinutes: 570, iana: "Australia/Darwin", cities: ["Darwin", "Alice Springs", "Adelaide"], coords: [130.8, -12.5] },
  { offset: "UTC+10", offsetMinutes: 600, iana: "Australia/Sydney", cities: ["Sydney", "Melbourne", "Brisbane", "Canberra"], coords: [151.2, -33.9] },
  { offset: "UTC+11", offsetMinutes: 660, iana: "Pacific/Guadalcanal", cities: ["Honiara", "Noumea", "Vladivostok"], coords: [159.9, -9.4] },
  { offset: "UTC+12", offsetMinutes: 720, iana: "Pacific/Auckland", cities: ["Auckland", "Wellington", "Suva", "Fiji"], coords: [174.8, -36.9] },
];

export function detectTimezoneGroup(): TimezoneGroup | undefined {
  const detectedIana = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const exact = TIMEZONE_GROUPS.find(g => g.iana === detectedIana);
  if (exact) return exact;
  // Fall back to current UTC offset for zones not in our curated list.
  // This has a DST blind spot (offset shifts by 1h in summer) but is best-effort.
  const offsetMinutes = -new Date().getTimezoneOffset();
  return TIMEZONE_GROUPS.reduce<TimezoneGroup | undefined>((best, g) => {
    if (!best) return g;
    return Math.abs(g.offsetMinutes - offsetMinutes) <= Math.abs(best.offsetMinutes - offsetMinutes) ? g : best;
  }, undefined);
}

export function getTimezoneGroup(iana: string): TimezoneGroup | undefined {
  return TIMEZONE_GROUPS.find(g => g.iana === iana);
}

export function formatTimezoneLabel(group: TimezoneGroup): string {
  return `(${group.offset}) ${group.cities.slice(0, 4).join(", ")}`;
}

export function formatTimeInZone(tz: string): string {
  return new Date().toLocaleTimeString(undefined, {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  });
}
