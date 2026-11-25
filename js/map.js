// Alles, was Leaflet betrifft. Leaflet selbst kommt als klassisches Skript
// (globales L) aus index.html. Koordinaten kommen als [lon, lat] herein.

import { JAWG_ACCESS_TOKEN } from './config.js';

const TRIP_COLOR = '#6d28d9';
const TRIP_SELECTED_COLOR = '#f59e0b';
const PREVIEW_COLOR = '#2563eb';

const toLatLngs = (coords) => coords.map(([lon, lat]) => [lat, lon]);

const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';
const LAYER_STORAGE_KEY = 'bahnstrecken.layers';

// Grundkarten. Die erste ist die Vorgabe; bis auf Jawg brauchen sie keinen Schlüssel.
function createBaseLayers() {
  const jawg = JAWG_ACCESS_TOKEN
    ? {
      'Lagoon (Jawg)': L.tileLayer(
        `https://tile.jawg.io/jawg-lagoon/{z}/{x}/{y}{r}.png?lang=de&access-token=${encodeURIComponent(JAWG_ACCESS_TOKEN)}`,
        {
          maxZoom: 22,
          attribution: '<a href="https://jawg.io">© Jawg</a> ' + OSM_ATTRIBUTION,
        },
      ),
    }
    : {};
  return {
    ...jawg,
    'Hellgrau (Esri)': L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 16, attribution: 'Karte: Esri, HERE, Garmin, © OpenStreetMap-Mitwirkende' },
    ),
    // Stadia läuft auf localhost ohne Konto; für eine eigene Domain braucht
    // es ein kostenloses Konto mit eingetragener Domain.
    'Ruhig (Stadia Alidade Smooth)': L.tileLayer(
      'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
      { maxZoom: 20, attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a>, © OpenMapTiles, ' + OSM_ATTRIBUTION },
    ),
    'Dunkel (Stadia Alidade Smooth Dark)': L.tileLayer(
      'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
      { maxZoom: 20, attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a>, © OpenMapTiles, ' + OSM_ATTRIBUTION },
    ),
    'OpenStreetMap blass': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'basemap-faded',
      attribution: OSM_ATTRIBUTION,
    }),
    'OpenStreetMap farbig': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
    }),
  };
}

const COUNTRY_OVERLAY = 'Bereiste Länder';

// OpenRailwayMap gibt es in mehreren Darstellungen; „Bahnnetz“ ist die übliche.
function createRailwayLayers() {
  const railway = (style, opacity) => L.tileLayer(`https://tiles.openrailwaymap.org/${style}/{z}/{x}/{y}.png`, {
    maxZoom: 19,
    opacity,
    attribution: 'Gleise: <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA)',
  });
  return {
    'Bahnnetz': railway('standard', 0.45),
    'Elektrifizierung': railway('electrification', 0.6),
    'Höchstgeschwindigkeit': railway('maxspeed', 0.6),
  };
}

function readLayerChoice() {
  try {
    return JSON.parse(localStorage.getItem(LAYER_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeLayerChoice(choice) {
  try {
    localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Ohne Speicher gilt die Auswahl nur bis zum Neuladen.
  }
}

// Ganz Europa – Startansicht auf dem Handy.
const EUROPE = [[36, -10], [70, 32]];

// bottomInset: wie viel der Karte unten verdeckt ist (die Schublade auf dem
// Handy); Einpassen und Popups halten diesen Bereich frei.
export function createMap(element, { onMapClick, onMapTap = () => {}, onStopMoved, onTripClick, bottomInset = () => 0 }) {
  // Doppelklick setzt einen Halt (siehe unten) und zoomt deshalb nicht.
  // Nördlich und südlich der Weltkarte gibt es nur graue Fläche – dorthin
  // lässt sich die Karte nicht schieben.
  const map = L.map(element, {
    worldCopyJump: true,
    doubleClickZoom: false,
    maxBounds: [[-85, -100_000], [85, 100_000]],
    maxBoundsViscosity: 1,
  }).setView([51.2, 10.4], 6);

  // So weit herauszoomen, dass die Welt höher ist als die Karte, geht nicht –
  // sonst bleiben oben und unten graue Streifen.
  function updateMinZoom() {
    const height = map.getSize().y;
    if (height > 0) map.setMinZoom(Math.max(0, Math.ceil(Math.log2(height / 256))));
  }

  // In einem Hintergrund-Tab hat die Karte beim Laden keine Größe; fitBounds
  // springt dann auf die höchste Zoomstufe. Deshalb erst einpassen, wenn sie
  // sichtbar ist, und bei Größenänderungen nachmessen.
  let pendingFit = null;
  const hasSize = () => map.getSize().x > 0 && map.getSize().y > 0;
  function fitBounds(bounds, options = {}) {
    if (!hasSize()) {
      pendingFit = [bounds, options];
      return;
    }
    const [x, y] = options.padding ?? [0, 0];
    map.fitBounds(bounds, { ...options, paddingTopLeft: [x, y], paddingBottomRight: [x, y + bottomInset()] });
  }
  updateMinZoom();
  new ResizeObserver(() => {
    map.invalidateSize();
    updateMinZoom();
    if (pendingFit && hasSize()) {
      const fit = pendingFit;
      pendingFit = null;
      fitBounds(...fit);
    }
  }).observe(element);

  // Eigene Ebene für die Länderflächen: über den Kacheln, unter den Fahrten.
  map.createPane('countries').style.zIndex = 350;
  const countryLayer = L.geoJSON(null, {
    pane: 'countries',
    interactive: false,
    style: { color: TRIP_COLOR, weight: 1, opacity: 0.45, fillColor: TRIP_COLOR, fillOpacity: 0.13 },
  });

  const baseLayers = createBaseLayers();
  const overlays = { ...createRailwayLayers(), [COUNTRY_OVERLAY]: countryLayer };
  const saved = readLayerChoice();
  (baseLayers[saved.base] ?? Object.values(baseLayers)[0]).addTo(map);
  // Vorgabe: nur die Grundkarte – Lagoon zeigt die Gleise schon dezent selbst.
  for (const name of saved.overlays ?? []) overlays[name]?.addTo(map);

  L.control.layers(baseLayers, overlays).addTo(map);
  // Gewählte Ebenen merken, damit die Karte beim nächsten Mal genauso aussieht.
  map.on('baselayerchange overlayadd overlayremove', () => {
    writeLayerChoice({
      base: Object.keys(baseLayers).find((name) => map.hasLayer(baseLayers[name])),
      overlays: Object.keys(overlays).filter((name) => map.hasLayer(overlays[name])),
    });
  });
  L.control.scale({ imperial: false }).addTo(map);
  map.attributionControl.addAttribution('Fahrpläne: <a href="https://transitous.org/sources/">Transitous und Quellen</a>');

  const tripLayer = L.featureGroup().addTo(map);
  const draftLayer = L.featureGroup().addTo(map);
  const tripLines = new Map(); // id → Polylinie

  // Erst ein Doppelklick überträgt den Punkt ins Formular – ein einfacher Klick
  // in die Karte (etwa zum Schließen eines Popups) soll keine Fahrt beginnen.
  map.on('dblclick', (e) => onMapClick({ lon: e.latlng.lng, lat: e.latlng.lat }));
  map.on('click', onMapTap);

  function showTrips(trips) {
    tripLayer.clearLayers();
    tripLines.clear();
    for (const trip of trips) {
      const latlngs = toLatLngs(trip.coords);
      // Weißer Rand darunter, damit die Fahrt über den Gleisen der Bahnkarte hervorsticht.
      L.polyline(latlngs, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }).addTo(tripLayer);
      const line = L.polyline(latlngs, { color: TRIP_COLOR, weight: 4.5 })
        .on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          onTripClick(trip.id, e.latlng);
        })
        .addTo(tripLayer);
      tripLines.set(trip.id, line);
    }
  }

  function showCountries(features) {
    countryLayer.clearLayers();
    countryLayer.addData(features);
  }

  function selectTrip(id, { zoom = false } = {}) {
    for (const [tripId, line] of tripLines) {
      const selected = tripId === id;
      line.setStyle({ color: selected ? TRIP_SELECTED_COLOR : TRIP_COLOR, weight: selected ? 6 : 4.5 });
      if (selected) {
        line.bringToFront();
        if (zoom) fitBounds(line.getBounds(), { padding: [30, 30] });
      }
    }
  }

  // Mit ganzen Zoomstufen passt Europa im Hochformat nur samt halb Afrika
  // hinein – deshalb hier in Viertelschritten einpassen.
  function fitEurope() {
    const snap = map.options.zoomSnap;
    map.options.zoomSnap = 0.25;
    fitBounds(EUROPE, { padding: [10, 10], animate: false });
    map.options.zoomSnap = snap;
  }

  function fitAllTrips() {
    if (tripLines.size) fitBounds(tripLayer.getBounds(), { padding: [30, 30] });
  }

  // Entwurf: nummerierte, verschiebbare Haltepunkte und die gestrichelte Vorschau.
  function showDraft(stops, coords) {
    draftLayer.clearLayers();
    if (coords) {
      L.polyline(toLatLngs(coords), { color: PREVIEW_COLOR, weight: 5, dashArray: '8 6', interactive: false })
        .addTo(draftLayer);
    }
    stops.forEach((stop, index) => {
      if (stop.lat == null) return;
      L.marker([stop.lat, stop.lon], {
        draggable: true,
        title: stop.name,
        icon: L.divIcon({ className: 'stop-marker', html: String(index + 1), iconSize: [24, 24] }),
      })
        .on('dragend', (e) => {
          const { lat, lng } = e.target.getLatLng();
          onStopMoved(index, { lon: lng, lat });
        })
        .addTo(draftLayer);
    });
  }

  function fitDraft() {
    if (draftLayer.getLayers().length) {
      fitBounds(draftLayer.getBounds(), { padding: [40, 40], maxZoom: 13 });
    }
  }

  // Popup mit den Angaben einer Fahrt (Inhalt baut main.js).
  const popup = L.popup({ maxWidth: 320, minWidth: 260, autoPanPadding: [20, 20] });

  function openPopup(latlng, content) {
    popup.options.autoPanPaddingBottomRight = [20, 20 + bottomInset()];
    popup.setLatLng(latlng).setContent(content).openOn(map);
  }

  function closePopup() {
    map.closePopup(popup);
  }

  return { showTrips, showCountries, selectTrip, fitAllTrips, fitEurope, showDraft, fitDraft, openPopup, closePopup };
}
