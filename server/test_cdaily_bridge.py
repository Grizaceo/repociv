import sqlite3
import pytest


@pytest.fixture
def fake_db(tmp_path, monkeypatch):
    db = tmp_path / "blogwatcher-cli.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE blogs (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute(
        "CREATE TABLE articles ("
        " id INTEGER PRIMARY KEY, title TEXT, url TEXT, published_date TEXT,"
        " is_read INTEGER DEFAULT 0, blog_id INTEGER)"
    )
    conn.execute("INSERT INTO blogs VALUES (1, 'Test Blog')")
    conn.execute(
        "INSERT INTO articles VALUES (1, 'Noticia de prueba', 'https://example.com', '2026-05-23', 0, 1)"
    )
    conn.commit()
    conn.close()
    monkeypatch.setenv("CDAILY_DB_PATH", str(db))
    yield db


def test_get_latest_news_returns_unread(fake_db):
    from server.http_routes import get_latest_news
    status, data = get_latest_news({})
    assert status == 200
    assert len(data) == 1
    assert data[0]["title"] == "Noticia de prueba"
    assert data[0]["blogName"] == "Test Blog"


def test_post_news_read_marks_article(fake_db):
    from server.http_routes import post_news_read
    status, data = post_news_read({"id": 1}, {})
    assert status == 200
    assert data["success"] is True

    # Double check database state
    conn = sqlite3.connect(str(fake_db))
    cur = conn.cursor()
    cur.execute("SELECT is_read FROM articles WHERE id = 1")
    assert cur.fetchone()[0] == 1
    conn.close()


def test_get_latest_news_empty_when_db_missing(monkeypatch):
    monkeypatch.setenv("CDAILY_DB_PATH", "/nonexistent/path.db")
    from server.http_routes import get_latest_news
    status, data = get_latest_news({})
    assert status == 200
    assert data == []
