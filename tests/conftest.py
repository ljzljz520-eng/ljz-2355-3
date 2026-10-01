import os
import tempfile

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg2://postgres@/designguide_test?host=/tmp&port=55432")
os.environ["SCREENSHOT_DIR"] = tempfile.mkdtemp(prefix="dg-shots-")

import psycopg2  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import seed as seed_module  # noqa: E402
from backend.db import engine  # noqa: E402
from backend import main as main_module  # noqa: E402
from backend.tokens import _SharedCache, TokenEngine  # noqa: E402


def _ensure_test_db():
    conn = psycopg2.connect(host="/tmp", port=55432, user="postgres",
                            dbname="postgres")
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM pg_database WHERE datname='designguide_test'")
    if not cur.fetchone():
        cur.execute('CREATE DATABASE designguide_test')
    conn.close()


@pytest.fixture(scope="session", autouse=True)
def _prepared():
    _ensure_test_db()
    yield


@pytest.fixture(autouse=True)
def _clean_db():
    seed_module.seed(recreate=True)
    yield


@pytest.fixture()
def client():
    # isolated shared cache per test
    main_module._token_cache = _SharedCache()
    # every TokenEngine built inside the app uses the test-scoped shared cache
    import backend.tokens as tk
    orig_init = tk.TokenEngine.__init__
    def patched_init(self, db, cache=None):
        orig_init(self, db, cache=main_module._token_cache)
    tk.TokenEngine.__init__ = patched_init
    with TestClient(main_module.app) as c:
        yield c
    tk.TokenEngine.__init__ = orig_init
    engine.dispose()


def findings_by_rule(report):
    by = {}
    for f in report["findings"]:
        by.setdefault(f["rule"], []).append(f)
    return by
