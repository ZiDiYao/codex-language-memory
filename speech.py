"""Local, user-initiated pronunciation using macOS installed voices."""

import subprocess
import atexit
from pathlib import Path
from threading import Lock

_lock = Lock()
_process = None
_record_id = None
VOICES = {"en": "Samantha", "zh": "Tingting", "ja": "Kyoko", "ko": "Yuna", "fr": "Thomas", "es": "Mónica"}


@atexit.register
def close():
    global _process
    with _lock:
        if _process is not None and _process.poll() is None:
            _process.terminate()
            try:
                _process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                _process.kill()
                _process.wait()
        _process = None


def status():
    with _lock:
        code = _process.poll() if _process is not None else None
        return {"playing": _process is not None and code is None,
                "record_id": _record_id,
                "error": "speechUnavailable" if code not in (None, 0, -15) else None}


def play(store, record_id):
    global _process, _record_id
    point = store.get_point(record_id)
    if point["status"] != "found":
        return point
    record = point["record"]
    text = record["note_title"].strip()
    voice = VOICES.get(record["language"].split("-")[0])
    if record["language"].lower() == "en-gb":
        voice = "Daniel"
    if not text or voice is None or not Path("/usr/bin/say").is_file():
        return {"status": "failed", "error": "speechUnavailable"}
    with _lock:
        same = _record_id == record_id and _process is not None and _process.poll() is None
        if _process is not None and _process.poll() is None:
            _process.terminate()
            try:
                _process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                _process.kill()
                _process.wait()
        _process, _record_id = None, None
        if same:
            return {"playing": False, "record_id": record_id}
        try:
            # stdin keeps learning text out of command-line options and process listings.
            _process = subprocess.Popen(["/usr/bin/say", "-v", voice, "-r", "165"],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _process.stdin.write(text.replace("[[", "[ [").encode("utf-8"))
            _process.stdin.close()
            _record_id = record_id
        except OSError:
            if _process is not None and _process.poll() is None:
                _process.terminate()
                _process.wait()
            _process = None
            return {"status": "failed", "error": "speechUnavailable"}
        return {"playing": True, "record_id": record_id}
