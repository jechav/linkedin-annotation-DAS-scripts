# linkedin-annotation-DAS-scripts

Small personal helper scripts for annotators on LinkedIn's **AI Trainer** platform.

| Script | What it answers |
|---|---|
| [`check_batches.py`](#check_batchespy) | "Is there any batch open for me right now?" |
| [`tasks_weeks.py`](#tasks_weekspy) | "How many tasks and hours did I do each week?" |

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by LinkedIn.
> It calls internal, undocumented endpoints that can change or disappear at any time.
> Automated access may conflict with LinkedIn's User Agreement. Use it only on your own
> account, at a gentle polling rate, and at your own risk.

## Requirements

- Python 3.9+ (`tasks_weeks.py` uses `zoneinfo`). Standard library only, nothing to install.
- A logged-in LinkedIn browser session (see [Setup](#setup)).
- Optional: macOS adds desktop notifications, and a Telegram bot adds phone notifications
  (see [Run on a server](#run-on-a-server-with-telegram-notifications)).

## Setup

Both scripts authenticate the same way, by reusing your browser session cookie.

1. Sign in at <https://www.linkedin.com/ai-trainer/tasks> in your browser.
2. Open DevTools → **Network**, reload, right-click any `/ai-trainer/api/...` request
   (e.g. `frontendAnnotationProjects`) → **Copy → Copy as cURL**.
3. From the copied command, take the whole value after `-b '...'` (the cookie string).
   It must include `JSESSIONID`, which the scripts reuse as the CSRF token.
4. Export it in your shell. Don't put it in a script:

   ```bash
   export LI_COOKIE='paste-the-cookie-string-here'
   ```

   Or copy `.env.example` to `.env` (gitignored), fill it in, and load it with
   `set -a; source .env; set +a`.

The cookie expires. When a script says `HTTP 401/403: session expired`, repeat steps 1–4.

## `check_batches.py`

Polls the projects endpoint and reports which annotation pipelines (batches) are
**not paused**, so you know when new work opens up without refreshing the tasks page.

- Follows pagination across all your projects.
- In loop mode it checks every 30 minutes and only notifies about batches that **newly**
  became unpaused. On macOS it shows a desktop notification via `osascript`, and if
  Telegram is configured it also sends a phone message.
- The set it has already told you about is saved to `STATE_FILE` (default
  `.batches_state.json`), so restarting the loop does not repeat old notifications.
  The first run notifies about everything currently open.

### Usage

```bash
python3 check_batches.py --dump         # first run: print the response shape to confirm field names
python3 check_batches.py                # check once and list unpaused batches
python3 check_batches.py --loop         # check every 30 min, notify about newly unpaused batches
python3 check_batches.py --test-notify  # send one test notification and exit
```

Example output:

```
2 of 14 not paused:
 - Some Project / Batch A ID: 123 [ACTIVE]
 - Other Project / Batch 7 ID: 456 [ACTIVE]
```

To keep the loop running in the background:

```bash
nohup python3 check_batches.py --loop > batches.log 2>&1 &
```

### Run on a server with Telegram notifications

To get a phone notification without keeping your own computer on, run the loop on an
always-on Linux server (e.g. a small VPS) as a systemd service.

> **Check this first.** The cookie comes from your own browser session, and LinkedIn may
> reject it when it is replayed from a datacenter IP. On the server, run
> `python3 check_batches.py --dump` once before setting anything up. If it prints
> `HTTP 401/403`, this setup won't work from that server.

**1. Create the Telegram bot** (once):

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and follow
   the prompts. Copy the bot token it gives you.
2. Open a chat with your new bot and send it any message.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. The number at
   `message.chat.id` is your `TELEGRAM_CHAT_ID`.

**2. Set up the server:**

```bash
# as a non-root user, e.g. "batches"
git clone https://github.com/jechav/linkedin-annotation-DAS-scripts.git
cd linkedin-annotation-DAS-scripts

# as root: create the env file (keep the single quotes around the cookie) and lock it down
sudo install -m 600 -o root -g root /dev/null /etc/check-batches.env
sudoedit /etc/check-batches.env
```

Put these lines in `/etc/check-batches.env`:

```
LI_COOKIE='paste-the-cookie-string-here'
TELEGRAM_BOT_TOKEN='123456:ABC...'
TELEGRAM_CHAT_ID='123456789'
STATE_FILE='/home/batches/batches_state.json'
```

**3. Check the Telegram wiring, then start the service:**

```bash
set -a; source /etc/check-batches.env; set +a   # as root, or use sudo -E
python3 check_batches.py --test-notify          # a message should arrive on your phone

# edit User= and the paths in deploy/check-batches.service first
sudo cp deploy/check-batches.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now check-batches
journalctl -u check-batches -f                  # watch the log
```

**When the cookie expires** the service sends one Telegram message ("AI Trainer session
expired") and stops, instead of retrying with a dead cookie. Re-copy the cookie (see
[Setup](#setup)), update `LI_COOKIE` in `/etc/check-batches.env`, then run
`sudo systemctl start check-batches`.

The service only tells you about problems it can see. If the server itself goes down you
won't get a message, so consider a heartbeat/dead-man's-switch service on top.

## `tasks_weeks.py`

Downloads **all** your task results for a project and summarizes them per week: tasks
completed, tasks canceled, and hours worked (from `durationInSeconds`). It can also
export every task with its week to CSV.

- Weeks are **Monday–Sunday** in UTC by default. Set a time zone with `--tz`, and a
  first week with `--week0`. Weeks then start on that date's weekday, and earlier tasks
  are still shown, tagged `(before start date)`.
- The timestamp used for grouping is auto-detected from the first of these fields
  present on most tasks: `submittedAt`, `completedAt`, `finishedAt`, `endedAt`,
  `createdAt`, `startedAt`, `lastModifiedAt`.
- **Canceled tasks** usually have no end date, so they're bucketed by their
  last-modified, claimed or created time. They are counted separately and excluded
  from the tasks and hours totals.
- Paging is defensive. It asks for 50 tasks per page, halves the page size if the
  server rejects it, advances by however many rows actually came back, and de-duplicates
  rows.

### Usage

First find your `projectId`. In DevTools, open the **Tasks** page and look at the query
string of the `frontendAnnotationTaskResults` request.

```bash
export LI_PROJECT_ID=1234567                  # or pass --project 1234567 each time
python3 tasks_weeks.py --dump                 # response shape + which date field was detected
python3 tasks_weeks.py                        # weekly summary (Mon-Sun, UTC)
python3 tasks_weeks.py --tz America/New_York --week0 2026-09-14
python3 tasks_weeks.py --csv tasks.csv        # also write every task + its week to CSV
```

Each setting can be a flag or an environment variable. The flag wins when both are set,
so you can keep your defaults in `.env` (see `.env.example`).

| Option | Env var | Default | Meaning |
|---|---|---|---|
| `--project ID` | `LI_PROJECT_ID` | **required** | AI Trainer `projectId` to report on |
| `--tz ZONE` | `LI_TZ` | `UTC` | IANA time zone used to decide which day a task falls on |
| `--week0 YYYY-MM-DD` | `LI_WEEK0` | none (Mon–Sun) | First day of week 0. Weeks start on its weekday |

Other options:

| Option | Default | Meaning |
|---|---|---|
| `--date-field NAME` | auto | Force the epoch-ms field used for grouping |
| `--count N` | `50` | First page size to try (halves automatically on rejection) |
| `--csv PATH` | off | Write every task (flat fields only) plus `week_start`/`week_end` |
| `--dump` | off | Print the first tasks (nested objects collapsed) and exit |

Example output:

```
Grouped by 'submittedAt' (Mon-Sun, America/New_York), weeks from 2026-09-14
canceled tasks are counted by their last-modified date and excluded from tasks/hours
week                        tasks  canceled   hours
2026-09-07 .. 2026-09-13        5         0     1.2  (before start date)
2026-09-14 .. 2026-09-20       42         3    11.5
2026-09-21 .. 2026-09-27       57         1    15.2
total                         104         4
```

## How it works

| | `check_batches.py` | `tasks_weeks.py` |
|---|---|---|
| Endpoint | `GET /ai-trainer/api/frontendAnnotationProjects?q=annotator` | `GET /ai-trainer/api/frontendAnnotationTaskResults?q=annotator&projectId=…` |
| Paging | `start` += page `count` | `start` += rows returned, until empty, duplicate or `paging.total` |
| Key fields | `elements[].pipelines[].{name,id,state}` | `state`, a timestamp field, `durationInSeconds` |

Both send your cookie, `csrf-token` = `JSESSIONID`, and `x-restli-protocol-version: 2.0.0`.

## Troubleshooting

- **`Set LI_COOKIE first`**: the environment variable isn't set in this shell.
- **`JSESSIONID not found in LI_COOKIE`**: you copied only part of the cookie string.
- **`HTTP 401/403: session expired`**: sign in again and re-copy the cookie.
- **`telegram error: ...`**: the push failed (wrong token or chat id, or you haven't
  messaged the bot yet). The check itself keeps running.
- **`Set LI_PROJECT_ID or pass --project ID`** (`tasks_weeks.py`): see
  [Usage](#usage-1) for where to find your `projectId`.
- **`Unknown time zone`**: use an IANA name such as `Europe/Madrid` (see the
  [tz database list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)).
- **`Could not detect a date field`** (`tasks_weeks.py`): run `--dump`, find the
  epoch-ms timestamp you want, and pass `--date-field NAME`.
- **Empty or odd results**: run `--dump` and check whether LinkedIn changed the
  response shape.

## Security and privacy

Your `LI_COOKIE` value **is your logged-in LinkedIn session**. Anyone who has it can act
as you.

- Never hardcode it, commit it, paste it into issues, or share it. The same goes for your
  Telegram bot token, which lets anyone send messages as your bot.
- `--dump` output, logs and `--csv` exports contain your personal task data. `.env`,
  cookie files, `*.log` and `*.csv` are gitignored. Check `git status` before committing anyway.
- If you think the cookie leaked, sign out of LinkedIn on all devices to invalidate the session.

## License

[MIT](LICENSE)
