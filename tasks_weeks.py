#!/usr/bin/env python3
"""Fetch all AI Trainer task results and group them by week.

Weeks are 7 days long, starting on the weekday of --week0 (Monday..Sunday by default),
in the --tz time zone.

Setup:
  export LI_COOKIE='<the -b cookie string from your cURL>'
  export LI_PROJECT_ID=<your projectId>      # or pass --project every time
  python3 tasks_weeks.py --dump              # shows the response shape + which date field was detected
  python3 tasks_weeks.py                     # weekly summary
  python3 tasks_weeks.py --csv tasks.csv     # also write every task + its week to CSV

Options (a flag wins over its environment variable):
  --project ID             projectId (env LI_PROJECT_ID; required)
  --tz ZONE                IANA time zone, e.g. Europe/Madrid (env LI_TZ; default UTC)
  --week0 YYYY-MM-DD       first day of week 0; earlier weeks are tagged "(before start date)"
                           (env LI_WEEK0; default: none, Monday-Sunday weeks)
  --date-field NAME        force the timestamp field (epoch ms) instead of auto-detecting
  --count N                first page size to try (default 50; halves automatically if the server rejects it)
"""

import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

BASE = "https://www.linkedin.com/ai-trainer/api/frontendAnnotationTaskResults"
EXPIRED_CODES = (301, 302, 303, 307, 308, 401, 403)  # 3xx = bounced to the login page


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """An expired cookie makes LinkedIn redirect to a login page; surface it instead of looping."""

    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)
MONDAY = date(2001, 1, 1)  # any Monday: anchors Mon-Sun weeks when no --week0 is given
DATE_CANDIDATES = [
    "submittedAt",
    "completedAt",
    "finishedAt",
    "endedAt",
    "createdAt",
    "startedAt",
    "lastModifiedAt",
]


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def settings(need_project=True):
    """Read --project/--tz/--week0, falling back to LI_PROJECT_ID/LI_TZ/LI_WEEK0."""
    project = arg("--project", os.environ.get("LI_PROJECT_ID"))
    if not project and need_project:
        sys.exit("Set LI_PROJECT_ID or pass --project ID (see header).")
    tz_name = arg("--tz", os.environ.get("LI_TZ") or "UTC")
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        sys.exit(f"Unknown time zone {tz_name!r}; use an IANA name like Europe/Madrid.")
    week0 = arg("--week0", os.environ.get("LI_WEEK0"))
    try:
        week0 = date.fromisoformat(week0) if week0 else None
    except ValueError:
        sys.exit(f"--week0 must be YYYY-MM-DD, got {week0!r}.")
    return project, tz, week0


def get(url):
    cookie = os.environ.get("LI_COOKIE") or sys.exit(
        "Set LI_COOKIE first (see header)."
    )
    m = re.search(r'JSESSIONID="?([^";]+)', cookie) or sys.exit(
        "JSESSIONID not found in LI_COOKIE."
    )
    req = urllib.request.Request(
        url,
        headers={
            "accept": "application/json",
            "cookie": cookie,
            "csrf-token": m.group(1),
            "x-restli-protocol-version": "2.0.0",
            "referer": "https://www.linkedin.com/ai-trainer/tasks",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        },
    )
    with OPENER.open(req, timeout=60) as r:
        return json.load(r)


def page(project, start, count):
    return get(f"{BASE}?q=annotator&start={start}&count={count}&projectId={project}")


def fetch_all(project, count):
    """Request --count tasks per page; if rejected, halve the page size. Keep paging until an empty page."""
    items, seen, start = [], set(), 0
    while True:
        try:
            data = page(project, start, count)
        except urllib.error.HTTPError as e:
            if e.code in EXPIRED_CODES:
                sys.exit(
                    f"HTTP {e.code}: session expired. Re-copy the cookie from your browser."
                )
            if e.code in (400, 413, 422, 500) and count > 10:
                count = max(10, count // 2)
                print(
                    f"  server rejected page size, retrying with count={count}",
                    file=sys.stderr,
                )
                continue
            raise
        els = data.get("elements", [])
        new = [e for e in els if json.dumps(e, sort_keys=True) not in seen]
        for e in new:
            seen.add(json.dumps(e, sort_keys=True))
        items += new
        total = data.get("paging", {}).get("total")
        print(f"  start={start} got={len(els)} total={total}", file=sys.stderr)
        # the server may cap count below what we asked, so advance by what we actually got
        if not els or not new or (total is not None and len(items) >= total):
            return items
        start += len(els)


def detect_field(items, forced):
    if forced:
        return forced
    for f in DATE_CANDIDATES:
        if sum(isinstance(i.get(f), (int, float)) for i in items) > len(items) * 0.5:
            return f
    sys.exit("Could not detect a date field. Run --dump and pass --date-field NAME.")


def week_of(ms, tz, week0):
    d = datetime.fromtimestamp(ms / 1000, tz)
    n = (
        d.date() - week0
    ).days // 7  # floor division also handles dates before the start
    s = week0 + timedelta(days=7 * n)
    return n, s, s + timedelta(days=6)


def main():
    project, tz, start_date = settings()
    week0 = start_date or MONDAY
    items = fetch_all(project, int(arg("--count", 50)))
    print(f"fetched {len(items)} tasks", file=sys.stderr)
    if "--dump" in sys.argv:
        slim = lambda t: {
            k: ("<%s>" % type(v).__name__ if isinstance(v, (dict, list)) else v)
            for k, v in t.items()
        }
        print("task-level fields (nested objects collapsed):")
        print(json.dumps([slim(t) for t in items[:3]], indent=2))
        print(
            "nested keys of first task:",
            {
                k: list(v)[:15] if isinstance(v, dict) else "list"
                for k, v in items[0].items()
                if isinstance(v, (dict, list))
            },
        )
        print(
            "detected date field:",
            detect_field(items, arg("--date-field")) if items else None,
        )
        return
    if not items:
        return print("no tasks returned")
    done = [i for i in items if i.get("state") != "CANCELED"]
    canceled = [i for i in items if i.get("state") == "CANCELED"]
    field = detect_field(done or items, arg("--date-field"))
    # canceled tasks usually have no end date, so fall back to when they were last touched
    cancel_fields = [field, "lastModifiedAt", "claimedAt", "createdAt"]
    cancel_ms = lambda t: next(
        (t[f] for f in cancel_fields if isinstance(t.get(f), (int, float))), None
    )

    weeks = defaultdict(lambda: {"rows": [], "canceled": []})
    skipped = 0
    for bucket, group, get_ms in (
        ("rows", done, lambda t: t.get(field)),
        ("canceled", canceled, cancel_ms),
    ):
        for it in group:
            ms = get_ms(it)
            if not isinstance(ms, (int, float)):
                skipped += 1
                continue
            weeks[week_of(ms, tz, week0)][bucket].append(it)

    span = f"{week0:%a}-{week0 + timedelta(days=6):%a}"
    since = f", weeks from {start_date}" if start_date else ""
    print(f"\nGrouped by '{field}' ({span}, {tz.key}){since}")
    print(
        "canceled tasks are counted by their last-modified date and excluded from tasks/hours"
    )
    print(f"{'week':<26}{'tasks':>7}{'canceled':>10}{'hours':>8}")
    tot_t = tot_c = 0
    for n, s, e in sorted(weeks):
        rows, canc = weeks[(n, s, e)]["rows"], weeks[(n, s, e)]["canceled"]
        hrs = sum(r.get("durationInSeconds") or 0 for r in rows) / 3600
        tag = "  (before start date)" if n < 0 else ""
        print(f"{f'{s} .. {e}':<26}{len(rows):>7}{len(canc):>10}{hrs:>8.1f}{tag}")
        tot_t += len(rows)
        tot_c += len(canc)
    print(f"{'total':<26}{tot_t:>7}{tot_c:>10}")
    if skipped:
        print(f"\n{skipped} tasks had no usable date and were skipped")

    if "--csv" in sys.argv:
        path = arg("--csv")
        keys = sorted(
            {
                k
                for it in items
                for k, v in it.items()
                if not isinstance(v, (dict, list))
            }
        )
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["week_start", "week_end", *keys])
            for (n, s, e), g in sorted(weeks.items()):
                for r in g["rows"] + g["canceled"]:
                    w.writerow([s, e, *[r.get(k, "") for k in keys]])
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
