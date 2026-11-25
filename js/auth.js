import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Zugang per Passwort statt Konto: Jedes Passwort gehört zu einem eigenen
// Bereich mit eigenen Fahrten (Tabelle rail_spaces). Die App schickt das
// Passwort bei jeder Anfrage im Header „x-zugang“ mit; die Datenbank prüft es
// gegen den gespeicherten Hash und zeigt nur die Fahrten dieses Bereichs
// (Row Level Security, siehe supabase/schema.sql). Im Code steht deshalb
// kein Passwort.

const STORAGE_KEY = 'bahnstrecken.zugang';
export const ACCESS_HEADER = 'x-zugang';

export class AuthError extends Error {}

let access = readAccess(); // { password, name } oder null

function readAccess() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeAccess(next) {
  access = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Privates Fenster o. Ä.: Zugang gilt dann nur bis zum Neuladen.
  }
}

export const hasAccess = () => Boolean(access);
export const accessName = () => access?.name ?? '';
export const accessPassword = () => access?.password ?? '';

// Fragt die Datenbank, zu welchem Bereich das Passwort gehört.
async function spaceName(password) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rail_space_name`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        [ACCESS_HEADER]: password,
      },
      body: '{}',
    });
  } catch {
    throw new AuthError('Keine Verbindung zur Datenbank.');
  }
  if (!res.ok) throw new AuthError('Das Passwort ließ sich gerade nicht prüfen.');
  return res.json(); // Name oder null
}

export async function login(password) {
  const name = await spaceName(password);
  if (!name) throw new AuthError('Das Passwort stimmt nicht.');
  writeAccess({ password, name });
}

// Gespeicherten Zugang beim Start erneut prüfen (Passwort könnte geändert sein).
export async function checkStoredAccess() {
  if (!access) return false;
  const name = await spaceName(access.password);
  if (!name) {
    writeAccess(null);
    return false;
  }
  if (name !== access.name) writeAccess({ ...access, name });
  return true;
}

export function logout() {
  writeAccess(null);
}
