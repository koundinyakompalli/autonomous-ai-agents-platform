import httpx
import pytest
from fastapi.testclient import TestClient

import app as app_module
from app import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_convert_plaintext_returns_markdown():
    files = {"file": ("notes.txt", b"Hello world", "text/plain")}
    res = client.post("/convert", files=files)
    assert res.status_code == 200
    body = res.json()
    assert "markdown" in body
    assert "Hello world" in body["markdown"]


def test_convert_missing_input_is_400():
    res = client.post("/convert")
    assert res.status_code == 400


class _FakeMarkitdownResult:
    text_content = "# Converted URL"


def _public_dns(monkeypatch, private_hosts=None):
    private_hosts = private_hosts or set()

    def fake_getaddrinfo(host, port, *_args, **_kwargs):
        ip = "10.0.0.2" if host in private_hosts else "93.184.216.34"
        return [
            (
                app_module.socket.AF_INET,
                app_module.socket.SOCK_STREAM,
                6,
                "",
                (ip, port),
            )
        ]

    monkeypatch.setattr(app_module.socket, "getaddrinfo", fake_getaddrinfo)


def test_convert_url_fetches_non_youtube_with_guarded_downloader(monkeypatch):
    converted = []

    class FakeMarkitdown:
        def convert(self, path):
            converted.append(path)
            with open(path, "rb") as fh:
                assert fh.read() == b"<h1>Hello</h1>"
            return _FakeMarkitdownResult()

    monkeypatch.setattr(app_module, "_md", FakeMarkitdown())
    _public_dns(monkeypatch)
    monkeypatch.setattr(
        app_module,
        "_URL_FETCH_TRANSPORT",
        httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                headers={"content-type": "text/html"},
                content=b"<h1>Hello</h1>",
            )
        ),
    )

    res = client.post("/convert", data={"url": " https://example.com/page "})

    assert res.status_code == 200
    assert res.json()["markdown"] == "# Converted URL"
    assert converted
    assert not converted[0].startswith("https://")


def test_convert_url_preserves_youtube_specific_conversion(monkeypatch):
    converted = []

    class FakeMarkitdown:
        def convert(self, url):
            converted.append(url)
            return _FakeMarkitdownResult()

    monkeypatch.setattr(app_module, "_md", FakeMarkitdown())
    monkeypatch.setenv("COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES", "atlassian.net")
    _public_dns(monkeypatch)

    res = client.post("/convert", data={"url": "https://youtu.be/abc"})

    assert res.status_code == 200
    assert converted == ["https://youtu.be/abc"]


def test_empty_allowed_suffixes_do_not_bypass_the_host_allowlist(monkeypatch):
    monkeypatch.setenv("MARKITDOWN_ALLOWED_URL_HOST_SUFFIXES", "wiki.example.com")
    _public_dns(monkeypatch)

    with pytest.raises(app_module.HTTPException) as exc_info:
        app_module._validate_public_https_url(
            "https://example.com/page",
            allowed_suffixes=[],
        )

    assert exc_info.value.status_code == 400
    assert "not allowed" in exc_info.value.detail


def test_convert_url_rejects_non_https():
    res = client.post("/convert", data={"url": "http://example.com/page"})

    assert res.status_code == 400
    assert "https" in res.json()["detail"]


def test_convert_url_rejects_private_dns(monkeypatch):
    _public_dns(monkeypatch, private_hosts={"wiki.example.com"})

    res = client.post("/convert", data={"url": "https://wiki.example.com/page"})

    assert res.status_code == 400
    assert "public" in res.json()["detail"]


def test_convert_url_rejects_redirects_to_private_dns(monkeypatch):
    _public_dns(monkeypatch, private_hosts={"metadata.local"})
    monkeypatch.setattr(
        app_module,
        "_URL_FETCH_TRANSPORT",
        httpx.MockTransport(
            lambda _request: httpx.Response(
                302,
                headers={"location": "https://metadata.local/latest"},
            )
        ),
    )

    res = client.post("/convert", data={"url": "https://wiki.example.com/page"})

    assert res.status_code == 400
    assert "public" in res.json()["detail"]


def test_convert_url_rejects_redirect_loops(monkeypatch):
    _public_dns(monkeypatch)
    monkeypatch.setattr(app_module, "URL_MAX_REDIRECTS", 1)
    monkeypatch.setattr(
        app_module,
        "_URL_FETCH_TRANSPORT",
        httpx.MockTransport(
            lambda _request: httpx.Response(
                302,
                headers={"location": "/again"},
            )
        ),
    )

    res = client.post("/convert", data={"url": "https://wiki.example.com/page"})

    assert res.status_code == 400
    assert "too many" in res.json()["detail"]


def test_convert_url_rejects_oversized_responses(monkeypatch):
    _public_dns(monkeypatch)
    monkeypatch.setattr(app_module, "URL_MAX_BYTES", 8)
    monkeypatch.setattr(
        app_module,
        "_URL_FETCH_TRANSPORT",
        httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                headers={"content-length": "9"},
                content=b"",
            )
        ),
    )

    res = client.post("/convert", data={"url": "https://wiki.example.com/page"})

    assert res.status_code == 413
    assert "too large" in res.json()["detail"]


def test_convert_url_times_out(monkeypatch):
    _public_dns(monkeypatch)

    def raise_timeout(_request):
        raise httpx.TimeoutException("slow")

    monkeypatch.setattr(
        app_module,
        "_URL_FETCH_TRANSPORT",
        httpx.MockTransport(raise_timeout),
    )

    res = client.post("/convert", data={"url": "https://wiki.example.com/page"})

    assert res.status_code == 408
    assert "timed out" in res.json()["detail"]


def _fake_runner(segments_b64, duration_sec):
    """Return a runner that bypasses real ffmpeg and yields canned output."""
    def run(_media_bytes, _suffix):
        return {"segments": segments_b64, "durationSec": duration_sec}
    return run


def test_extract_audio_returns_segments(monkeypatch):
    monkeypatch.setattr(
        app_module, "extract_audio_segments", _fake_runner(["d2F2MQ==", "d2F2Mg=="], 1200.0)
    )
    files = {"file": ("talk.mp4", b"\x00\x00fakevideo", "video/mp4")}
    res = client.post("/extract-audio", files=files)
    assert res.status_code == 200
    body = res.json()
    assert body["segments"] == ["d2F2MQ==", "d2F2Mg=="]
    assert body["durationSec"] == 1200.0
    assert body["segmentSeconds"] == app_module.SEGMENT_SECONDS
    assert body["format"] == "mp3"


def test_extract_audio_no_track_is_415(monkeypatch):
    def run(_b, _s):
        return {"segments": [], "durationSec": 0.0}
    monkeypatch.setattr(app_module, "extract_audio_segments", run)
    files = {"file": ("silent.mp4", b"\x00\x00novoice", "video/mp4")}
    res = client.post("/extract-audio", files=files)
    assert res.status_code == 415


def test_extract_audio_too_long_is_413(monkeypatch):
    def run(_b, _s):
        return {"segments": ["x"], "durationSec": app_module.MEDIA_MAX_SECONDS + 1}
    monkeypatch.setattr(app_module, "extract_audio_segments", run)
    files = {"file": ("long.mp3", b"audio", "audio/mpeg")}
    res = client.post("/extract-audio", files=files)
    assert res.status_code == 413


def test_extract_audio_ffmpeg_error_is_422(monkeypatch):
    def run(_b, _s):
        raise RuntimeError("ffmpeg exploded")
    monkeypatch.setattr(app_module, "extract_audio_segments", run)
    files = {"file": ("bad.wav", b"audio", "audio/wav")}
    res = client.post("/extract-audio", files=files)
    assert res.status_code == 422


def test_segment_mp3_fits_voxtral_request_body_and_token_limits():
    """A full MP3 segment must fit BOTH the Voxtral request-body byte limit (a
    300s WAV segment was ~12.8MB base64 and got rejected with 'Failed to buffer
    the request body') AND Voxtral's ~32k token context window. MP3 keeps the
    bytes ~4x smaller while duration (and thus token cost) is unchanged."""
    seconds = app_module.SEGMENT_SECONDS
    # Parse the configured bitrate, e.g. "64k" -> 64000 bits/sec.
    bitrate = app_module.SEGMENT_AUDIO_BITRATE.strip().lower()
    bits_per_sec = int(bitrate[:-1]) * 1000 if bitrate.endswith("k") else int(bitrate)
    mp3_bytes = (bits_per_sec // 8) * seconds
    base64_bytes = ((mp3_bytes + 2) // 3) * 4
    audio_tokens = seconds * 44  # Voxtral bills audio at ~44 tokens/sec
    reserved_output_tokens = 8_192

    # 8MB is the Node client's default COMPOSE_VOXTRAL_MAX_REQUEST_BYTES guard.
    assert base64_bytes < 8_000_000, (
        f"SEGMENT_SECONDS={seconds} @ {bitrate} -> {base64_bytes} base64 bytes "
        "exceeds the Voxtral request-body budget"
    )
    assert audio_tokens + reserved_output_tokens < 32_000, (
        f"SEGMENT_SECONDS={seconds} -> ~{audio_tokens} audio tokens + reserved "
        "output exceeds Voxtral's ~32k context window"
    )


def test_extract_audio_missing_file_is_400():
    res = client.post("/extract-audio")
    assert res.status_code == 400
