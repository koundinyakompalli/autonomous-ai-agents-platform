import base64
import ipaddress
import math
import os
import socket
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from markitdown import MarkItDown

app = FastAPI(title="compose-markitdown")
_md = MarkItDown()

MAX_BYTES = int(os.environ.get("MARKITDOWN_MAX_BYTES", str(50 * 1024 * 1024)))
URL_MAX_BYTES = int(
    os.environ.get("MARKITDOWN_URL_MAX_BYTES", str(10 * 1024 * 1024))
)
URL_FETCH_TIMEOUT_SECONDS = float(
    os.environ.get("MARKITDOWN_URL_FETCH_TIMEOUT_SECONDS", "15")
)
URL_MAX_REDIRECTS = int(os.environ.get("MARKITDOWN_URL_MAX_REDIRECTS", "5"))
URL_USER_AGENT = "specter-compose-url-ingestion/1.0"
YOUTUBE_HOST_SUFFIXES = ("youtube.com", "youtu.be", "youtube-nocookie.com")
_URL_FETCH_TRANSPORT: httpx.AsyncBaseTransport | None = None


# Segment audio is emitted as 16 kHz mono MP3, not WAV. A 300 s WAV segment is
# ~12.8 MB base64 and the Voxtral endpoint rejected it ("Failed to buffer the
# request body: length limit exceeded"). 300 s MP3 @ 64 kbps is ~3.2 MB base64 —
# well under the endpoint's body limit — while keeping the same duration (so the
# Voxtral ~32k token window still bounds it). 16 kHz mono speech is unaffected by
# 64 kbps. Voxtral's format enum accepts only "wav" and "mp3".
SEGMENT_SECONDS = int(os.environ.get("COMPOSE_AUDIO_SEGMENT_SECONDS", "300"))
SEGMENT_AUDIO_BITRATE = os.environ.get("COMPOSE_AUDIO_MP3_BITRATE", "64k")
SEGMENT_AUDIO_FORMAT = "mp3"
MEDIA_MAX_SECONDS = int(os.environ.get("COMPOSE_AUDIO_MAX_SECONDS", "3600"))
MEDIA_MAX_BYTES = int(
    os.environ.get("COMPOSE_AUDIO_MAX_BYTES", str(500 * 1024 * 1024))
)


def _configured_host_suffixes() -> list[str]:
    raw = os.environ.get(
        "MARKITDOWN_ALLOWED_URL_HOST_SUFFIXES",
        os.environ.get("COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES", ""),
    )
    return [part.strip().lower().strip(".") for part in raw.split(",") if part.strip()]


def _host_matches(hostname: str, suffix: str) -> bool:
    return hostname == suffix or hostname.endswith(f".{suffix}")


def _is_youtube_url(url: str) -> bool:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower().strip(".")
    return any(_host_matches(hostname, suffix) for suffix in YOUTUBE_HOST_SUFFIXES)


def _validate_public_https_url(
    raw_url: str,
    *,
    allowed_suffixes: Optional[list[str]] = None,
) -> str:
    url = raw_url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")

    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise HTTPException(status_code=400, detail="URL must use https")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="URL must not include credentials")
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="URL host is required")

    hostname = parsed.hostname.lower().strip(".")
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise HTTPException(status_code=400, detail="URL host must be public")

    explicit_allowed_suffixes = allowed_suffixes is not None
    allowed_suffixes = (
        _configured_host_suffixes() if allowed_suffixes is None else allowed_suffixes
    )
    if (explicit_allowed_suffixes or allowed_suffixes) and not any(
        _host_matches(hostname, suffix) for suffix in allowed_suffixes
    ):
        raise HTTPException(status_code=400, detail="URL host is not allowed")

    try:
        addresses = socket.getaddrinfo(
            hostname,
            parsed.port or 443,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise HTTPException(
            status_code=400,
            detail="URL host could not be resolved",
        ) from exc

    if not addresses:
        raise HTTPException(status_code=400, detail="URL host could not be resolved")

    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise HTTPException(
                status_code=400,
                detail="URL host must resolve to public addresses",
            )

    return url


def _content_suffix(url: str, content_type: str | None) -> str:
    parsed = urlparse(url)
    name = parsed.path.rsplit("/", 1)[-1]
    if "." in name:
        suffix = "." + name.rsplit(".", 1)[1][:16]
        if suffix.strip("."):
            return suffix

    content_type = (content_type or "").split(";", 1)[0].strip().lower()
    if content_type in {"text/html", "application/xhtml+xml"}:
        return ".html"
    if content_type in {"text/plain", "text/csv"}:
        return ".txt"
    if content_type in {"text/markdown", "text/x-markdown"}:
        return ".md"
    if content_type == "application/pdf":
        return ".pdf"
    return ".html"


@dataclass
class DownloadedUrl:
    data: bytes
    filename: str


async def _fetch_public_https_url(raw_url: str) -> DownloadedUrl:
    current_url = _validate_public_https_url(raw_url)
    redirects = 0
    timeout = httpx.Timeout(URL_FETCH_TIMEOUT_SECONDS)
    headers = {"User-Agent": URL_USER_AGENT}

    try:
        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=timeout,
            transport=_URL_FETCH_TRANSPORT,
        ) as client:
            while True:
                current_url = _validate_public_https_url(current_url)
                async with client.stream(
                    "GET",
                    current_url,
                    headers=headers,
                ) as response:
                    if 300 <= response.status_code < 400:
                        location = response.headers.get("location")
                        if not location:
                            raise HTTPException(
                                status_code=400,
                                detail="URL redirect is missing a Location header",
                            )
                        if redirects >= URL_MAX_REDIRECTS:
                            raise HTTPException(
                                status_code=400,
                                detail="URL redirected too many times",
                            )
                        current_url = _validate_public_https_url(
                            urljoin(current_url, location)
                        )
                        redirects += 1
                        continue

                    if response.status_code >= 400:
                        raise HTTPException(
                            status_code=422,
                            detail=f"URL fetch failed with HTTP {response.status_code}",
                        )

                    content_length = response.headers.get("content-length")
                    if content_length:
                        try:
                            if int(content_length) > URL_MAX_BYTES:
                                raise HTTPException(
                                    status_code=413,
                                    detail="URL response is too large",
                                )
                        except ValueError:
                            pass

                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > URL_MAX_BYTES:
                            raise HTTPException(
                                status_code=413,
                                detail="URL response is too large",
                            )

                    suffix = _content_suffix(
                        current_url,
                        response.headers.get("content-type"),
                    )
                    return DownloadedUrl(
                        data=bytes(data),
                        filename=f"url-source{suffix}",
                    )
    except HTTPException:
        raise
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=408, detail="URL fetch timed out") from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=422, detail=f"URL fetch failed: {exc}") from exc


def _convert_bytes(data: bytes, filename: str) -> str:
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large")

    suffix = ""
    if "." in filename:
        suffix = "." + filename.rsplit(".", 1)[1]

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        result = _md.convert(tmp.name)
    return result.text_content or ""


def _ffprobe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, timeout=120,
    )
    text = (out.stdout or "").strip()
    try:
        return float(text)
    except ValueError:
        return 0.0


def extract_audio_segments(media_bytes: bytes, suffix: str) -> dict:
    """ffmpeg: probe duration, then extract/transcode the audio track to 16 kHz mono
    MP3 split into <=SEGMENT_SECONDS chunks. Returns {'segments': [b64-mp3,...],
    'durationSec': float}. MP3 (not WAV) keeps each segment small enough for the
    Voxtral request-body limit. Raises on ffmpeg failure. Empty segments => no
    audio track."""
    with tempfile.TemporaryDirectory() as work:
        in_path = os.path.join(work, f"input{suffix or ''}")
        with open(in_path, "wb") as fh:
            fh.write(media_bytes)

        duration = _ffprobe_duration(in_path)
        seg_pattern = os.path.join(work, "seg_%05d.mp3")
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", in_path, "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "libmp3lame", "-b:a", SEGMENT_AUDIO_BITRATE,
             "-f", "segment", "-segment_time", str(SEGMENT_SECONDS),
             seg_pattern],
            capture_output=True, text=True, timeout=1800,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or "ffmpeg failed")

        segments = []
        for name in sorted(os.listdir(work)):
            if name.startswith("seg_") and name.endswith(".mp3"):
                with open(os.path.join(work, name), "rb") as fh:
                    segments.append(base64.b64encode(fh.read()).decode("ascii"))
        return {"segments": segments, "durationSec": duration}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/convert")
async def convert(
    file: Optional[UploadFile] = File(default=None),
    url: Optional[str] = Form(default=None),
    filename: Optional[str] = Form(default=None),
):
    if file is None and not url:
        raise HTTPException(status_code=400, detail="Provide a file or a url")

    try:
        if url:
            raw_url = url.strip()
            if _is_youtube_url(raw_url):
                safe_url = _validate_public_https_url(
                    raw_url,
                    allowed_suffixes=list(YOUTUBE_HOST_SUFFIXES),
                )
                result = _md.convert(safe_url)
                return {"markdown": result.text_content or ""}

            safe_url = _validate_public_https_url(raw_url)
            downloaded = await _fetch_public_https_url(safe_url)
            return {"markdown": _convert_bytes(downloaded.data, downloaded.filename)}

        data = await file.read()
        return {"markdown": _convert_bytes(data, filename or file.filename or "")}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface conversion failures as 422
        raise HTTPException(status_code=422, detail=f"Conversion failed: {exc}") from exc


@app.post("/extract-audio")
async def extract_audio(file: Optional[UploadFile] = File(default=None)):
    if file is None:
        raise HTTPException(status_code=400, detail="Provide a media file")

    data = await file.read()
    if len(data) > MEDIA_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Media file too large")

    name = file.filename or ""
    suffix = "." + name.rsplit(".", 1)[1] if "." in name else ""

    try:
        result = extract_audio_segments(data, suffix)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface ffmpeg failures as 422
        raise HTTPException(status_code=422, detail=f"Audio extraction failed: {exc}") from exc

    if result["durationSec"] > MEDIA_MAX_SECONDS:
        raise HTTPException(
            status_code=413,
            detail=f"Media too long ({result['durationSec']:.0f}s; max {MEDIA_MAX_SECONDS}s)",
        )
    if not result["segments"]:
        raise HTTPException(status_code=415, detail="No audio track found in the file")

    return {
        "segments": result["segments"],
        "durationSec": result["durationSec"],
        "segmentSeconds": SEGMENT_SECONDS,
        "format": SEGMENT_AUDIO_FORMAT,
    }
