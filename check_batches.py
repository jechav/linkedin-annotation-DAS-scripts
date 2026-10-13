#!/usr/bin/env python3
"""Poll the AI Trainer projects endpoint and report batches that are NOT paused.

Setup:
  export LI_COOKIE='<the full value of the -b cookie string from your cURL>'
  python3 check_batches.py --dump     # first run: shows the JSON shape so you can confirm field names
  python3 check_batches.py            # check once
  python3 check_batches.py --loop     # check every 30 minutes, notify only when the set changes

The cookie is read from the environment on purpose: never hardcode it in the file.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

URL = "https://www.linkedin.com/ai-trainer/api/frontendAnnotationProjects?q=annotator"
INTERVAL = 30 * 60


def fetch(start=0):
    cookie = os.environ.get("LI_COOKIE")
    if not cookie:
        sys.exit("Set LI_COOKIE first (see header of this file).")
    m = re.search(r'JSESSIONID="?([^";]+)', cookie)
    if not m:
        sys.exit("JSESSIONID not found in LI_COOKIE.")
    req = urllib.request.Request(
        URL + (f"&start={start}" if start else ""),
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
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            sys.exit(
                f"HTTP {e.code}: session expired. Re-copy the cookie from your browser."
            )
        raise


def check():
    """Return (sorted list of 'Project / Pipeline' not paused, total pipelines)."""
    active, total, start = [], 0, 0
    while True:
        data = fetch(start)
        projects = data.get("elements", [])
        for p in projects:
            for pl in p.get("pipelines", []):
                total += 1
                if pl.get("state") != "PAUSED":
                    active.append(
                        f'{p.get("name", "?")} / {pl.get("name", "?")} ID: {pl.get("id", "-")} [{pl.get("state")}]'
                    )
        count = data.get("paging", {}).get("count", 0)
        if not projects or len(projects) < count:
            break
        start += count
    return sorted(active), total


def notify(msg):
    print(msg, flush=True)
    if sys.platform == "darwin":
        subprocess.run(
            [
                "osascript",
                "-e",
                f'display notification {json.dumps(msg)} with title "AI Trainer batches"',
            ]
        )


def main():
    if "--dump" in sys.argv:
        data = fetch()
        els = data.get("elements", [])
        print("top-level keys:", list(data.keys()), "| elements:", len(els))
        print(json.dumps(els[:2], indent=2)[:3000])
        return
    if "--loop" not in sys.argv:
        names, total = check()
        print(f"{len(names)} of {total} not paused:")
        for n in names:
            print(" -", n)
        return
    last = None
    while True:
        try:
            names, total = check()
            if names != last:
                notify(
                    f"{len(names)} unpaused: " + "; ".join(names)
                    if names
                    else "No unpaused batches"
                )
                last = names
        except Exception as e:  # keep looping on transient errors
            print("error:", e, flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
