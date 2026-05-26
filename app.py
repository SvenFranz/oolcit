from __future__ import annotations
import os
from dataclasses import dataclass
from pathlib import Path
import random
from typing import Optional

from flask import Flask, jsonify, render_template, request, session, send_file, abort, url_for


app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-key")
#app.secret_key = "u62FhuKPL2xn2QtRGJRqUj:Q<d~9$Z+#dFL%§2v)NqcMaQd§"

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
AUDIO_DIR = DATA_DIR / "audio"
LIST_DIR = AUDIO_DIR / "lists"
NOISE_DIR = AUDIO_DIR / "noise"
LIST_MAPPING_FILE = AUDIO_DIR / "list_mapping.dat"

LIST_EXTENSIONS = {
    ".dat",
}

AUDIO_EXTENSIONS = {
    ".wav",
    ".mp3",
    ".ogg",
    ".flac",
    ".m4a",
}

@dataclass
class Sample:
    text: str
    female_path: str
    male_path: str
    female_rms: Optional[float] = None
    male_rms: Optional[float] = None

    def audio_path(self, voice: str) -> str:
        if voice == "male":
            return self.male_path
        return self.female_path

    def rms_value(self, voice: str) -> Optional[float]:
        if voice == "male":
            return self.male_rms
        return self.female_rms

@dataclass
class TrainingList:
    filename: str
    label: str

    @property
    def id(self) -> str:
        return self.filename

def parse_float(value: str) -> Optional[float]:
    value = value.strip().replace(",", ".")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_sample_line(line: str) -> Optional[Sample]:
    """
    Erwartetes Format:

        Pfad_weiblich;Pfad_männlich;RMS_weiblich;RMS_männlich;Lösungstext

    Beispiel:

        data/audio/female/sentence_leisure/sentence_leisure_9.wav;
        data/audio/male/sentence_leisure/sentence_leisure_9.wav;
        -13.225373;
        -14.8163395;
        Wenn morgen die Sonne scheint, grillen wir im Park.
    """
    line = line.strip()

    if not line:
        return None

    if line.startswith("#"):
        return None

    parts = [p.strip() for p in line.split(";", maxsplit=4)]

    if len(parts) < 5:
        return None

    female_path = parts[0]
    male_path = parts[1]
    female_rms = parse_float(parts[2])
    male_rms = parse_float(parts[3])
    text = parts[4]

    return Sample(
        text=text,
        female_path=female_path,
        male_path=male_path,
        female_rms=female_rms,
        male_rms=male_rms,
    )

def load_samples_from_file(filename: str) -> list[Sample]:
    list_file = safe_list_file(filename)

    samples: list[Sample] = []

    with list_file.open("r", encoding="utf-8") as f:
        for line in f:
            sample = parse_sample_line(line)

            if sample is not None:
                samples.append(sample)

    return samples


def safe_media_path(rel_path: str) -> Path:
    """
    Verhindert Path-Traversal.
    Erlaubt nur Dateien innerhalb des Projektordners.
    """
    candidate = (BASE_DIR / rel_path).resolve()

    if not str(candidate).startswith(str(BASE_DIR)):
        abort(403)

    if not candidate.exists() or not candidate.is_file():
        abort(404)

    return candidate

def parse_list_mapping_line(line: str) -> Optional[TrainingList]:
    """
    Erwartetes Format:

        Dateiname;Anzeigename

    Beispiel:

        sentence_leisure.dat;Sätze zum Thema Freizeit und Arbeit

    Kommentarzeilen mit # werden ignoriert.
    """
    line = line.strip()

    if not line:
        return None

    if line.startswith("#"):
        return None

    parts = [p.strip() for p in line.split(";", maxsplit=1)]

    if len(parts) != 2:
        return None

    filename = parts[0]
    label = parts[1]

    if not filename.lower().endswith(".dat"):
        return None

    return TrainingList(
        filename=filename,
        label=label,
    )

def discover_lists() -> list[TrainingList]:
    """
    Liest die Listen-Zuordnung dynamisch aus LIST_MAPPING_FILE.

    Dadurch können neue Listen ergänzt werden, ohne den Flask-Server neu zu starten.
    """
    if not LIST_MAPPING_FILE.exists():
        return []

    result: list[TrainingList] = []

    with LIST_MAPPING_FILE.open("r", encoding="utf-8") as f:
        for line in f:
            entry = parse_list_mapping_line(line)

            if entry is None:
                continue

            list_path = LIST_DIR / entry.filename

            # Nur tatsächlich vorhandene .dat-Dateien anzeigen
            if not list_path.exists():
                continue

            if not list_path.is_file():
                continue

            if list_path.suffix.lower() not in LIST_EXTENSIONS:
                continue

            result.append(entry)

    return result

def safe_list_file(filename: str) -> Path:
    """
    Gibt einen sicheren Pfad innerhalb von data/audio/lists zurück.
    Verhindert Path-Traversal wie ../../etc/passwd.
    """
    candidate = (LIST_DIR / filename).resolve()

    if not str(candidate).startswith(str(LIST_DIR.resolve())):
        abort(403)

    if not candidate.exists() or not candidate.is_file():
        abort(404)

    if candidate.suffix.lower() not in LIST_EXTENSIONS:
        abort(400)

    return candidate

@app.route("/")
def index():
    return render_template(
        "index.html",
        title="OLCIT – Oldenburger CI-Trainer",
    )

@app.route("/media/<path:rel_path>")
def media(rel_path: str):
    path = safe_media_path(rel_path)
    return send_file(path)


@app.route("/api/lists")
def api_lists():
    lists = discover_lists()

    return jsonify({
        "lists": [
            {
                "id": entry.id,
                "filename": entry.filename,
                "label": entry.label,
            }
            for entry in lists
        ]
    })

@app.route("/api/noises")
def api_noises():
    return jsonify({
        "noises": discover_noises()
    })

@app.route("/api/select-list", methods=["POST"])
def api_select_list():
    data = request.get_json(force=True)

    filename = data.get("filename")
    label = data.get("label", "")

    if not filename:
        session["selected_filename"] = None
        session["selected_label"] = None
        session["remaining_indices"] = []
        session["current_index"] = None

        return jsonify({
            "ok": False,
            "message": "Keine Liste ausgewählt."
        }), 400

    # Prüfen, ob die Datei in der aktuellen dynamischen Zuordnung existiert
    available = discover_lists()
    allowed_filenames = {entry.filename for entry in available}

    if filename not in allowed_filenames:
        return jsonify({
            "ok": False,
            "message": "Diese Liste ist nicht in der Zuordnungsdatei eingetragen."
        }), 400

    samples = load_samples_from_file(filename)

    if not samples:
        session["selected_filename"] = None
        session["selected_label"] = None
        session["remaining_indices"] = []
        session["current_index"] = None

        return jsonify({
            "ok": False,
            "message": "Die ausgewählte Liste ist leer oder konnte nicht gelesen werden."
        }), 400

    indices = list(range(len(samples)))
    random.shuffle(indices)

    session["selected_filename"] = filename
    session["selected_label"] = label
    session["remaining_indices"] = indices
    session["current_index"] = None

    return jsonify({
        "ok": True,
        "filename": filename,
        "label": label,
        "count": len(samples),
    })


def sample_to_payload(sample: Sample, index: int, voice: str, reveal_text: bool = False):
    audio_rel = sample.audio_path(voice)

    payload = {
        "index": index,
        "audio_url": url_for("media", rel_path=audio_rel),
        "rms": sample.rms_value(voice),
    }

    if reveal_text:
        payload["text"] = sample.text

    return payload


@app.route("/api/next", methods=["POST"])
def api_next():
    filename = session.get("selected_filename")
    remaining = session.get("remaining_indices", [])

    if not filename:
        return jsonify({
            "ok": False,
            "message": "Bitte zuerst eine Liste auswählen."
        }), 400

    samples = load_samples_from_file(filename)

    if not remaining:
        session["current_index"] = None

        return jsonify({
            "ok": False,
            "finished": True,
            "message": "Diese Liste ist komplett, bitte wählen Sie die nächste Liste aus."
        })

    data = request.get_json(silent=True) or {}
    voice = data.get("voice", "female")

    index = remaining.pop(0)
    session["remaining_indices"] = remaining
    session["current_index"] = index

    sample = samples[index]

    return jsonify({
        "ok": True,
        "finished": False,
        "sample": sample_to_payload(sample, index, voice, reveal_text=False),
        "remaining": len(remaining),
    })


@app.route("/api/repeat", methods=["POST"])
def api_repeat():
    filename = session.get("selected_filename")
    current_index = session.get("current_index")

    if filename is None or current_index is None:
        return jsonify({
            "ok": False,
            "message": "Es gibt aktuell kein Sample zum Wiederholen."
        }), 400

    samples = load_samples_from_file(filename)

    if current_index < 0 or current_index >= len(samples):
        return jsonify({
            "ok": False,
            "message": "Ungültiger Sample-Index."
        }), 400

    data = request.get_json(silent=True) or {}
    voice = data.get("voice", "female")

    sample = samples[current_index]

    return jsonify({
        "ok": True,
        "sample": sample_to_payload(sample, current_index, voice, reveal_text=False),
    })


@app.route("/api/solution")
def api_solution():
    filename = session.get("selected_filename")
    current_index = session.get("current_index")

    if filename is None or current_index is None:
        return jsonify({
            "ok": False,
            "message": "Keine Lösung verfügbar."
        }), 400

    samples = load_samples_from_file(filename)

    if current_index < 0 or current_index >= len(samples):
        return jsonify({
            "ok": False,
            "message": "Ungültiger Sample-Index."
        }), 400

    return jsonify({
        "ok": True,
        "text": samples[current_index].text,
    })


def prettify_noise_label(stem: str) -> str:
    """
    Macht aus Dateinamen lesbare Labels.

    Beispiele:
    white_noise -> White Noise
    street -> Street
    mensa_cafe -> Mensa Cafe
    """
    replacements = {
        "white_noise": "Rauschen",
        "noise": "Rauschen",
        "refactory": "Mensa/Café",
        "cafeteria": "Mensa/Café",
        "mensa": "Mensa/Café",
        "street": "Straßenlärm",
        "street_noise": "Straßenlärm",
    }

    key = stem.lower()

    if key in replacements:
        return replacements[key]

    return stem.replace("_", " ").replace("-", " ").title()


def discover_noises() -> list[dict]:
    """
    Lädt alle Audiodateien aus data/audio/noise dynamisch.
    """
    if not NOISE_DIR.exists():
        return []

    noises = []

    for path in sorted(NOISE_DIR.iterdir()):
        if not path.is_file():
            continue

        if path.suffix.lower() not in AUDIO_EXTENSIONS:
            continue

        rel_path = path.relative_to(BASE_DIR).as_posix()

        noises.append({
            "id": path.stem,
            "label": prettify_noise_label(path.stem),
            "path": rel_path,
            "url": url_for("media", rel_path=rel_path),
        })

    return noises

if __name__ == "__main__":
    app.run(debug=True)
