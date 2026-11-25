import { createMap } from './map.js';
import { searchStations, routeTrip, nameForPoint } from './routing.js';
import { simplify, roundCoords, formatKm } from './geo.js';
import { hasAccess, accessName, login, logout, checkStoredAccess } from './auth.js';
import {
  loadTrips, addTrip, updateTrip, removeTrip, setTripYear, setTripsGroup, renameGroup,
} from './store.js';
import { loadCountries, visitedCountries } from './countries.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const emptyStop = () => ({ name: '', lon: null, lat: null });
const isSet = (stop) => stop.lat != null;
// Gespeichert wird nur das Jahr. Die Spalte travel_date bleibt ein Datum
// und bekommt den 1. Januar – so bleibt die Sortierung einfach.
const currentYear = () => new Date().getFullYear();
const tripYear = (iso) => iso.slice(0, 4);
// Früher getrennt eingegeben, jetzt ein Feld „Zug/Notiz“ (gespeichert in note).
const tripDetails = (trip) => [trip.train, trip.note].filter(Boolean).join(' · ');

let trips = [];
let selectedId = null;
let countryCount = null; // null, solange die Länderumrisse noch laden
const draft = {
  stops: [emptyStop(), emptyStop()],
  route: null,
  routeError: '',
  routing: false,
  requestId: 0,
  saving: false,
  editingId: null, // gesetzt, solange eine gespeicherte Fahrt bearbeitet wird
};

const mapView = createMap($('map'), {
  onMapClick: addStopFromMap,
  onStopMoved: (index, position) => {
    Object.assign(draft.stops[index], position);
    nameStop(draft.stops[index]);
    updateDraft();
  },
  onTripClick: (id, latlng) => {
    selectTrip(id, { scroll: true });
    openTripPopup(id, latlng);
  },
});

// ---------- Meldungen ----------

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = false;
}

function clearMessage() {
  $('message').hidden = true;
}

// ---------- Anmeldung ----------

function showLogin() {
  $('login-view').hidden = false;
  $('main-view').hidden = true;
  $('user-box').hidden = true;
  trips = [];
  showTripsOnMap();
}

async function enterApp() {
  $('login-view').hidden = true;
  $('main-view').hidden = false;
  $('user-box').hidden = false;
  $('user-email').textContent = accessName();
  renderStops();
  renderTrips();
  try {
    trips = await loadTrips();
    renderTrips();
    showTripsOnMap();
    mapView.fitAllTrips();
  } catch (err) {
    handleStoreError(err);
  }
}

function handleStoreError(err) {
  showMessage(err.message);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessage();
  const button = e.submitter;
  button.disabled = true;
  try {
    await login($('login-password').value);
    $('login-password').value = '';
    await enterApp();
  } catch (err) {
    showMessage(err.message);
  } finally {
    button.disabled = false;
  }
});

// Beim Wechsel in einen anderen Bereich alles frisch laden – so bleibt
// nichts von den Fahrten der vorigen Person stehen.
$('logout').addEventListener('click', () => {
  logout();
  location.reload();
});

// ---------- Neue Fahrt: Halte ----------

function renderStops() {
  const list = $('stops');
  list.replaceChildren(...draft.stops.map(createStopItem));
}

function stopLabel(index) {
  if (index === 0) return 'Von';
  if (index === draft.stops.length - 1) return 'Nach';
  return 'Über';
}

function createStopItem(stop, index) {
  const li = el('li', 'stop');
  li.classList.toggle('unset', !isSet(stop));

  const input = el('input');
  input.type = 'text';
  input.value = stop.name;
  input.placeholder = `${stopLabel(index)} – Bahnhof suchen`;
  input.setAttribute('aria-label', stopLabel(index));

  const suggestions = el('ul', 'suggestions');
  suggestions.hidden = true;

  li.append(el('span', 'stop-badge', String(index + 1)), input, suggestions);

  if (draft.stops.length > 2 || isSet(stop) || stop.name) {
    const remove = el('button', 'remove', '×');
    remove.type = 'button';
    remove.title = 'Halt entfernen';
    remove.addEventListener('click', () => removeStop(index));
    li.append(remove);
  }

  let results = [];
  let active = -1;
  let timer;
  let controller;

  function close() {
    suggestions.hidden = true;
    results = [];
    active = -1;
  }

  function renderSuggestions() {
    suggestions.replaceChildren(...results.map((result, i) => {
      const item = el('li', i === active ? 'active' : '', result.name);
      if (result.detail) item.append(el('small', '', result.detail));
      // mousedown statt click: sonst schließt der blur die Liste vorher.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(result);
      });
      return item;
    }));
    suggestions.hidden = results.length === 0;
  }

  async function search(query) {
    controller?.abort();
    controller = new AbortController();
    try {
      results = await searchStations(query, controller.signal);
    } catch (err) {
      if (err.name === 'AbortError') return;
      results = [];
      showMessage(err.message);
    }
    active = results.length ? 0 : -1;
    renderSuggestions();
  }

  function choose(result) {
    input.value = result.name;
    close();
    draft.stops[index] = { name: result.name, lon: result.lon, lat: result.lat };
    li.classList.remove('unset');
    updateDraft({ fit: true });
    // Gleich mit dem nächsten offenen Halt weitermachen.
    const next = draft.stops.findIndex((s) => !isSet(s));
    if (next !== -1) $('stops').children[next]?.querySelector('input').focus();
  }

  input.addEventListener('input', () => {
    // Getippter Text zählt erst als Halt, wenn ein Vorschlag gewählt wurde.
    const wasSet = isSet(draft.stops[index]);
    draft.stops[index] = { name: input.value, lon: null, lat: null };
    if (wasSet) {
      li.classList.add('unset');
      updateDraft();
    }
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) {
      controller?.abort();
      close();
      return;
    }
    timer = setTimeout(() => search(query), 300);
  });

  input.addEventListener('keydown', (e) => {
    if (suggestions.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + results.length) % results.length;
      renderSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[active]) choose(results[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', close);

  return li;
}

function addStopFromMap(position) {
  if ($('main-view').hidden) return;
  const stop = { name: '', ...position };
  const free = draft.stops.findIndex((s) => !isSet(s));
  if (free !== -1) draft.stops[free] = stop;
  // Alle Halte belegt: als Zwischenhalt vor dem Ziel einfügen.
  else draft.stops.splice(draft.stops.length - 1, 0, stop);
  nameStop(stop);
  renderStops();
  updateDraft();
}

// Kartenpunkte nach dem Bahnhof dort benennen (oder „bei …“). Die Suche
// läuft im Hintergrund; Speichern wartet auf sie (siehe stop.naming).
function nameStop(stop) {
  const { lon, lat } = stop;
  stop.name = 'Wird benannt …';
  stop.naming = nameForPoint({ lon, lat }).then((name) => {
    if (stop.lon !== lon || stop.lat !== lat) return; // inzwischen verschoben
    stop.name = name;
    stop.naming = null;
    const index = draft.stops.indexOf(stop);
    const input = index === -1 ? null : $('stops').children[index]?.querySelector('input');
    if (input) input.value = name;
  });
}

$('add-stop').addEventListener('click', () => {
  draft.stops.splice(draft.stops.length - 1, 0, emptyStop());
  renderStops();
  $('stops').children[draft.stops.length - 2].querySelector('input').focus();
});

function removeStop(index) {
  if (draft.stops.length > 2) draft.stops.splice(index, 1);
  else draft.stops[index] = emptyStop();
  renderStops();
  updateDraft();
}

// ---------- Neue Fahrt: Strecke ----------

async function updateDraft({ fit = false } = {}) {
  const requestId = ++draft.requestId;
  const complete = draft.stops.every(isSet);
  draft.route = null;
  draft.routeError = '';
  draft.routing = complete;
  mapView.showDraft(draft.stops, null);
  renderRouteInfo();
  if (fit) mapView.fitDraft();
  if (!complete) return;

  try {
    const route = await routeTrip(draft.stops);
    if (requestId !== draft.requestId) return; // inzwischen geändert
    draft.route = route;
  } catch (err) {
    if (requestId !== draft.requestId) return;
    draft.routeError = err.message;
  }
  draft.routing = false;
  mapView.showDraft(draft.stops, draft.route?.coords);
  if (fit) mapView.fitDraft();
  renderRouteInfo();
}

// Woher die Strecke stammt: Fahrplan (echte Personenzüge) oder Gleisnetz.
function sourceLabel(sources) {
  if (sources.includes('gespeichert')) return 'gespeicherte Strecke';
  if (sources.length > 1) return 'teils nach Fahrplan, teils über das Gleisnetz';
  return sources[0] === 'fahrplan' ? 'nach Fahrplan' : 'über das Gleisnetz';
}

function renderRouteInfo() {
  const info = $('route-info');
  info.classList.toggle('error', Boolean(draft.routeError));
  if (draft.routeError) info.textContent = draft.routeError;
  else if (draft.routing) info.textContent = 'Strecke wird berechnet …';
  else if (draft.route) info.textContent = `Strecke: ${formatKm(draft.route.lengthM)} · ${sourceLabel(draft.route.sources)}`;
  else info.textContent = '';
  $('save-trip').disabled = !draft.route || draft.saving;
}

function resetDraft() {
  draft.stops = [emptyStop(), emptyStop()];
  draft.requestId++;
  draft.route = null;
  draft.routeError = '';
  draft.routing = false;
  draft.editingId = null;
  $('trip-year').value = currentYear();
  $('trip-note').value = '';
  setFormMode();
  renderStops();
  mapView.showDraft(draft.stops, null);
  renderRouteInfo();
}

$('reset-trip').addEventListener('click', resetDraft);

$('trip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!draft.route || draft.saving) return;
  clearMessage();
  draft.saving = true;
  renderRouteInfo();
  try {
    await Promise.all(draft.stops.map((s) => s.naming));
    const fields = {
      date: `${$('trip-year').value}-01-01`,
      train: '',
      note: $('trip-note').value.trim(),
      group: $('trip-group').value.trim(),
      stops: draft.stops.map(({ name, lon, lat }) => ({ name, lon, lat })),
      // Unveränderte Strecke beim Bearbeiten nicht noch einmal vereinfachen.
      coords: draft.route.sources.includes('gespeichert')
        ? draft.route.coords
        : roundCoords(simplify(draft.route.coords)),
      lengthM: draft.route.lengthM,
    };
    const saved = draft.editingId ? await updateTrip(draft.editingId, fields) : await addTrip(fields);
    trips = [saved, ...trips.filter((t) => t.id !== saved.id)].sort((a, b) => b.date.localeCompare(a.date));
    showTripsOnMap();
    resetDraft();
    selectTrip(saved.id, { scroll: true });
  } catch (err) {
    handleStoreError(err);
  } finally {
    draft.saving = false;
    renderRouteInfo();
  }
});

// ---------- Gespeicherte Fahrt bearbeiten ----------

// Formular oben zwischen „Neue Fahrt“ und „Fahrt bearbeiten“ umschalten.
function setFormMode() {
  const editing = Boolean(draft.editingId);
  $('form-title').textContent = editing ? 'Fahrt bearbeiten' : 'Neue Fahrt';
  $('save-trip').textContent = editing ? 'Änderungen speichern' : 'Speichern';
  $('reset-trip').textContent = editing ? 'Abbrechen' : 'Verwerfen';
}

// Lädt eine gespeicherte Fahrt ins Formular: Bahnhöfe tauschen, Halte
// ergänzen, Punkte verschieben – alles wie beim Eintragen. Solange keine Halte
// geändert werden, bleibt die gespeicherte Linie erhalten.
function startEditing(trip) {
  mapView.closePopup();
  draft.editingId = trip.id;
  draft.stops = trip.stops.map((s) => ({ name: s.name, lon: s.lon, lat: s.lat }));
  draft.requestId++;
  draft.route = { coords: trip.coords, lengthM: trip.lengthM, sources: ['gespeichert'] };
  draft.routeError = '';
  draft.routing = false;
  $('trip-year').value = tripYear(trip.date);
  $('trip-note').value = tripDetails(trip);
  setClearableValue($('trip-group'), trip.group);
  setFormMode();
  renderStops();
  mapView.showDraft(draft.stops, draft.route.coords);
  mapView.fitDraft();
  renderRouteInfo();
  $('form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Popup an der angeklickten Linie: alle Angaben der Fahrt; Trip, Jahr und
// Zug/Notiz direkt änderbar, Bahnhöfe über das Formular oben.
function openTripPopup(id, latlng) {
  const trip = trips.find((t) => t.id === id);
  if (!trip) return;

  const box = el('div', 'trip-popup');
  box.append(el('div', 'popup-title', tripTitle(trip)));
  const stops = el('ol', 'popup-stops');
  for (const stop of trip.stops) stops.append(el('li', '', stop.name));
  box.append(stops, el('div', 'trip-meta', formatKm(trip.lengthM)));

  const form = el('form', 'popup-form');
  form.autocomplete = 'off';
  const field = (label, input) => {
    const wrap = el('label', '', label);
    wrap.append(input);
    return wrap;
  };
  const year = el('input');
  year.type = 'number';
  year.min = '1900';
  year.max = '2100';
  year.required = true;
  year.value = tripYear(trip.date);
  const note = el('input');
  note.type = 'text';
  note.value = tripDetails(trip);
  const group = el('input', 'clearable');
  group.type = 'text';
  group.setAttribute('list', 'group-names');
  group.placeholder = 'Ohne Trip';
  group.value = trip.group;

  const row = el('div', 'row');
  const yearField = field('Jahr', year);
  yearField.classList.add('year-field');
  row.append(yearField, field('Zug/Notiz', note));
  form.append(row, field('Trip', group));
  makeClearable(group);

  const actions = el('div', 'actions');
  const save = el('button', '', 'Speichern');
  save.type = 'submit';
  const edit = el('button', 'secondary', 'Bahnhöfe ändern');
  edit.type = 'button';
  edit.addEventListener('click', () => startEditing(trip));
  actions.append(save, edit);
  form.append(actions);
  box.append(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessage();
    save.disabled = true;
    try {
      const saved = await updateTrip(trip.id, {
        date: `${year.value}-01-01`,
        train: '',
        note: note.value.trim(),
        group: group.value.trim(),
      });
      replaceTrips([saved]);
      trips.sort((a, b) => b.date.localeCompare(a.date));
      mapView.closePopup();
      renderTrips();
      showTripsOnMap();
      selectTrip(saved.id);
    } catch (err) {
      handleStoreError(err);
      save.disabled = false;
    }
  });

  mapView.openPopup(latlng, box);
}

// Kleines × am Ende eines Trip-Feldes: leert nur die Auswahl, der Trip selbst
// bleibt bestehen.
function makeClearable(input) {
  const wrap = el('span', 'clearable-wrap');
  input.replaceWith(wrap);
  const clear = el('button', 'clear-button', '×');
  clear.type = 'button';
  clear.title = 'Auswahl entfernen';
  clear.setAttribute('aria-label', 'Auswahl entfernen');
  wrap.append(input, clear);
  const update = () => { clear.hidden = !input.value; };
  input.addEventListener('input', update);
  clear.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
  update();
}

function setClearableValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

for (const input of document.querySelectorAll('input.clearable')) makeClearable(input);

// ---------- Gespeicherte Fahrten ----------

// Die Liste zeigt entweder die Übersicht der Gruppen (view.group = null) oder
// die Fahrten einer Gruppe. ALL und NONE sind die beiden Sondergruppen
// „Alle Fahrten“ und „Ohne Gruppe“. Karte, Statistik und Länder zeigen immer
// die Fahrten der offenen Gruppe, in der Übersicht alle.
const ALL = Symbol('alle Fahrten');
const NONE = Symbol('ohne Gruppe');
const MAX_SEARCH_RESULTS = 50;
// mapGroup: der in der Übersicht angeklickte Trip – nur die Karte zeigt dann
// seine Fahrten, die Liste bleibt die Übersicht.
const view = { group: null, mapGroup: null, query: '', selecting: false, checked: new Set() };

function visibleTrips() {
  const group = view.group ?? view.mapGroup;
  if (group === null || group === ALL) return trips;
  if (group === NONE) return trips.filter((t) => !t.group);
  return trips.filter((t) => t.group === group);
}

const groupOf = (trip) => trip.group || NONE;
const isNamedGroup = (group) => typeof group === 'string';

function groupLabel(group) {
  if (group === ALL) return 'Alle Fahrten';
  if (group === NONE) return 'Ohne Trip';
  return `🗺️ ${group}`;
}

// Groß-/Kleinschreibung und Akzente ignorieren: „zurich“ findet „Zürich“.
const normalize = (text) => text.toLocaleLowerCase('de').normalize('NFD').replace(/\p{Diacritic}/gu, '');

function tripMatches(trip, query) {
  const text = [...trip.stops.map((s) => s.name), trip.train, trip.note, trip.group, tripYear(trip.date)].join(' ');
  return normalize(text).includes(query);
}

// Gruppen mit Anzahl und Kilometern; die mit der neuesten Fahrt zuerst
// (trips ist schon nach Jahr absteigend sortiert).
function groupSummaries() {
  const summaries = new Map();
  for (const trip of trips) {
    const group = groupOf(trip);
    if (!summaries.has(group)) summaries.set(group, { group, count: 0, lengthM: 0 });
    const summary = summaries.get(group);
    summary.count++;
    summary.lengthM += trip.lengthM;
  }
  const named = [...summaries.values()].filter((s) => isNamedGroup(s.group));
  return { named, none: summaries.get(NONE) ?? null };
}

const countLabel = (n) => `${n} ${n === 1 ? 'Fahrt' : 'Fahrten'}`;

function showTripsOnMap() {
  mapView.showTrips(visibleTrips());
  updateCountries();
}

// Bereiste Länder neu bestimmen. Die Umrisse laden beim ersten Mal nach;
// schlägt das fehl, fehlen nur Länderfläche und -zahl, der Rest läuft weiter.
let countriesRequest = 0;
async function updateCountries() {
  const request = ++countriesRequest;
  try {
    const countries = await loadCountries();
    if (request !== countriesRequest) return;
    const visited = visitedCountries(countries, visibleTrips());
    mapView.showCountries(visited.map((c) => c.feature));
    countryCount = visited.length;
  } catch {
    countryCount = null;
  }
  renderStats();
}

function tripTitle(trip) {
  const first = trip.stops[0].name;
  const last = trip.stops[trip.stops.length - 1].name;
  return `${first} → ${last}`;
}

function renderStats() {
  const shown = visibleTrips();
  const total = shown.reduce((sum, t) => sum + t.lengthM, 0);
  $('stats').textContent = shown.length
    ? [
      countLabel(shown.length),
      formatKm(total),
      countryCount && `${countryCount} ${countryCount === 1 ? 'Land' : 'Länder'}`,
    ].filter(Boolean).join(' · ')
    : '';
}

function renderTrips() {
  renderStats();
  const query = normalize(view.query.trim());
  const inGroup = view.group !== null;

  $('group-header').hidden = !inGroup;
  if (inGroup) {
    $('group-title').textContent = groupLabel(view.group);
    $('rename-group').hidden = !isNamedGroup(view.group);
  }

  const { named, none } = groupSummaries();
  $('group-names').replaceChildren(...named.map((s) => {
    const option = el('option');
    option.value = s.group;
    return option;
  }));

  // Übersicht: Gruppen, beim Suchen nur die passenden.
  const groupList = $('group-list');
  groupList.hidden = inGroup;
  if (!inGroup) {
    const total = trips.reduce((sum, t) => sum + t.lengthM, 0);
    const summaries = [{ group: ALL, count: trips.length, lengthM: total }, ...named, ...(none ? [none] : [])]
      .filter((s) => !query || (isNamedGroup(s.group) && normalize(s.group).includes(query)));
    if (!trips.length) groupList.replaceChildren(el('li', 'empty', 'Noch keine Fahrten gespeichert.'));
    else groupList.replaceChildren(...summaries.map(createGroupItem));
  }

  // Fahrten: in einer Gruppe deren Fahrten, in der Übersicht nur Suchtreffer.
  let listed = [];
  if (inGroup) listed = visibleTrips().filter((t) => !query || tripMatches(t, query));
  else if (query) listed = trips.filter((t) => tripMatches(t, query)).slice(0, MAX_SEARCH_RESULTS);

  const list = $('trip-list');
  list.hidden = !inGroup && !query;
  if (!list.hidden && !listed.length) {
    list.replaceChildren(el('li', 'empty', query ? 'Keine Fahrt gefunden.' : 'Keine Fahrten in diesem Trip.'));
  } else {
    list.replaceChildren(...listed.map(createTripItem));
  }

  // Ausgewählte Fahrten, die nicht mehr angezeigt werden, fallen aus der Auswahl.
  const listedIds = new Set(listed.map((t) => t.id));
  for (const id of view.checked) if (!listedIds.has(id)) view.checked.delete(id);

  $('select-bar').hidden = !listed.length;
  renderSelection();
}

function createGroupItem(summary) {
  const { group } = summary;
  const active = (view.mapGroup ?? ALL) === group;
  const li = el('li', `group-item${isNamedGroup(group) ? '' : ' special'}${active ? ' active' : ''}`);

  const title = el('div', 'trip-title', groupLabel(group));
  // Das ⓘ öffnet die Fahrtenliste; sichtbar nur beim Überfahren mit der Maus
  // (auf Touch-Geräten immer, siehe style.css).
  const info = el('button', 'info-button', 'ⓘ');
  info.type = 'button';
  info.title = 'Fahrten anzeigen';
  info.setAttribute('aria-label', `Fahrten von ${groupLabel(group)} anzeigen`);
  info.addEventListener('click', (e) => {
    e.stopPropagation();
    openGroup(group);
  });
  title.append(info);

  li.append(title, el('div', 'trip-meta', `${countLabel(summary.count)} · ${formatKm(summary.lengthM)}`));
  // Klick auf den Trip zeigt nur seine Fahrten auf der Karte; noch ein Klick
  // auf denselben Trip zeigt wieder alle.
  li.addEventListener('click', () => showGroupOnMap(active && group !== ALL ? null : group));
  return li;
}

function showGroupOnMap(group) {
  view.mapGroup = group === ALL ? null : group;
  selectedId = null;
  mapView.closePopup();
  renderTrips();
  showTripsOnMap();
  mapView.fitAllTrips();
}

function createTripItem(trip) {
  const li = el('li', trip.id === selectedId ? 'selected' : '');
  li.dataset.id = trip.id;

  if (view.selecting) {
    const box = el('input', 'trip-check');
    box.type = 'checkbox';
    box.checked = view.checked.has(trip.id);
    box.setAttribute('aria-label', `${tripTitle(trip)} auswählen`);
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => toggleChecked(trip.id, box.checked));
    li.append(box);
  }

  const text = el('div', 'trip-text');
  text.append(el('div', 'trip-title', tripTitle(trip)));
  const year = el('button', 'trip-year', tripYear(trip.date));
  year.type = 'button';
  year.title = 'Jahr ändern';
  year.addEventListener('click', (e) => {
    e.stopPropagation();
    editYear(trip, year);
  });
  // Die Gruppe nur nennen, wenn nicht ohnehin diese Gruppe offen ist.
  const showGroup = trip.group && !isNamedGroup(view.group);
  const rest = [formatKm(trip.lengthM), showGroup && `🗺️ ${trip.group}`].filter(Boolean);
  const meta = el('div', 'trip-meta');
  meta.append(year, ` · ${rest.join(' · ')}`);
  text.append(meta);
  if (tripDetails(trip)) text.append(el('div', 'trip-meta', tripDetails(trip)));

  const remove = el('button', 'remove', '×');
  remove.type = 'button';
  remove.title = 'Fahrt löschen';
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTrip(trip);
  });

  li.append(text, remove);
  li.addEventListener('click', () => {
    if (view.selecting) toggleChecked(trip.id, !view.checked.has(trip.id));
    else selectTrip(trip.id, { zoom: true });
  });
  return li;
}

function openGroup(group, { fit = true } = {}) {
  view.group = group;
  if (group !== null) view.mapGroup = group === ALL ? null : group;
  view.query = '';
  view.selecting = false;
  view.checked.clear();
  $('trip-search').value = '';
  selectedId = null;
  // Neue Fahrten landen gleich in der offenen Gruppe.
  if (isNamedGroup(group) && !draft.editingId) setClearableValue($('trip-group'), group);
  renderTrips();
  showTripsOnMap();
  if (fit) mapView.fitAllTrips();
}

// Zurück zur Übersicht; der Trip bleibt auf der Karte ausgewählt.
$('back-to-overview').addEventListener('click', () => openGroup(null));

$('trip-search').addEventListener('input', () => {
  view.query = $('trip-search').value;
  renderTrips();
});

$('rename-group').addEventListener('click', async () => {
  const oldName = view.group;
  const newName = prompt('Neuer Name des Trips:', oldName)?.trim();
  if (!newName || newName === oldName) return;
  clearMessage();
  try {
    const changed = await renameGroup(oldName, newName);
    replaceTrips(changed);
    if ($('trip-group').value === oldName) setClearableValue($('trip-group'), newName);
    view.group = newName;
    renderTrips();
  } catch (err) {
    handleStoreError(err);
  }
});

// ---------- Fahrten auswählen und gruppieren ----------

function toggleChecked(id, checked) {
  if (checked) view.checked.add(id);
  else view.checked.delete(id);
  const box = $('trip-list').querySelector(`[data-id="${id}"] .trip-check`);
  if (box) box.checked = checked;
  renderSelection();
}

function renderSelection() {
  const count = view.checked.size;
  $('toggle-select').textContent = view.selecting ? 'Auswahl beenden' : 'Fahrten auswählen';
  $('select-all').hidden = !view.selecting;
  $('group-assign').hidden = !view.selecting;
  $('selected-count').textContent = `${count} ${count === 1 ? 'Fahrt' : 'Fahrten'} ausgewählt`;
  $('assign-button').disabled = !count || !$('assign-group').value.trim();
  $('ungroup-button').disabled = !count;
}

$('toggle-select').addEventListener('click', () => {
  view.selecting = !view.selecting;
  view.checked.clear();
  renderTrips();
});

$('select-all').addEventListener('click', () => {
  for (const li of $('trip-list').querySelectorAll('li[data-id]')) view.checked.add(li.dataset.id);
  renderTrips();
});

$('assign-group').addEventListener('input', renderSelection);
$('assign-group').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('assign-button').click();
});

$('assign-button').addEventListener('click', () => assignGroup($('assign-group').value.trim()));
$('ungroup-button').addEventListener('click', () => assignGroup(''));

async function assignGroup(group) {
  const ids = [...view.checked];
  if (!ids.length) return;
  clearMessage();
  $('assign-button').disabled = true;
  try {
    replaceTrips(await setTripsGroup(ids, group));
    view.selecting = false;
    view.checked.clear();
    setClearableValue($('assign-group'), '');
    renderTrips();
    showTripsOnMap(); // in einer Gruppe fallen entfernte Fahrten von der Karte
  } catch (err) {
    handleStoreError(err);
    renderSelection();
  }
}

// Geänderte Fahrten aus der Datenbank in die Liste übernehmen.
function replaceTrips(changed) {
  const byId = new Map(changed.map((t) => [t.id, t]));
  trips = trips.map((t) => byId.get(t.id) ?? t);
}

function selectTrip(id, { zoom = false, scroll = false } = {}) {
  const trip = trips.find((t) => t.id === id);
  if (!trip) return;
  // In der Übersicht steht die Fahrt in keiner Liste, in einer anderen Gruppe
  // fehlt sie auf der Karte – dann ihre Gruppe öffnen.
  const listedHere = view.group === null ? view.query.trim() !== '' : visibleTrips().includes(trip);
  if (!listedHere) openGroup(groupOf(trip), { fit: false });
  selectedId = id;
  renderTrips();
  mapView.selectTrip(id, { zoom });
  if (scroll) {
    $('trip-list').querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

// Jahr direkt in der Liste ändern: Enter oder Verlassen des Feldes speichert,
// Escape bricht ab.
function editYear(trip, button) {
  const input = el('input', 'trip-year-input');
  input.type = 'number';
  input.min = '1900';
  input.max = '2100';
  input.value = tripYear(trip.date);
  input.setAttribute('aria-label', 'Jahr');
  input.addEventListener('click', (e) => e.stopPropagation());
  button.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const year = Number(input.value);
    if (!save || String(year) === tripYear(trip.date) || !Number.isInteger(year) || year < 1900 || year > 2100) {
      renderTrips();
      return;
    }
    clearMessage();
    input.disabled = true;
    try {
      const saved = await setTripYear(trip.id, year);
      trips = trips.map((t) => (t.id === trip.id ? saved : t))
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch (err) {
      handleStoreError(err);
    }
    renderTrips();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteTrip(trip) {
  if (!confirm(`Fahrt „${tripTitle(trip)}“ (${tripYear(trip.date)}) löschen?`)) return;
  clearMessage();
  try {
    await removeTrip(trip.id);
    trips = trips.filter((t) => t.id !== trip.id);
    view.checked.delete(trip.id);
    if (selectedId === trip.id) selectedId = null;
    renderTrips();
    showTripsOnMap();
    mapView.selectTrip(selectedId);
  } catch (err) {
    handleStoreError(err);
  }
}

// ---------- Start ----------

$('trip-year').value = currentYear();
if (hasAccess()) {
  enterApp();
  // Passwort im Hintergrund nachprüfen; ist es nicht mehr gültig, zurück zur Eingabe.
  checkStoredAccess().then((ok) => { if (!ok) showLogin(); }).catch(() => {});
} else {
  showLogin();
}
