#!/usr/bin/env python3
"""Fetch the review score of every AI Trainer task and show where you did worse or better.

Lists all your task results like tasks_weeks.py does (everything except CANCELED), then
fetches each task's detail, a few at a time, and reads currentVersionReview.annotationScore.

Setup (same cookie as the other scripts):
  export LI_COOKIE='<the -b cookie string from your cURL>'
  export LI_PROJECT_ID=<your projectId>            # or pass --project every time
  python3 task_scores.py --limit 3                 # smoke test: only fetch 3 task details
  python3 task_scores.py --save scores_cache.json  # fetch everything, save it, print the report
  python3 task_scores.py --load scores_cache.json  # no network: re-run the report from the file

Options (a flag wins over its environment variable):
  --project ID             projectId (env LI_PROJECT_ID; required unless --load)
  --tz ZONE                IANA time zone, e.g. Europe/Madrid (env LI_TZ; default UTC)
  --week0 YYYY-MM-DD       first day of week 0 (env LI_WEEK0; default Monday-Sunday weeks)
  --date-field NAME        force the timestamp field (epoch ms) used for weeks
  --count N                list page size to try (default 50)
  --workers N              task details fetched in parallel (default 3)
  --limit N                only fetch details for the first N tasks
  --save FILE              write the fetched task details to FILE (JSON)
  --load FILE              read task details from FILE instead of fetching
  --top N                  how many lowest / highest scored tasks to list (default 10; 0 = none)
  --low N                  "low" group = score <= N      (default: score below your average)
  --high N                 "high" group = score >= N     (default: score above your average)
"""

import json
import statistics
import sys
import textwrap
import time
import urllib.error
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

from tasks_weeks import (
    BASE,
    MONDAY,
    arg,
    detect_field,
    fetch_all,
    get,
    settings,
    week_of,
)

CACHE_VERSION = 1
# the detail response embeds every pipeline of the project, your profile, etc.: not worth saving
HEAVY_KEYS = ("template", "project", "annotatorProfile", "iteration", "pipelineStage")
RETRY_CODES = (429, 500, 502, 503, 504)
RETRIES = 3


def num(name, cast=float, default=None):
    raw = arg(name)
    if raw is None:
        return default
    try:
        return cast(raw)
    except ValueError:
        sys.exit(f"{name} must be a number, got {raw!r}.")


# ---------- fetching ----------


def slim(detail):
    out = {k: v for k, v in detail.items() if k not in HEAVY_KEYS}
    if isinstance(out.get("pipeline"), dict):
        out["pipeline"] = {k: v for k, v in out["pipeline"].items() if k != "stages"}
    return out


def fetch_detail(task_id):
    """One task's detail. Retries rate limits, server errors and network hiccups."""
    for attempt in range(RETRIES):
        try:
            return slim(get(f"{BASE}/{task_id}"))
        except urllib.error.HTTPError as e:
            if e.code not in RETRY_CODES or attempt == RETRIES - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == RETRIES - 1:
                raise
        time.sleep(2 ** (attempt + 1))


def fetch_details(ids, workers):
    """Fetch details `workers` at a time. Returns (details, failed, stop_message).

    stop_message is set when the run was cut short (expired session or Ctrl-C); details
    then holds whatever was fetched before that, so the caller can still save it.
    """
    done, failed, stop = {}, [], None
    pool = ThreadPoolExecutor(max_workers=workers)
    futures = {pool.submit(fetch_detail, i): i for i in ids}
    try:
        for n, fut in enumerate(as_completed(futures), 1):
            try:
                done[futures[fut]] = fut.result()
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    stop = f"HTTP {e.code}: session expired. Re-copy the cookie from your browser."
                    break
                failed.append((futures[fut], f"HTTP {e.code}"))
            except Exception as e:
                failed.append((futures[fut], str(e) or type(e).__name__))
            print(f"\r  fetched {n}/{len(ids)}", end="", file=sys.stderr, flush=True)
    except KeyboardInterrupt:
        stop = "interrupted."
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        print(file=sys.stderr)
    return [done[i] for i in ids if i in done], failed, stop


def save_cache(path, project, tasks):
    data = {
        "version": CACHE_VERSION,
        "project": project,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tasks": tasks,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    print(f"saved {len(tasks)} task details to {path}", file=sys.stderr)


def load_cache(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f"Cannot read {path}: {e}")
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, list):
        sys.exit(f"{path} is not a task_scores file (no 'tasks' list).")
    print(
        f"loaded {len(tasks)} task details from {path} (fetched {data.get('fetchedAt', '?')})",
        file=sys.stderr,
    )
    return tasks


# ---------- reading a task ----------


def review(t):
    r = t.get("currentVersionReview")
    return r if isinstance(r, dict) else {}


def score_of(t):
    s = review(t).get("annotationScore")
    return s if isinstance(s, (int, float)) and not isinstance(s, bool) else None


def title_of(t):
    try:
        data = json.loads(t.get("inputData") or "{}")
        title = data.get("title") if isinstance(data, dict) else None
    except (ValueError, TypeError):
        title = None
    return title or t.get("name") or f"task {t.get('id')}"


def batch_of(t):
    p = t.get("pipeline")
    return (p.get("name") if isinstance(p, dict) else None) or "(unknown batch)"


def day_of(ms, tz):
    if not isinstance(ms, (int, float)):
        return "?"
    return datetime.fromtimestamp(ms / 1000, tz).date().isoformat()


# ---------- report ----------


def stat_cells(scores):
    if not scores:
        return f"{'-':>7}{'-':>6}{'-':>6}"
    return f"{statistics.fmean(scores):>7.2f}{min(scores):>6g}{max(scores):>6g}"


def avg_minutes(ts, key):
    vals = [t[key] for t in ts if isinstance(t.get(key), (int, float))]
    return f"{statistics.fmean(vals) / 60:.1f}" if vals else "-"


def show_tasks(heading, ts, field, tz):
    print(f"\n{heading}")
    for t in ts:
        r = review(t)
        print(
            f"  {score_of(t):>5g}  {day_of(t.get(field), tz)}  #{t.get('id')}  {title_of(t)}"
        )
        print(f"         batch: {batch_of(t)}  | review: {r.get('status', '?')}")
        feedback = (r.get("feedback") or "").strip()
        if feedback:
            print(
                textwrap.fill(
                    feedback,
                    100,
                    initial_indent="         > ",
                    subsequent_indent="           ",
                )
            )


def report(tasks, tz, week0, top, low_max, high_min):
    scored = [t for t in tasks if score_of(t) is not None]
    reviewed = Counter(review(t).get("status") or "?" for t in tasks if review(t))
    print(
        f"\n{len(tasks)} tasks: {len(scored)} with a review score, {len(tasks) - len(scored)} without"
    )
    if reviewed:
        print(
            "review status: " + ", ".join(f"{k} {v}" for k, v in reviewed.most_common())
        )
    if not scored:
        return print(
            "nothing to analyse: no task has currentVersionReview.annotationScore"
        )

    scores = [score_of(t) for t in scored]
    mean = statistics.fmean(scores)
    sd = statistics.stdev(scores) if len(scores) > 1 else 0.0
    print(
        f"\nAverage score: {mean:.2f}   median {statistics.median(scores):g}   "
        f"stdev {sd:.2f}   min {min(scores):g}   max {max(scores):g}"
    )
    dist = Counter(scores)
    for s in sorted(dist):
        bar = "█" * max(1, round(30 * dist[s] / max(dist.values())))
        print(f"  {s:>5g} | {bar} {dist[s]} ({dist[s] / len(scores):.0%})")

    try:
        field = detect_field(tasks, arg("--date-field"))
    except SystemExit:
        field = None
        print(
            "\nno usable date field, skipping the weekly table (pass --date-field NAME)"
        )
    if field:
        weeks = defaultdict(lambda: {"scores": [], "unscored": 0})
        skipped = 0
        for t in tasks:
            ms = t.get(field)
            if not isinstance(ms, (int, float)):
                skipped += 1
                continue
            w = weeks[week_of(ms, tz, week0)]
            s = score_of(t)
            if s is None:
                w["unscored"] += 1
            else:
                w["scores"].append(s)
        span = f"{week0:%a}-{week0 + timedelta(days=6):%a}"
        print(f"\nBy week, grouped by '{field}' ({span}, {tz.key})")
        print(
            f"{'week':<26}{'scored':>7}{'unscored':>10}{'avg':>7}{'min':>6}{'max':>6}"
        )
        for (n, s, e), w in sorted(weeks.items()):
            tag = "  (before start date)" if n < 0 else ""
            print(
                f"{f'{s} .. {e}':<26}{len(w['scores']):>7}{w['unscored']:>10}{stat_cells(w['scores'])}{tag}"
            )
        if skipped:
            print(f"{skipped} tasks had no usable date and were skipped")

    batches = defaultdict(lambda: {"scores": [], "unscored": 0})
    for t in tasks:
        s = score_of(t)
        b = batches[batch_of(t)]
        if s is None:
            b["unscored"] += 1
        else:
            b["scores"].append(s)
    print("\nBy batch, lowest average first")
    print(f"{'batch':<62}{'scored':>7}{'unscored':>10}{'avg':>7}{'min':>6}{'max':>6}")
    order = sorted(
        batches.items(),
        key=lambda kv: (not kv[1]["scores"], statistics.fmean(kv[1]["scores"] or [0])),
    )
    for name, b in order:
        label = name if len(name) <= 60 else name[:57] + "..."
        print(
            f"{label:<62}{len(b['scores']):>7}{b['unscored']:>10}{stat_cells(b['scores'])}"
        )

    is_low = (lambda s: s <= low_max) if low_max is not None else (lambda s: s < mean)
    is_high = (
        (lambda s: s >= high_min) if high_min is not None else (lambda s: s > mean)
    )
    low_label = f"<= {low_max:g}" if low_max is not None else f"< {mean:.2f}"
    high_label = f">= {high_min:g}" if high_min is not None else f"> {mean:.2f}"
    print(
        "\nLow vs high scores (minutes are the platform's durationInSeconds / idleDurationInSeconds)"
    )
    print(f"{'group':<24}{'tasks':>7}{'avg active min':>16}{'avg idle min':>14}")
    for label, pred in (
        (f"low  (score {low_label})", is_low),
        (f"high (score {high_label})", is_high),
    ):
        g = [t for t in scored if pred(score_of(t))]
        print(
            f"{label:<24}{len(g):>7}{avg_minutes(g, 'durationInSeconds'):>16}{avg_minutes(g, 'idleDurationInSeconds'):>14}"
        )

    if top > 0:
        recent = lambda t: -(
            t.get(field) if field and isinstance(t.get(field), (int, float)) else 0
        )
        n_min, n_max = scores.count(min(scores)), scores.count(max(scores))
        lowest = sorted(scored, key=lambda t: (score_of(t), recent(t)))[:top]
        highest = sorted(scored, key=lambda t: (-score_of(t), recent(t)))[:top]
        show_tasks(
            f"Lowest {len(lowest)} ({n_min} tasks scored {min(scores):g}), most recent first",
            lowest,
            field,
            tz,
        )
        show_tasks(
            f"Highest {len(highest)} ({n_max} tasks scored {max(scores):g}), most recent first",
            highest,
            field,
            tz,
        )


def main():
    load, save = arg("--load"), arg("--save")
    if load and save:
        sys.exit("--load and --save can't be combined: --load never fetches anything.")
    project, tz, start_date = settings(need_project=not load)
    week0 = start_date or MONDAY

    if load:
        tasks = load_cache(load)
    else:
        items = fetch_all(project, num("--count", int, 50))
        live = [i for i in items if i.get("state") != "CANCELED"]
        ids = [i["id"] for i in live if i.get("id") is not None]
        print(
            f"{len(items)} tasks listed, {len(items) - len(live)} canceled skipped",
            file=sys.stderr,
        )
        if len(ids) < len(live):
            print(
                f"warning: {len(live) - len(ids)} listed tasks have no id and were skipped",
                file=sys.stderr,
            )
        limit = num("--limit", int)
        if limit:
            ids = ids[:limit]
        workers = max(1, num("--workers", int, 3))
        print(f"fetching {len(ids)} task details, {workers} at a time", file=sys.stderr)
        tasks, failed, stop = fetch_details(ids, workers)
        if save:
            save_cache(save, project, tasks)
        if failed:
            shown = ", ".join(f"#{i} ({why})" for i, why in failed[:5])
            print(
                f"{len(failed)} task details failed: {shown}{' ...' if len(failed) > 5 else ''}",
                file=sys.stderr,
            )
        if stop:
            sys.exit(stop)

    if not tasks:
        return print("no tasks to analyse")
    report(tasks, tz, week0, num("--top", int, 10), num("--low"), num("--high"))


if __name__ == "__main__":
    main()
