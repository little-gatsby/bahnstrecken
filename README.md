# Bahnstrecken

Persönliche Karte der gefahrenen Bahnstrecken. Start, Ziel und Zwischenhalte
eingeben – die Strecke wird nach dem Verlauf echter Personenzüge berechnet,
notfalls auf dem Gleisnetz (nie auf Straßen), eingefärbt und gespeichert.
Fahrten lassen sich zu Gruppen zusammenfassen („Dreiländereck mit Max“);
eine eigene Kartenebene zeigt die bereisten Länder.

Reines HTML/CSS/JS mit ES-Modulen, kein Build-Schritt.

## Dienste

| Zweck | Dienst | Schlüssel |
| --- | --- | --- |
| Grundkarte | Jawg Lagoon, Esri, Stadia, OpenStreetMap | Jawg: Token in `js/config.js` |
| Gleise auf der Karte | OpenRailwayMap | keiner |
| Bahnhofssuche | Photon (komoot), weltweit | keiner |
| Strecke nach Fahrplan | [Transitous](https://transitous.org/) (MOTIS), weltweit | keiner |
| Strecke auf dem Gleisnetz (Rückfall) | BRouter (`brouter.de`, Profil `rail`) | keiner |
| Ländergrenzen | Natural Earth über `world-atlas` | keiner |
| Speichern | Supabase | `js/config.js` |

Die Routing- und Kartendienste werden größtenteils ehrenamtlich betrieben und
sind für geringe Nutzung gedacht. Transitous erlaubt die Nutzung nur für
Open-Source-Projekte ohne kommerziellen Zweck; siehe die
[Nutzungsregeln](https://transitous.org/api/) und die
[Datenquellen](https://transitous.org/sources/).

Die Werte in `js/config.js` sind keine Geheimnisse – sie stehen ohnehin im
Code, den jeder Browser lädt. Wer das Projekt selbst betreibt, trägt dort
eigene Werte ein; den Jawg-Token im Jawg-Konto auf die eigene Domain
beschränken.

## Einrichten

1. Ein Supabase-Projekt anlegen und `supabase/schema.sql` im SQL-Editor ausführen.
2. Für jede Person einen Bereich mit eigenem Passwort anlegen (Befehl steht
   am Ende von `schema.sql`). Wer das Passwort eingibt, sieht nur die Fahrten
   dieses Bereichs und kann dort neue eintragen. Die Datenbank speichert nur
   einen Hash, im Code steht kein Passwort.
3. URL und öffentlichen Schlüssel des Projekts in `js/config.js` eintragen.

## Lokal starten

```bash
python3 serve.py
```

Dann `http://localhost:8020` öffnen. `serve.py` verbietet dem Browser das
Zwischenspeichern; mit `python3 -m http.server` mischt er nach Änderungen
gern alte und neue JS-Dateien, und die Seite bleibt weiß.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
