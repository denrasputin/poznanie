"""Подставная сеть для тестов: адрес -> содержимое фикстуры, без реальных запросов."""
from pathlib import Path

FIX = Path(__file__).parent / "fixtures"


class FakeResp:
    def __init__(self, url, status=200, body=b"", headers=None):
        self.url, self.status_code, self._body = url, status, body
        self.headers = headers or {}

    @property
    def text(self):
        return self._body.decode("utf-8")

    def iter_content(self, n):
        for i in range(0, len(self._body), n):
            yield self._body[i:i + n]


class FakeSession:
    def __init__(self, routes: dict):
        self.routes = routes          # url -> bytes | (status, bytes, headers)
        self.headers = {}
        self.calls = []

    def get(self, url, headers=None, timeout=None, stream=False):
        self.calls.append((url, dict(headers or {})))
        r = self.routes.get(url)
        if r is None:
            return FakeResp(url, 404, b"not found")
        if isinstance(r, tuple):
            status, body, hdrs = r
            if headers and hdrs.get("ETag") and headers.get("If-None-Match") == hdrs["ETag"]:
                return FakeResp(url, 304, b"", hdrs)
            return FakeResp(url, status, body, hdrs)
        return FakeResp(url, 200, r)


def fx(name: str) -> bytes:
    return (FIX / name).read_bytes()
