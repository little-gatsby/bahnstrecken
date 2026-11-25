// Koordinaten sind hier immer [lon, lat] – wie in GeoJSON und bei BRouter.
// Leaflet will [lat, lon]; umgedreht wird erst in map.js.

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceMeters([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function lengthMeters(coords) {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += distanceMeters(coords[i - 1], coords[i]);
  return sum;
}

// Douglas-Peucker: wirft Punkte weg, die weniger als toleranceM von der
// vereinfachten Linie abweichen. Eine 300-km-Route von BRouter hat rund
// 4000 Punkte, danach meist nur noch einige Hundert – für die Karte reicht das.
export function simplify(coords, toleranceM = 8) {
  if (coords.length < 3) return coords.slice();
  // Für kurze Abstände genügt eine flache Projektion um den Mittelpunkt.
  const midLat = toRad(coords[Math.floor(coords.length / 2)][1]);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(midLat);
  const xy = coords.map(([lon, lat]) => [lon * mPerDegLon, lat * mPerDegLat]);

  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(xy[i], xy[first], xy[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > toleranceM) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Fünf Nachkommastellen sind gut 1 m Genauigkeit.
export function roundCoords(coords, digits = 5) {
  const f = 10 ** digits;
  return coords.map(([lon, lat]) => [Math.round(lon * f) / f, Math.round(lat * f) / f]);
}

export function formatKm(meters) {
  const km = meters / 1000;
  return `${km.toLocaleString('de-DE', { maximumFractionDigits: km < 100 ? 1 : 0 })} km`;
}
