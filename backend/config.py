"""Runtime configuration.

The app talks to PostgreSQL (design versions + component dependencies are
durable). A local embedded PostgreSQL is provided via scripts/dev_pg.sh.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DEFAULT_DSN = "postgresql+psycopg2://postgres@/designguide?host=/tmp&port=55432"
DATABASE_URL = os.environ.get("DATABASE_URL", DEFAULT_DSN)

SCREENSHOT_DIR = Path(os.environ.get("SCREENSHOT_DIR", BASE_DIR / "data" / "screenshots"))
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

# WCAG thresholds
RATIO_AA_NORMAL = 4.5
RATIO_AA_LARGE = 3.0
RATIO_AA_UI = 3.0

# Resolution cache time-to-live (seconds). Version-signature mismatch always
# invalidates as well; TTL is a belt-and-braces ceiling.
RESOLVE_CACHE_TTL_SECONDS = 300
