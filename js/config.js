// Diese Werte sind NICHT geheim: Row Level Security sorgt dafür, dass man nur
// mit dem passenden Passwort Fahrten sieht und ändert (siehe js/auth.js). Es ist dasselbe
// Supabase-Projekt wie bei der Zugsammlung und der Trio-Bestenliste.
export const SUPABASE_URL = 'https://wmoljumtqipsjmegubuj.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Hbs_OHV8NJQNHB1ILMz1CQ_KCcmwGtW';

// Zugangs-Token für die Grundkarte „Lagoon“ von Jawg (jawg.io, kostenloses
// Konto). Er steht zwangsläufig im Browser-Code; Schutz vor Fremdnutzung
// bietet nur die Domain-Beschränkung im Jawg-Konto. Leer = Karte fehlt im Menü.
export const JAWG_ACCESS_TOKEN = 'X3DzpugBBEX80rStsnZSocDifhbskdJoeGd6oi72Mp7vAXkoAWvxtz9od8fTUr3R';
