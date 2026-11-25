/**
 * A place's coordinates as a map link. Entries and prompts keep where they were
 * as RFC 8984 `geo:<lat>,<lng>` (a photo moment's average GPS position) beside
 * the place's name; this turns the coordinates into an OpenStreetMap page with
 * a marker, so the name and the exact spot are one tap apart.
 */
const GEO_RE = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

export function parseGeo(coordinates: string | undefined): { lat: number; lng: number } | null {
  const m = coordinates ? GEO_RE.exec(coordinates) : null;
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** OpenStreetMap at street zoom with a marker, or null when there are no usable coordinates. */
export function mapUrl(coordinates: string | undefined): string | null {
  const g = parseGeo(coordinates);
  if (!g) return null;
  return `https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lng}#map=15/${g.lat}/${g.lng}`;
}

/** Coordinates as text, for a place that has no name: "45.51592, -122.67585". */
export function geoText(coordinates: string | undefined): string {
  const g = parseGeo(coordinates);
  return g ? `${g.lat}, ${g.lng}` : '';
}
