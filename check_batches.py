#!/usr/bin/env python3
"""Poll the AI Trainer projects endpoint and report batches that are NOT paused.

Setup:
  export LI_COOKIE='<the full value of the -b cookie string from your cURL>'
  python3 check_batches.py --dump     # first run: shows the JSON shape so you can confirm field names
  python3 check_batches.py            # check once
  python3 check_batches.py --loop     # check every 30 minutes, notify only about newly unpaused batches
  python3 check_batches.py --test-notify   # send one test notification and exit

Phone notifications (optional, e.g. when running on a server): set TELEGRAM_BOT_TOKEN and
TELEGRAM_CHAT_ID and every notification is also sent to that Telegram chat.
In --loop mode the set of unpaused batches is remembered in STATE_FILE (default
.batches_state.json) so a restart does not re-notify.

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
STATE_FILE = os.environ.get("STATE_FILE", ".batches_state.json")
EXPIRED_EXIT_CODE = 2  # lets a service manager (systemd) skip restarting on an expired cookie


class SessionExpired(Exception):
    pass


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
            raise SessionExpired(
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


def notify_telegram(msg):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat_id):
        return
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps({"chat_id": chat_id, "text": msg[:4000]}).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=30).close()
    except Exception as e:  # a failed push must not stop the loop; the URL holds the token, so don't print it
        print("telegram error:", e, flush=True)


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
    notify_telegram(msg)


def load_state():
    try:
        with open(STATE_FILE) as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def save_state(names):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sorted(names), f)
    os.replace(tmp, STATE_FILE)


def loop():
    last = load_state()
    while True:
        try:
            names, total = check()
            current = set(names)
            new = sorted(current - last)
            last = current  # before notify/save so a failure there can't cause repeat pings
            if new:
                notify(f"{len(new)} new unpaused: " + "; ".join(new))
            save_state(current)
        except SessionExpired as e:
            notify(f"AI Trainer session expired. Re-copy LI_COOKIE and restart. ({e})")
            sys.exit(EXPIRED_EXIT_CODE)
        except Exception as e:  # keep looping on transient errors
            print("error:", e, flush=True)
        time.sleep(INTERVAL)


def main():
    if "--test-notify" in sys.argv:
        notify("check_batches.py test notification")
        return
    if "--loop" in sys.argv:
        loop()
        return
    try:
        if "--dump" in sys.argv:
            data = fetch()
            els = data.get("elements", [])
            print("top-level keys:", list(data.keys()), "| elements:", len(els))
            print(json.dumps(els[:2], indent=2)[:3000])
            return
        names, total = check()
    except SessionExpired as e:
        sys.exit(str(e))
    print(f"{len(names)} of {total} not paused:")
    for n in names:
        print(" -", n)


if __name__ == "__main__":
    main()
