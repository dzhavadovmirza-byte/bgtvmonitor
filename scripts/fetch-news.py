#!/usr/bin/env python3
"""Fetch gold/silver headlines from Yahoo Finance RSS into web/news.json.

Lives in the bgtvmonitor repo; runs from cron on the VPS as
  */10 * * * * /opt/bgtvmonitor/scripts/fetch-news.py

Runs from cron. The browser can't read Yahoo's feed directly (no CORS header),
so the server fetches it and publishes a same-origin JSON file the dashboard
can poll. Stdlib only -- nothing to pip install on the box.

Failure policy: never clobber a good file with a bad one. If the fetch or the
parse fails we exit non-zero and leave the previous news.json in place, so the
ticker keeps showing the last known headlines instead of going blank.
"""
import html
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

FEED = ("https://feeds.finance.yahoo.com/rss/2.0/headline"
        "?s=GC=F,SI=F,GLD,SLV&region=US&lang=en-US")
# Written next to the static site this repo ships (web/news.json). Override
# with NEWS_OUT if the checkout ever lives somewhere unusual.
OUT = os.environ.get("NEWS_OUT") or os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "news.json"))
MAX_ITEMS = 20
UA = "Mozilla/5.0 (compatible; BudgetGoldMonitor/1.0)"


def clean(text):
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", "", text)          # stray markup in CDATA
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)  # control chars
    return re.sub(r"\s+", " ", text).strip()


def main():
    req = urllib.request.Request(FEED, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()

    root = ET.fromstring(raw)
    items, seen = [], set()
    for node in root.iter("item"):
        title = clean((node.findtext("title") or ""))
        if not title or title.lower() in seen:
            continue
        seen.add(title.lower())

        ts = None
        pub = node.findtext("pubDate")
        if pub:
            try:
                ts = int(parsedate_to_datetime(pub).timestamp() * 1000)
            except Exception:
                ts = None
        items.append({"title": title, "ts": ts,
                      "source": clean(node.findtext("source") or "Yahoo Finance")})

    if not items:
        raise SystemExit("feed returned no usable items")

    items.sort(key=lambda i: i["ts"] or 0, reverse=True)
    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": items[:MAX_ITEMS],
    }

    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)          # atomic: readers never see a half-written file
    os.chmod(OUT, 0o644)
    print(f"ok: {len(payload['items'])} headlines -> {OUT}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED, keeping previous news.json: {e}", file=sys.stderr)
        sys.exit(1)
