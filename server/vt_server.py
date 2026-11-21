"""
vt_server.py — Video Translator Remote job server (runs in a container on B70, CPU only)
Port: 17497 (VT_PORT)

Does the media work (ffmpeg) for the Chrome extension. The extension drives the pipeline
and calls the ASR / LLM / TTS services itself.

  GET    /health                        -> {"status":"ok","ffmpeg":"..."}
  POST   /jobs                          raw video/audio body, header X-Filename
                                        -> {"job_id","duration","has_video","width","height"}
  POST   /jobs/<id>/segment             {"min_len","max_len","silence_sec"} -> {"segments":[{"i","start","end"}]}
  GET    /jobs/<id>/segments/<i>.wav    16 kHz mono WAV of one speech segment
  PUT    /jobs/<id>/clips/<i>           raw WAV body = synthesized speech for segment i
  POST   /jobs/<id>/render              {"segments":[{"i","start","end","text"}],"burn_subtitles",
                                         "original_volume","max_speedup"}   (runs in background)
  GET    /jobs/<id>                     -> job status {"state","progress","message","outputs":[...]}
  GET    /jobs/<id>/download/<name>     output.mp4 | output.m4a | subtitles.srt | subtitles.vtt | dubbed.wav
  DELETE /jobs/<id>
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import unquote

DATA_DIR       = Path(os.environ.get("VT_DATA_DIR", "/data")) / "jobs"
HOST           = os.environ.get("VT_HOST", "0.0.0.0")
PORT           = int(os.environ.get("VT_PORT", "17497"))
KEEP_DAYS      = float(os.environ.get("VT_KEEP_DAYS", "3"))
MAX_UPLOAD_MB  = int(os.environ.get("VT_MAX_UPLOAD_MB", "4096"))
SUBTITLE_FONT  = os.environ.get("VT_SUBTITLE_FONT", "Noto Sans CJK TC")

JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
DOWNLOADS = {
    "output.mp4":    "video/mp4",
    "output.m4a":    "audio/mp4",
    "subtitles.srt": "text/plain; charset=utf-8",
    "subtitles.vtt": "text/vtt; charset=utf-8",
    "dubbed.wav":    "audio/wav",
}

_job_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def job_lock(job_id: str) -> threading.Lock:
    with _locks_guard:
        return _job_locks.setdefault(job_id, threading.Lock())


# -- helpers -----------------------------------------------------------------
def run(cmd: list[str], timeout: int = 3600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def ffmpeg_version() -> str:
    try:
        return run(["ffmpeg", "-version"], 10).stdout.splitlines()[0]
    except Exception as exc:  # noqa: BLE001
        return f"unavailable: {exc}"


def job_dir(job_id: str) -> Path:
    if not JOB_ID_RE.match(job_id or ""):
        raise KeyError("bad job id")
    d = DATA_DIR / job_id
    if not d.is_dir():
        raise KeyError("job not found")
    return d


def read_meta(d: Path) -> dict:
    return json.loads((d / "job.json").read_text(encoding="utf-8"))


_meta_lock = threading.Lock()


def write_meta(d: Path, **changes) -> dict:
    with _meta_lock:
        meta = read_meta(d) if (d / "job.json").exists() else {}
        meta.update(changes)
        tmp = d / "job.json.tmp"
        tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        tmp.replace(d / "job.json")
        return meta


def probe(path: Path) -> dict:
    p = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], 120)
    if p.returncode != 0:
        raise ValueError(f"Could not read media file: {p.stderr.strip()[:300]}")
    info = json.loads(p.stdout)
    streams = info.get("streams", [])
    video = next((s for s in streams
                  if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic") != 1), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not audio:
        raise ValueError("The file has no audio track.")
    duration = float(info.get("format", {}).get("duration") or audio.get("duration") or 0)
    return {
        "duration":  duration,
        "has_video": video is not None,
        "width":     int(video.get("width", 0)) if video else 0,
        "height":    int(video.get("height", 0)) if video else 0,
    }


def wav_duration(path: Path) -> float:
    import soundfile as sf
    info = sf.info(str(path))
    return info.frames / float(info.samplerate or 1)


def fmt_ts(sec: float, sep: str) -> str:
    ms = int(round(max(sec, 0.0) * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


# -- segmentation ------------------------------------------------------------
def detect_silences(wav: Path, noise_db: float = -32.0, min_silence: float = 0.15) -> list[tuple[float, float]]:
    p = run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(wav),
             "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"], 1800)
    silences, start = [], None
    for line in p.stderr.splitlines():
        m = re.search(r"silence_start:\s*(-?[\d.]+)", line)
        if m:
            start = max(float(m.group(1)), 0.0)
            continue
        m = re.search(r"silence_end:\s*(-?[\d.]+)", line)
        if m and start is not None:
            silences.append((start, float(m.group(1))))
            start = None
    if start is not None:                      # file ends in silence
        silences.append((start, 1e9))
    return silences


def build_segments(duration: float, silences: list[tuple[float, float]],
                   min_len: float, max_len: float, major: float) -> list[tuple[float, float]]:
    """Cut the speech into sentence-sized pieces at silences."""
    silences = [(s, min(e, duration)) for s, e in silences]
    spans, cur = [], 0.0
    for s, e in silences:
        if s - cur > 0.05:
            spans.append((cur, s))
        cur = max(cur, e)
    if duration - cur > 0.05:
        spans.append((cur, duration))
    if not spans:
        return []

    def cut_points(a: float, b: float) -> list[tuple[float, float]]:
        # silences strictly inside (a, b) as (midpoint, length)
        return [((s + e) / 2, e - s) for s, e in silences if s > a + 0.2 and e < b - 0.2]

    out: list[tuple[float, float]] = []
    for a, b in spans:
        start = a
        while b - start > max_len:
            cands = [(t, l) for t, l in cut_points(start, b) if min_len <= t - start <= max_len]
            majors = [c for c in cands if c[1] >= major]
            if majors:
                cut = majors[0][0]
            elif cands:
                cut = max(cands, key=lambda c: (c[1], -abs(c[0] - start - max_len * 0.6)))[0]
            else:
                cut = start + max_len
            out.append((start, cut))
            start = cut
        out.append((start, b))

    # merge too-short pieces into the previous one when the gap is small
    merged: list[tuple[float, float]] = []
    for a, b in out:
        if merged and (b - a) < min_len and a - merged[-1][1] < 0.8 and (b - merged[-1][0]) <= max_len:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    # pad slightly so words are not clipped
    padded: list[tuple[float, float]] = []
    for i, (a, b) in enumerate(merged):
        lo = max(a - 0.12, padded[-1][1] if padded else 0.0)
        nxt = merged[i + 1][0] if i + 1 < len(merged) else duration
        hi = min(b + 0.15, nxt, duration)
        padded.append((round(lo, 3), round(max(hi, lo + 0.1), 3)))
    return padded


def do_segment(d: Path, params: dict) -> list[dict]:
    meta = read_meta(d)
    min_len = float(params.get("min_len", 1.5))
    max_len = float(params.get("max_len", 20.0))
    major   = float(params.get("silence_sec", 0.45))
    audio = d / "audio.wav"
    spans = build_segments(meta["duration"], detect_silences(audio), min_len, max_len, major)
    for old in d.glob("seg_*.wav"):
        old.unlink()
    segs = []
    for i, (a, b) in enumerate(spans):
        p = run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                 "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(audio),
                 "-ac", "1", "-ar", "16000", str(d / f"seg_{i}.wav")], 300)
        if p.returncode != 0:
            raise ValueError(f"ffmpeg failed on segment {i}: {p.stderr.strip()[:200]}")
        segs.append({"i": i, "start": a, "end": b})
    write_meta(d, segments=segs, state="segmented")
    return segs


# -- render ------------------------------------------------------------------
def fit_clip(src: Path, dst: Path, slot: float, max_speedup: float) -> float:
    """Speed a clip up (pitch preserved) if longer than its slot; return the new duration."""
    dur = wav_duration(src)
    if slot <= 0 or dur <= slot or max_speedup <= 1.0:
        shutil.copyfile(src, dst)
        return dur
    ratio = min(dur / slot, max_speedup)
    filt, r = [], ratio
    while r > 2.0:                       # atempo accepts 0.5..2.0 per stage
        filt.append("atempo=2.0")
        r /= 2.0
    filt.append(f"atempo={r:.4f}")
    p = run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
             "-i", str(src), "-filter:a", ",".join(filt), str(dst)], 300)
    if p.returncode != 0:
        shutil.copyfile(src, dst)
        return dur
    return wav_duration(dst)


def write_subtitles(d: Path, segs: list[dict]) -> None:
    srt, vtt = [], ["WEBVTT", ""]
    n = 0
    for s in segs:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        n += 1
        srt += [str(n), f"{fmt_ts(s['start'], ',')} --> {fmt_ts(s['end'], ',')}", text, ""]
        vtt += [f"{fmt_ts(s['start'], '.')} --> {fmt_ts(s['end'], '.')}", text, ""]
    (d / "subtitles.srt").write_text("\n".join(srt), encoding="utf-8")
    (d / "subtitles.vtt").write_text("\n".join(vtt), encoding="utf-8")


def do_render(job_id: str, params: dict) -> None:
    d = DATA_DIR / job_id
    try:
        import numpy as np
        import soundfile as sf

        meta = read_meta(d)
        segs = params["segments"]
        max_speedup = float(params.get("max_speedup", 1.5))
        orig_vol    = float(params.get("original_volume", 0.0))
        burn        = bool(params.get("burn_subtitles", False))
        rate        = 24000
        total       = meta["duration"] + 1.0
        mix = np.zeros(int(total * rate), dtype=np.float32)

        write_meta(d, state="rendering", progress=0.02, message="Mixing dubbed audio")
        (d / "fit").mkdir(exist_ok=True)
        placed = 0
        for k, s in enumerate(segs):
            i = s.get("i", k)
            clip = d / f"clip_{i}.wav"
            if not (s.get("text") or "").strip() or not clip.exists():
                continue
            next_start = segs[k + 1]["start"] if k + 1 < len(segs) else total
            slot = max(s["end"] - s["start"], 0.3)
            room = max(next_start - s["start"], slot)
            fitted = d / "fit" / f"clip_{i}.wav"
            fit_clip(clip, fitted, slot, max_speedup)
            data, sr = sf.read(str(fitted), dtype="float32", always_2d=True)
            data = data.mean(axis=1)
            if sr != rate:                       # TTS gives 24 kHz; resample defensively
                tmp = d / "fit" / f"rs_{i}.wav"
                run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(fitted),
                     "-ac", "1", "-ar", str(rate), str(tmp)], 120)
                data, _ = sf.read(str(tmp), dtype="float32")
            data = data[: int(room * rate)]     # never run into the next sentence
            a = int(s["start"] * rate)
            b = min(a + len(data), len(mix))
            mix[a:b] += data[: b - a]
            placed += 1
            write_meta(d, progress=0.02 + 0.5 * (k + 1) / max(len(segs), 1))
        if placed == 0:
            raise ValueError("No synthesized clips found - run the dubbing step first.")
        peak = float(np.abs(mix).max())
        if peak > 0.99:
            mix *= 0.99 / peak
        sf.write(str(d / "dubbed.wav"), mix, rate)

        write_subtitles(d, segs)
        for f in ("output.mp4", "output.m4a"):
            (d / f).unlink(missing_ok=True)

        src = d / meta["input_name"]
        write_meta(d, progress=0.55, message="Encoding output")
        cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
               "-i", str(src), "-i", str(d / "dubbed.wav")]
        if orig_vol > 0.001:
            cmd += ["-filter_complex",
                    f"[0:a]volume={orig_vol:.3f}[o];[o][1:a]amix=inputs=2:duration=longest:normalize=0[aout]"]
            amap = "[aout]"
        else:
            amap = "1:a"
        if meta["has_video"]:
            out = d / "output.mp4"
            cmd += ["-map", "0:v:0", "-map", amap]
            if burn:
                sub = str(d / "subtitles.srt").replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
                style = f"FontName={SUBTITLE_FONT},FontSize=18,Outline=1.5,Shadow=0.5,MarginV=24"
                cmd += ["-vf", f"subtitles='{sub}':force_style='{style}'",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
            else:
                cmd += ["-c:v", "copy"]
            cmd += ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", str(out)]
            outputs = ["output.mp4", "subtitles.srt", "subtitles.vtt", "dubbed.wav"]
        else:
            out = d / "output.m4a"
            cmd += ["-map", amap, "-c:a", "aac", "-b:a", "160k", str(out)]
            outputs = ["output.m4a", "subtitles.srt", "subtitles.vtt", "dubbed.wav"]
        p = run(cmd, 6 * 3600)
        if p.returncode != 0:
            raise ValueError(f"ffmpeg failed: {p.stderr.strip()[-400:]}")
        write_meta(d, state="done", progress=1.0, message="Done", outputs=outputs, finished=time.time())
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        write_meta(d, state="error", message=str(exc)[:400])


# -- cleanup -----------------------------------------------------------------
def cleanup_loop() -> None:
    while True:
        try:
            cutoff = time.time() - KEEP_DAYS * 86400
            for d in DATA_DIR.iterdir():
                if d.is_dir() and d.stat().st_mtime < cutoff:
                    print(f"[vt_server] removing expired job {d.name}", flush=True)
                    shutil.rmtree(d, ignore_errors=True)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(3600)


# -- HTTP --------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: N802
        print(f"[vt_server] {self.client_address[0]} {fmt % args}", flush=True)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")

    def _json(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _body_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def _save_body(self, dest: Path, limit_mb: int) -> int:
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0:
            raise ValueError("Empty body.")
        if n > limit_mb * 1024 * 1024:
            raise ValueError(f"Upload too large (limit {limit_mb} MB).")
        left = n
        with open(dest, "wb") as f:
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    raise ValueError("Connection closed during upload.")
                f.write(chunk)
                left -= len(chunk)
        return n

    def _parts(self) -> list[str]:
        return [unquote(p) for p in self.path.split("?")[0].strip("/").split("/")]

    def _fail(self, exc: Exception) -> None:
        if isinstance(exc, KeyError):
            self._json({"error": str(exc.args[0])}, 404)
        elif isinstance(exc, ValueError):
            self._json({"error": str(exc)}, 400)
        else:
            traceback.print_exc()
            self._json({"error": str(exc)}, 500)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parts = self._parts()
        try:
            if parts == ["health"]:
                return self._json({"status": "ok", "ffmpeg": ffmpeg_version(), "keep_days": KEEP_DAYS})
            if len(parts) == 2 and parts[0] == "jobs":
                meta = read_meta(job_dir(parts[1]))
                meta.pop("segments", None)
                return self._json(meta)
            if len(parts) == 4 and parts[0] == "jobs" and parts[2] == "segments":
                d = job_dir(parts[1])
                m = re.fullmatch(r"(\d+)\.wav", parts[3])
                if not m or not (d / f"seg_{m.group(1)}.wav").exists():
                    raise KeyError("segment not found")
                return self._file(d / f"seg_{m.group(1)}.wav", "audio/wav")
            if len(parts) == 4 and parts[0] == "jobs" and parts[2] == "download":
                d = job_dir(parts[1])
                name = parts[3]
                if name not in DOWNLOADS or not (d / name).exists():
                    raise KeyError("file not found")
                return self._file(d / name, DOWNLOADS[name], download_as=name)
            self._json({"error": "Not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)

    def _file(self, path: Path, ctype: str, download_as: str | None = None) -> None:
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip()) if rng else None
        if m:
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            elif m.group(2):
                start = max(size - int(m.group(2)), 0)
            end = min(end, size - 1)
            if start <= end:
                status = 206
            else:
                start, end = 0, size - 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download_as:
            self.send_header("Content-Disposition", f'inline; filename="{download_as}"')
        self._cors()
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self) -> None:  # noqa: N802
        parts = self._parts()
        try:
            if parts == ["jobs"]:
                name = Path(unquote(self.headers.get("X-Filename", "input"))).name or "input"
                suffix = Path(name).suffix.lower()
                if not re.fullmatch(r"\.[a-z0-9]{1,6}", suffix or ""):
                    suffix = ".bin"
                job_id = uuid.uuid4().hex[:12]
                d = DATA_DIR / job_id
                d.mkdir(parents=True)
                try:
                    input_name = "input" + suffix
                    self._save_body(d / input_name, MAX_UPLOAD_MB)
                    info = probe(d / input_name)
                    p = run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                             "-i", str(d / input_name), "-vn", "-ac", "1", "-ar", "16000",
                             str(d / "audio.wav")], 3600)
                    if p.returncode != 0:
                        raise ValueError(f"Could not extract audio: {p.stderr.strip()[:300]}")
                except Exception:
                    shutil.rmtree(d, ignore_errors=True)
                    raise
                write_meta(d, job_id=job_id, filename=name, input_name=input_name, state="uploaded",
                           created=time.time(), **info)
                return self._json({"job_id": job_id, "filename": name, **info})

            if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "segment":
                d = job_dir(parts[1])
                params = self._body_json()
                with job_lock(parts[1]):
                    segs = do_segment(d, params)
                return self._json({"segments": segs})

            if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "render":
                d = job_dir(parts[1])
                params = self._body_json()
                if not params.get("segments"):
                    raise ValueError("No segments to render.")
                if read_meta(d).get("state") == "rendering":
                    raise ValueError("A render is already running for this job.")
                write_meta(d, state="rendering", progress=0.0, message="Starting")
                threading.Thread(target=do_render, args=(parts[1], params), daemon=True).start()
                return self._json({"status": "started"})

            self._json({"error": "Not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)

    def do_PUT(self) -> None:  # noqa: N802
        parts = self._parts()
        try:
            if len(parts) == 4 and parts[0] == "jobs" and parts[2] == "clips" and parts[3].isdigit():
                d = job_dir(parts[1])
                self._save_body(d / f"clip_{parts[3]}.wav", 200)
                return self._json({"status": "ok"})
            self._json({"error": "Not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)

    def do_DELETE(self) -> None:  # noqa: N802
        parts = self._parts()
        try:
            if len(parts) == 2 and parts[0] == "jobs":
                shutil.rmtree(job_dir(parts[1]), ignore_errors=True)
                return self._json({"status": "ok"})
            self._json({"error": "Not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = 32


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=cleanup_loop, daemon=True).start()
    print(f"[vt_server] listening on {HOST}:{PORT}, data in {DATA_DIR}", flush=True)
    try:
        Server((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
