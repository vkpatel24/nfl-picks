"""Serve the site locally and exit once no tab has it open.

Each open tab holds a /alive event stream. When the last one closes (and no new
one shows up within GRACE seconds, which covers reloads), the server shuts down.
"""
import http.server
import os
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
GRACE = 5      # seconds with no tabs before exiting
STARTUP = 60   # give the first tab this long to connect

lock = threading.Lock()
tabs = 0
empty_since = time.monotonic() - GRACE + STARTUP


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path != '/alive':
            return super().do_GET()
        global tabs, empty_since
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        with lock:
            tabs += 1
        try:
            while True:  # a write fails once the tab is gone
                self.wfile.write(b': ping\n\n')
                self.wfile.flush()
                time.sleep(2)
        except OSError:
            pass
        finally:
            with lock:
                tabs -= 1
                if tabs == 0:
                    empty_since = time.monotonic()


def watchdog(server):
    while True:
        time.sleep(1)
        with lock:
            idle = tabs == 0 and time.monotonic() - empty_since > GRACE
        if idle:
            server.shutdown()
            return


os.chdir(os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer.daemon_threads = True
with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler) as server:
    threading.Thread(target=watchdog, args=(server,), daemon=True).start()
    server.serve_forever()
