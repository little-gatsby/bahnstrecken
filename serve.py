# Lokaler Testserver wie `python3 -m http.server`, aber ohne Browser-Cache.
# Sonst mischt der Browser nach Änderungen neue und alte JS-Dateien, und die
# Seite bleibt weiß. Aufruf: python3 serve.py  →  http://localhost:8020

import functools
import http.server
import os

PORT = 8020


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


handler = functools.partial(NoCacheHandler, directory=os.path.dirname(os.path.abspath(__file__)))
with http.server.ThreadingHTTPServer(('', PORT), handler) as server:
    print(f'Bahnstrecken läuft auf http://localhost:{PORT}')
    server.serve_forever()
