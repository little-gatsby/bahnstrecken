// Länder, durch die eine Fahrt führt. Umrisse: Natural Earth 1:50 Mio. aus
// dem Paket world-atlas (TopoJSON, ~750 KB), entpackt mit topojson-client
// (globales `topojson` aus index.html). 1:50 Mio. statt 1:110 Mio., weil im
// gröberen Satz kleine Länder wie Luxemburg oder Liechtenstein fehlen.

const COUNTRIES_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';

let countriesPromise = null;

// Lädt die Umrisse einmal und merkt sich zu jedem Land sein Begrenzungsrechteck.
export function loadCountries() {
  countriesPromise ??= fetch(COUNTRIES_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`Länderumrisse: HTTP ${res.status}`);
      return res.json();
    })
    .then((topo) => topojson.feature(topo, topo.objects.countries).features.map((feature) => ({
      feature,
      polygons: toPolygons(feature.geometry),
    })))
    .then((countries) => countries.map((c) => ({ ...c, bbox: bboxOf(c.polygons) })))
    .catch((err) => {
      countriesPromise = null; // beim nächsten Mal neu versuchen
      throw err;
    });
  return countriesPromise;
}

const toPolygons = (geometry) => {
  if (!geometry) return [];
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
};

function bboxOf(polygons) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const [x, y] of polygon[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

// Strahlverfahren: liegt der Punkt im äußeren Ring und in keinem Loch?
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inCountry(point, { polygons, bbox }) {
  const [x, y] = point;
  if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) return false;
  return polygons.some(([outer, ...holes]) => inRing(point, outer) && !holes.some((h) => inRing(point, h)));
}

// Alle Länder, in denen mindestens ein Punkt einer Fahrt liegt.
export function visitedCountries(countries, trips) {
  const visited = new Set();
  for (const trip of trips) {
    let last = null; // aufeinanderfolgende Punkte liegen meist im selben Land
    for (const point of trip.coords) {
      if (last && inCountry(point, last)) continue;
      last = countries.find((c) => inCountry(point, c)) ?? null;
      if (last) visited.add(last);
    }
  }
  return [...visited];
}
