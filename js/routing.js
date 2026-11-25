// Bahnhofssuche (Photon) und Routing auf dem Gleisnetz (BRouter).
// Beide Dienste beruhen auf OpenStreetMap, laufen weltweit und brauchen
// keinen Schlüssel. Es sind freiwillig betriebene Server – also sparsam
// abfragen: Suche erst nach einer kurzen Tipp-Pause, Routing nur bei Änderungen.

import { distanceMeters, lengthMeters } from './geo.js';

const PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE_URL = 'https://photon.komoot.io/reverse';
const BROUTER_URL = 'https://brouter.de/brouter';
const TRANSITOUS_URL = 'https://api.transitous.org/api/v4/plan';

export class RoutingError extends Error {}

// Gesucht wird nur unter Bahnhöfen und Haltepunkten, nicht unter Straßen –
// sonst landet „Bremen“ in der Stadtmitte statt am Hauptbahnhof.
const STATION_TAGS = ['railway:station', 'railway:halt', 'public_transport:station'];

// In OSM heißen Bahnhöfe meist ausgeschrieben („Hamburg Hauptbahnhof“),
// manche aber abgekürzt („Dortmund Hbf“). Photon findet nur die Schreibweise,
// die dort steht – bei einer Abkürzung suchen wir deshalb nach beiden.
const ABBREVIATIONS = [
  [/\bHbf\b\.?/gi, 'Hauptbahnhof'],
  [/\bBf\b\.?/gi, 'Bahnhof'],
  [/\bBhf\b\.?/gi, 'Bahnhof'],
];

const expandAbbreviations = (query) =>
  ABBREVIATIONS.reduce((text, [pattern, full]) => text.replace(pattern, full), query);

async function photonSearch(query, lang, signal) {
  const params = new URLSearchParams({ q: query, limit: '12', lang });
  for (const tag of STATION_TAGS) params.append('osm_tag', tag);
  const res = await fetch(`${PHOTON_URL}?${params}`, { signal });
  if (!res.ok) throw new RoutingError('Die Bahnhofssuche ist gerade nicht erreichbar.');
  return (await res.json()).features;
}

// Name für einen Punkt, der per Klick oder Verschieben auf der Karte entsteht:
// der Bahnhof dort, sonst „bei“ dem nächsten Bahnhof im Umkreis von 10 km,
// sonst die Koordinaten.
const AT_STATION_M = 1500;

export async function nameForPoint({ lon, lat }) {
  const reverse = async (lang) => {
    const params = new URLSearchParams({ lon, lat, lang, limit: '1', radius: '10' });
    for (const tag of STATION_TAGS) params.append('osm_tag', tag);
    const res = await fetch(`${PHOTON_REVERSE_URL}?${params}`);
    if (!res.ok) return null;
    return (await res.json()).features[0] ?? null;
  };

  try {
    let station = await reverse('de');
    if (station && !isLatin(station.properties.name ?? '')) station = (await reverse('en')) ?? station;
    if (station?.properties.name) {
      const distance = distanceMeters([lon, lat], station.geometry.coordinates);
      return distance < AT_STATION_M ? station.properties.name : `bei ${station.properties.name}`;
    }
  } catch {
    // Kein Netz o. Ä. – dann eben Koordinaten.
  }
  return formatCoordinates(lon, lat);
}

function formatCoordinates(lon, lat) {
  const f = (v) => Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${f(lat)}° ${lat >= 0 ? 'N' : 'S'}, ${f(lon)}° ${lon >= 0 ? 'O' : 'W'}`;
}

const osmKey = (p) => `${p.osm_type}${p.osm_id}`;
const isLatin = (text) => /[A-Za-zÀ-ɏ]/.test(text);

export async function searchStations(query, signal) {
  const q = expandAbbreviations(query);
  const features = await photonSearch(q, 'de', signal);
  if (q !== query) {
    const seen = new Set(features.map((f) => osmKey(f.properties)));
    for (const f of await photonSearch(query, 'de', signal)) {
      if (!seen.has(osmKey(f.properties))) features.push(f);
    }
  }

  // Ohne deutschen Namen liefert Photon den Ortsnamen (上海虹桥, תל אביב …).
  // Dann zusätzlich die englischen Namen holen – die gibt es fast immer.
  const latinNames = new Map();
  if (features.some((f) => f.properties.name && !isLatin(f.properties.name))) {
    for (const f of await photonSearch(q, 'en', signal)) {
      if (f.properties.name && isLatin(f.properties.name)) latinNames.set(osmKey(f.properties), f.properties.name);
    }
  }

  // Ein Bahnhof steht in OSM oft doppelt (railway=station und
  // public_transport=station) – gleiche Namen am selben Ort zusammenfassen.
  const results = [];
  for (const f of features) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    if (!p.name) continue;
    const latin = isLatin(p.name) ? null : latinNames.get(osmKey(p));
    const name = latin ?? p.name;
    const duplicate = results.some((r) =>
      r.name === name && distanceMeters([r.lon, r.lat], [lon, lat]) < 2000);
    if (duplicate) continue;
    const place = [p.city ?? p.county, p.state, p.country]
      .filter((part, i, all) => part && part !== p.name && all.indexOf(part) === i);
    if (latin) place.unshift(p.name);
    results.push({ name, detail: place.join(', '), lon, lat });
  }
  return results.slice(0, 8);
}

// Route über alle Halte. Jeder Abschnitt wird einzeln angefragt: kurze
// Anfragen sind bei BRouter deutlich schneller als eine lange, und ein
// Fehler lässt sich dem richtigen Abschnitt zuordnen. Bewusst nacheinander:
// bei vielen gleichzeitigen Anfragen bremst der Server („Please, retry later!“).
export async function routeTrip(stops) {
  const coords = [];
  let lengthM = 0;
  const sources = new Set(); // 'fahrplan' und/oder 'gleisnetz'
  for (let i = 1; i < stops.length; i++) {
    const leg = await routeLeg(stops[i - 1], stops[i]);
    coords.push(...(i === 1 ? leg.coords : leg.coords.slice(1)));
    lengthM += leg.lengthM;
    sources.add(leg.source);
  }
  return { coords, lengthM, sources: [...sources] };
}

// Jeder Abschnitt zuerst nach Fahrplan: Transitous (freier, weltweiter
// Fahrplan-Router auf Basis von MOTIS) kennt die echten Personenzüge und
// liefert deren Linienverlauf. BRouter dagegen sieht nur Gleise und wählt
// gern Güterumgehungen (Hamburg–Osnabrück an Bremen Hbf vorbei). Findet der
// Fahrplan nichts Brauchbares, rechnen wir wie bisher auf dem Gleisnetz.
async function routeLeg(from, to) {
  const timetable = await timetableLeg(from, to);
  if (timetable) return timetable;
  return { ...(await railNetworkLeg(from, to)), source: 'gleisnetz' };
}

// Ein- und Ausstieg dürfen höchstens so weit von den Halten entfernt sein –
// sonst hat der Fahrplan-Router z. B. für einen Kartenpunkt eine ganz andere
// Verbindung gesucht.
const MAX_BOARDING_DISTANCE_M = 1500;
// Manche Fahrplandaten haben keinen echten Linienverlauf; dann sind es lange
// gerade Stücke von Halt zu Halt. Ab diesem Anteil nehmen wir lieber BRouter.
const MAX_STRAIGHT_SHARE = 0.25;
const STRAIGHT_PIECE_M = 2000;

async function timetableLeg(from, to) {
  const params = new URLSearchParams({
    fromPlace: `${from.lat},${from.lon}`,
    toPlace: `${to.lat},${to.lon}`,
    time: tomorrowMorning(from.lon),
    transitModes: 'RAIL',
    maxTransfers: '3',
  });
  let data;
  try {
    const res = await fetch(`${TRANSITOUS_URL}?${params}`);
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null; // Fahrplan nicht erreichbar – dann eben Gleisnetz
  }

  const candidates = (data.itineraries ?? [])
    .map((itinerary) => timetableCandidate(itinerary, from, to))
    .filter(Boolean)
    .sort((a, b) => a.transfers - b.transfers || a.duration - b.duration);
  if (!candidates.length) return null;
  const coords = await straightenLoops(candidates[0].coords, candidates[0].stopPoints, from, to);
  return { coords, lengthM: lengthMeters(coords), source: 'fahrplan' };
}

// Die Linienverläufe im Fahrplan sind nachträglich aufs Gleisnetz gelegt –
// und dabei gelegentlich falsch abgebogen: In Braunschweig fährt die RB47
// laut Fahrplan erst 10 km im Bogen um die Stadt, bevor sie in Gliesmarode
// ankommt, das 3 km vom Hbf entfernt liegt. Solche Schleifen erkennen wir
// daran, dass der Weg zwischen zwei nahen Punkten viel länger ist als ihr
// Abstand. Das Stück fragen wir bei BRouter nach und übernehmen es nur, wenn
// es wirklich deutlich kürzer ist – echte Kehrschleifen (Gotthard, Albula)
// sind auf dem Gleisnetz genauso lang und bleiben deshalb erhalten.
const LOOP_MAX_DIRECT_M = 10_000;   // nur örtliche Schleifen
const LOOP_MAX_PATH_M = 25_000;
const LOOP_FACTOR = 2;              // Weg mehr als doppelt so lang wie der Abstand …
const LOOP_MIN_EXCESS_M = 3000;     // … und mindestens 3 km Umweg
const LOOP_STOP_RADIUS_M = 300;     // so nah an der Linie zählt ein Halt
const LOOP_ACCEPT_RATIO = 0.75;     // BRouter muss ein Viertel kürzer sein
const MAX_LOOP_FIXES = 3;

async function straightenLoops(coords, stopPoints, legFrom, legTo) {
  const loops = findLoops(coords, MAX_LOOP_FIXES, stopPoints);
  let result = coords;
  // Von hinten nach vorn ersetzen, damit die vorderen Indizes gültig bleiben.
  for (const { start, end, pathM } of loops.sort((a, b) => b.start - a.start)) {
    // Beginnt die Schleife am Bahnhof, dann vom Bahnhofspunkt aus fragen: Der
    // Bahnsteig aus dem Fahrplan liegt mitunter auf einem Gleis, das im
    // Gleisnetz nur zur falschen Seite angebunden ist (Braunschweig Hbf) –
    // von dort fände auch BRouter nur dieselbe Schleife.
    const point = (index) => {
      if (index === 0) return legFrom;
      if (index === result.length - 1) return legTo;
      const [lon, lat] = result[index];
      return { lon, lat, name: '' };
    };
    try {
      const shortcut = await requestLeg(point(start), point(end));
      if (shortcut.lengthM < pathM * LOOP_ACCEPT_RATIO) {
        result = joinPaths(joinPaths(result.slice(0, start), shortcut.coords), result.slice(end + 1));
      }
    } catch {
      // Dann bleibt der Fahrplanverlauf, wie er ist.
    }
  }
  return result;
}

// Hängt b an a an. Beginnt die Abkürzung ein Stück neben der Fahrplanlinie,
// liefe sie sonst kurz zurück und wieder vor – ein kleiner Zipfel auf der
// Karte. Deshalb an der Stelle zusammenfügen, an der sich beide fast berühren.
const JOIN_LOOKAROUND = 40;
const JOIN_TOUCH_M = 25;

function joinPaths(a, b) {
  if (!a.length || !b.length) return [...a, ...b];
  let best = { i: a.length - 1, j: 0, d: Infinity };
  for (let i = Math.max(0, a.length - JOIN_LOOKAROUND); i < a.length; i++) {
    for (let j = 0; j < Math.min(b.length, JOIN_LOOKAROUND); j++) {
      const d = distanceMeters(a[i], b[j]);
      // Bei gleich nahen Paaren das mit dem kürzesten Gesamtweg (frühes i, spätes j).
      if (d < JOIN_TOUCH_M && (best.d >= JOIN_TOUCH_M || i - j < best.i - best.j)) best = { i, j, d };
    }
  }
  return [...a.slice(0, best.i + 1), ...b.slice(best.j)];
}

// Sucht die auffälligsten Schleifen, die sich nicht überlappen. Liegt ein
// Halt mitten in der Schleife, ist sie echt (der Zug wendet im Kopfbahnhof)
// und bleibt. Rückgabe: [{ start, end, pathM }] mit Indizes in coords.
export function findLoops(coords, max, stopPoints = []) {
  const n = coords.length;
  if (n < 3) return [];
  // Flache Projektion genügt für Abstände bis 25 km.
  const mPerDegLat = 111320;
  const xy = coords.map(([lon, lat]) => [lon * mPerDegLat * Math.cos((lat * Math.PI) / 180), lat * mPerDegLat]);
  const along = [0];
  for (let i = 1; i < n; i++) {
    along.push(along[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  }

  // Index des nächsten Linienpunkts je Halt (nur Halte direkt an der Linie).
  const stopIndexes = [];
  for (const stop of stopPoints) {
    let bestIndex = -1;
    let bestDistance = LOOP_STOP_RADIUS_M;
    coords.forEach((point, k) => {
      const d = distanceMeters(point, stop);
      if (d < bestDistance) { bestDistance = d; bestIndex = k; }
    });
    if (bestIndex >= 0) stopIndexes.push({ index: bestIndex, point: stop });
  }
  const passesStop = (start, end) => stopIndexes.some(({ index, point }) =>
    index > start && index < end
    && distanceMeters(point, coords[start]) > LOOP_STOP_RADIUS_M
    && distanceMeters(point, coords[end]) > LOOP_STOP_RADIUS_M);

  const found = [];
  for (let i = 0; i < n - 2; i++) {
    let best = null;
    for (let j = i + 2; j < n && along[j] - along[i] <= LOOP_MAX_PATH_M; j++) {
      const direct = Math.hypot(xy[j][0] - xy[i][0], xy[j][1] - xy[i][1]);
      if (direct > LOOP_MAX_DIRECT_M) continue;
      const pathM = along[j] - along[i];
      const excess = pathM - LOOP_FACTOR * direct - LOOP_MIN_EXCESS_M;
      if (excess > 0 && (!best || excess > best.excess) && !passesStop(i, j)) {
        best = { start: i, end: j, pathM, excess };
      }
    }
    if (best) found.push(best);
  }

  const chosen = [];
  for (const loop of found.sort((a, b) => b.excess - a.excess)) {
    if (chosen.length >= max) break;
    if (chosen.some((c) => loop.start <= c.end && c.start <= loop.end)) continue;
    chosen.push(loop);
  }
  return chosen;
}

function timetableCandidate(itinerary, from, to) {
  const rides = itinerary.legs.filter((leg) => leg.mode !== 'WALK' && leg.legGeometry?.points);
  if (!rides.length) return null;
  const coords = rides.flatMap((leg) => decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6));
  if (coords.length < 2) return null;
  if (distanceMeters(coords[0], [from.lon, from.lat]) > MAX_BOARDING_DISTANCE_M) return null;
  if (distanceMeters(coords.at(-1), [to.lon, to.lat]) > MAX_BOARDING_DISTANCE_M) return null;

  let total = 0;
  let straight = 0;
  for (let i = 1; i < coords.length; i++) {
    const piece = distanceMeters(coords[i - 1], coords[i]);
    total += piece;
    if (piece > STRAIGHT_PIECE_M) straight += piece;
  }
  if (!total || straight / total > MAX_STRAIGHT_SHARE) return null;

  // Alle Halte der Züge – eine Schleife über einen Halt ist echt (Kopfbahnhof).
  const stopPoints = rides.flatMap((leg) => [leg.from, ...(leg.intermediateStops ?? []), leg.to])
    .filter((stop) => Number.isFinite(stop?.lon) && Number.isFinite(stop?.lat))
    .map((stop) => [stop.lon, stop.lat]);

  return { coords, stopPoints, lengthM: lengthMeters(coords), transfers: rides.length - 1, duration: itinerary.duration };
}

// Morgen um 9 Uhr Ortszeit (grob über den Längengrad), damit tagsüber
// fahrende Züge gefunden werden – egal ob in Europa, Asien oder Amerika.
function tomorrowMorning(lon) {
  const offsetHours = Math.round(lon / 15);
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(9 - offsetHours, 0, 0, 0);
  return date.toISOString();
}

// Google-Polyline-Format, wie es MOTIS liefert. Ergebnis als [lon, lat].
function decodePolyline(text, precision) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < text.length) {
    lat += next();
    lon += next();
    coords.push([lon / factor, lat / factor]);
  }
  return coords;
}

// BRouter findet am angegebenen Punkt kein brauchbares Gleis.
class NoTrackError extends RoutingError {}
// BRouter hat die Suche nach 9 Sekunden abgebrochen.
class TimeoutError extends RoutingError {}

const reverseLeg = (leg) => ({ ...leg, coords: leg.coords.slice().reverse() });

// Bahnhofspunkte liegen in OSM oft am Empfangsgebäude, bei Kopfbahnhöfen
// sogar vor dem Gleisende (València Nord). Dort greift BRouter manchmal ein
// Gleisstück ohne Anschluss ans Netz. Dann rücken wir erst den Start, notfalls
// das Ziel ein Stück in mehrere Richtungen und nehmen den ersten Treffer.
const NUDGE_DISTANCES_M = [150, 400];
const LONG_LEG_M = 600_000;
const NUDGE_DIRECTIONS = 6;

// In großen Bahnhöfen liegt der Bahnhofspunkt zwischen vielen Gleisen.
// Erwischt BRouter eines, das nur von der anderen Seite angebunden ist, fährt
// die Route außen herum (Duisburg → Düsseldorf Hbf über Ratingen: 31 statt
// 24 km). Schon 30 m daneben passt es meist. Deshalb: Ist ein Abschnitt
// deutlich länger als die Luftlinie (über 30 %), Start und Ziel leicht versetzt erneut
// anfragen und die kürzeste Route nehmen. Bei normalen Strecken kostet das
// keine einzige Anfrage mehr.
// Bahnstrecken sind oft 20 % länger als die Luftlinie (Hamburg–Bremen),
// ein Umweg wie in Düsseldorf liegt bei über 30 %.
const DETOUR_RATIO = 1.3;
const DETOUR_SHIFT_M = 30;
const DETOUR_DIRECTIONS = 4;

async function railNetworkLeg(from, to) {
  const leg = await findLeg(from, to);
  const airline = distanceMeters([from.lon, from.lat], [to.lon, to.lat]);
  if (leg.lengthM <= airline * DETOUR_RATIO) return leg;

  let best = leg;
  const attempts = [
    ...pointsAround(from, DETOUR_SHIFT_M, DETOUR_DIRECTIONS).map((p) => [p, to]),
    ...pointsAround(to, DETOUR_SHIFT_M, DETOUR_DIRECTIONS).map((p) => [from, p]),
  ];
  // Nacheinander, nicht gleichzeitig: sonst bremst BRouter („retry later“).
  for (const [a, b] of attempts) {
    try {
      const candidate = await requestLeg(a, b);
      if (candidate.lengthM < best.lengthM) best = candidate;
    } catch {
      // Dieser Versuch zählt einfach nicht.
    }
  }
  return best;
}

async function findLeg(from, to, { reversed = false } = {}) {
  try {
    return await requestLeg(from, to);
  } catch (err) {
    // Liegt das *Ziel* auf so einem Gleisstück, sucht BRouter bis zur
    // Zeitgrenze. Rückwärts angefragt scheitert er dagegen sofort mit
    // „no track found“ – und dann hilft das Verrücken unten.
    if (err instanceof TimeoutError && !reversed) {
      return reverseLeg(await findLeg(to, from, { reversed: true }));
    }
    if (!(err instanceof NoTrackError)) throw err;
  }

  // Meist liegt es am Start: Ein abgehängtes Ziel führt oben zur Zeitgrenze
  // und wird durch das Umdrehen zum Start.
  const attempts = [
    ...NUDGE_DISTANCES_M.flatMap((d) => pointsAround(from, d).map((p) => [p, to])),
    ...NUDGE_DISTANCES_M.flatMap((d) => pointsAround(to, d).map((p) => [from, p])),
  ];
  for (const [a, b] of attempts) {
    try {
      return await requestLeg(a, b);
    } catch (err) {
      if (!(err instanceof NoTrackError || err instanceof TimeoutError)) throw err;
    }
  }

  throw new RoutingError(`Keine Gleisverbindung zwischen „${from.name}“ und „${to.name}“ gefunden.`);
}

function pointsAround({ lon, lat, name }, distanceM, directions = NUDGE_DIRECTIONS) {
  const dLat = distanceM / 111320;
  const dLon = distanceM / (111320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: directions }, (_, i) => {
    const angle = (2 * Math.PI * i) / directions;
    return { name, lon: lon + dLon * Math.sin(angle), lat: lat + dLat * Math.cos(angle) };
  });
}

async function requestLeg(from, to) {
  const params = new URLSearchParams({
    lonlats: `${from.lon},${from.lat}|${to.lon},${to.lat}`,
    profile: 'rail',
    alternativeidx: '0',
    format: 'geojson',
  });

  let res;
  try {
    res = await fetch(`${BROUTER_URL}?${params}`);
  } catch {
    throw new RoutingError('Der Routing-Server ist nicht erreichbar.');
  }

  if (!res.ok) {
    const text = await res.text();
    if (/not mapped|position not|no track found|target island|no path|not found/i.test(text)) {
      throw new NoTrackError(text);
    }
    // „retry later“ kommt auch sofort, wenn ein einzelner Abschnitt dem Server
    // zu weit ist (Shanghai–Peking, rund 1100 km Luftlinie). Mit Zwischenhalten
    // an großen Bahnhöfen klappt es dann in Sekundenbruchteilen.
    if (/retry later/i.test(text) && distanceMeters([from.lon, from.lat], [to.lon, to.lat]) > LONG_LEG_M) {
      throw new RoutingError(`Der Abschnitt „${from.name}“ → „${to.name}“ ist zu lang für den Routing-Server. `
        + 'Bitte unterwegs einen Zwischenhalt setzen, am besten einen großen Bahnhof an der Strecke.');
    }
    if (/retry later/i.test(text)) {
      throw new RoutingError('Der Routing-Server ist gerade ausgelastet – bitte in einer Minute noch einmal versuchen.');
    }
    if (/timeout|watchdog|killed/i.test(text)) {
      throw new TimeoutError('Die Strecke ist zu lang für eine Anfrage – bitte Zwischenhalte setzen.');
    }
    throw new RoutingError(`Routing fehlgeschlagen: ${text.slice(0, 120)}`);
  }

  const data = await res.json();
  const feature = data.features[0];
  return {
    // BRouter liefert [lon, lat, Höhe] – die Höhe brauchen wir nicht.
    coords: feature.geometry.coordinates.map(([lon, lat]) => [lon, lat]),
    lengthM: Number(feature.properties['track-length']),
  };
}
