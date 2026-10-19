import pytest


@pytest.fixture(autouse=True)
def no_retry_pauses(monkeypatch):
    """Повторы запросов в тестах — без пауз."""
    monkeypatch.setattr("collector.fetch.BACKOFF", (0, 0))
    monkeypatch.setattr("collector.fetch.time.sleep", lambda s: None)
