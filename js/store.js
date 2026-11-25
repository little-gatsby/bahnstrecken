import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { accessPassword, ACCESS_HEADER } from './auth.js';

// Fahrten in der Tabelle rail_trips. Eine Fahrt im Programm:
// { id, date ('YYYY-MM-DD'), train, note, stops: [{ name, lon, lat }],
//   coords: [[lon, lat], …], lengthM }
// Den Bereich (space_id) setzt die Datenbank selbst anhand des Passworts im
// Header; RLS zeigt nur die Fahrten dieses Bereichs.

const REST = `${SUPABASE_URL}/rest/v1`;
// PostgREST liefert höchstens 1000 Zeilen auf einmal.
const PAGE_SIZE = 1000;

export class StoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'auth' | 'offline' | 'unknown'
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${REST}${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        [ACCESS_HEADER]: accessPassword(),
        ...options.headers,
      },
    });
  } catch {
    throw new StoreError('offline', 'Keine Verbindung zur Datenbank.');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new StoreError('unknown', `Datenbankfehler: ${data.message || res.status}`);
  }
  return res;
}

const fromRow = (row) => ({
  id: row.id,
  date: row.travel_date,
  train: row.train ?? '',
  note: row.note ?? '',
  group: row.trip_group ?? '',
  stops: row.stops,
  coords: row.geometry,
  lengthM: row.length_m,
});

export async function loadTrips() {
  const trips = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await request(
      `/rail_trips?select=*&order=travel_date.desc,created_at.desc&limit=${PAGE_SIZE}&offset=${offset}`,
    );
    const rows = await res.json();
    trips.push(...rows.map(fromRow));
    if (rows.length < PAGE_SIZE) return trips;
  }
}

export async function addTrip(trip) {
  const res = await request('/rail_trips', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      travel_date: trip.date,
      train: trip.train || null,
      note: trip.note || null,
      trip_group: trip.group || null,
      stops: trip.stops,
      geometry: trip.coords,
      length_m: Math.round(trip.lengthM),
    }),
  });
  const [row] = await res.json();
  return fromRow(row);
}

// Eine gespeicherte Fahrt ändern. Übernommen werden nur die angegebenen Felder.
export async function updateTrip(id, trip) {
  const columns = {
    date: (v) => ({ travel_date: v }),
    train: (v) => ({ train: v || null }),
    note: (v) => ({ note: v || null }),
    group: (v) => ({ trip_group: v || null }),
    stops: (v) => ({ stops: v }),
    coords: (v) => ({ geometry: v }),
    lengthM: (v) => ({ length_m: Math.round(v) }),
  };
  const body = Object.assign({}, ...Object.entries(trip).map(([key, value]) => columns[key](value)));
  const res = await request(`/rail_trips?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  const [row] = await res.json();
  if (!row) throw new StoreError('unknown', 'Die Fahrt konnte nicht gespeichert werden.');
  return fromRow(row);
}

// Mehrere Fahrten einer Gruppe zuordnen; group = '' nimmt sie aus der Gruppe.
export async function setTripsGroup(ids, group) {
  const res = await request(`/rail_trips?id=in.(${ids.map(encodeURIComponent).join(',')})`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ trip_group: group || null }),
  });
  const rows = await res.json();
  if (rows.length !== ids.length) throw new StoreError('unknown', 'Die Gruppe konnte nicht gespeichert werden.');
  return rows.map(fromRow);
}

export async function renameGroup(oldName, newName) {
  const res = await request(`/rail_trips?trip_group=eq.${encodeURIComponent(oldName)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ trip_group: newName }),
  });
  const rows = await res.json();
  if (!rows.length) throw new StoreError('unknown', 'Die Gruppe konnte nicht umbenannt werden.');
  return rows.map(fromRow);
}

export async function setTripYear(id, year) {
  // Wie beim Löschen: die geänderte Zeile zurückverlangen, sonst fiele eine
  // fehlende Policy nicht auf.
  const res = await request(`/rail_trips?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ travel_date: `${year}-01-01` }),
  });
  const [row] = await res.json();
  if (!row) throw new StoreError('unknown', 'Das Jahr konnte nicht geändert werden.');
  return fromRow(row);
}

export async function removeTrip(id) {
  // Ohne passende Policy meldet PostgREST still Erfolg – deshalb die
  // gelöschte Zeile zurückverlangen und prüfen.
  const res = await request(`/rail_trips?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  });
  const rows = await res.json();
  if (!rows.length) throw new StoreError('unknown', 'Die Fahrt konnte nicht gelöscht werden.');
}
