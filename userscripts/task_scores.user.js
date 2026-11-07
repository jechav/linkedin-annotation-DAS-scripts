// ==UserScript==
// @name         AI Trainer task scores
// @namespace    https://github.com/jechav/linkedin-annotation-DAS-scripts
// @version      0.1.1
// @description  Average review score of your AI Trainer tasks, overall and per week. Browser version of task_scores.py.
// @match        https://www.linkedin.com/ai-trainer/*
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @updateURL    https://raw.githubusercontent.com/jechav/linkedin-annotation-DAS-scripts/main/userscripts/task_scores.user.js
// @downloadURL  https://raw.githubusercontent.com/jechav/linkedin-annotation-DAS-scripts/main/userscripts/task_scores.user.js
// ==/UserScript==

/*
 * Unofficial. Calls LinkedIn's internal, undocumented AI Trainer endpoints with your own
 * logged-in session, only when you click the button. See the README.
 *
 * Two parts:
 *   Core: fetching and maths, no DOM. A later browser extension can reuse it as is,
 *         and Node can load it for tests (module.exports).
 *   UI:   the floating button and the panel.
 */
(function () {
  "use strict";

  // ======================= Core =======================

  const BASE = "https://www.linkedin.com/ai-trainer/api/frontendAnnotationTaskResults";
  const EXPIRED_CODES = [301, 302, 303, 307, 308, 401, 403]; // 3xx = bounced to the login page
  const RETRY_CODES = [429, 500, 502, 503, 504];
  const RETRIES = 3;
  const WORKERS = 3;
  const DATE_CANDIDATES = [
    "submittedAt", "completedAt", "finishedAt", "endedAt", "createdAt", "startedAt", "lastModifiedAt",
  ];
  const DAY_MS = 86400000;
  const MONDAY = Date.UTC(2001, 0, 1) / DAY_MS; // any Monday: anchors Mon-Sun weeks

  class HttpError extends Error {
    constructor(status) {
      super(`HTTP ${status}`);
      this.status = status;
    }
  }
  class ExpiredError extends Error {
    constructor(status) {
      super(`HTTP ${status}: session expired. Reload the page and sign in again.`);
    }
  }
  class StoppedError extends Error {}

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new StoppedError("stopped")); }, { once: true });
    });

  function csrfToken(cookieString) {
    const m = /(?:^|;\s*)JSESSIONID="?([^";]+)/.exec(cookieString || "");
    return m ? m[1] : null;
  }

  /** GET a same-origin AI Trainer API URL with the page's session. */
  async function get(url, signal) {
    const token = csrfToken(document.cookie);
    if (!token) throw new Error("JSESSIONID cookie not found. Are you signed in to LinkedIn?");
    let r;
    try {
      r = await fetch(url, {
        credentials: "include",
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json",
          "csrf-token": token,
          "x-restli-protocol-version": "2.0.0",
        },
      });
    } catch (e) {
      if (signal?.aborted) throw new StoppedError("stopped");
      throw e;
    }
    if (r.type === "opaqueredirect") throw new ExpiredError(302);
    if (EXPIRED_CODES.includes(r.status)) throw new ExpiredError(r.status);
    if (!r.ok) throw new HttpError(r.status);
    return r.json();
  }

  /** Every task result (all projects), paging like tasks_weeks.fetch_all. */
  async function fetchAll(get, { count = 50, signal, onPage } = {}) {
    const items = [];
    const seen = new Set();
    let start = 0;
    for (;;) {
      if (signal?.aborted) throw new StoppedError("stopped");
      let data;
      try {
        data = await get(`${BASE}?q=annotator&start=${start}&count=${count}`, signal);
      } catch (e) {
        if (e instanceof HttpError && [400, 413, 422, 500].includes(e.status) && count > 10) {
          count = Math.max(10, Math.floor(count / 2));
          continue;
        }
        throw e;
      }
      const els = data.elements || [];
      const fresh = els.filter((e) => !seen.has(JSON.stringify(e)));
      fresh.forEach((e) => seen.add(JSON.stringify(e)));
      items.push(...fresh);
      const total = data.paging?.total;
      onPage?.(items.length, total);
      // the server may cap count below what we asked, so advance by what we actually got
      if (!els.length || !fresh.length || (total != null && items.length >= total)) return items;
      start += els.length;
    }
  }

  /** One task's detail. Retries rate limits, server errors and network hiccups. */
  async function fetchDetail(get, id, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await get(`${BASE}/${id}`, signal);
      } catch (e) {
        const retryable =
          (e instanceof HttpError && RETRY_CODES.includes(e.status)) || e instanceof TypeError; // TypeError = network
        if (!retryable || attempt === RETRIES - 1) throw e;
      }
      await sleep(2000 * 2 ** attempt, signal);
    }
  }

  /**
   * Fetch details WORKERS at a time. Never throws: returns what it got plus why it stopped.
   * stop is null (finished), "stopped" (user), or an error message (e.g. expired session).
   */
  async function fetchDetails(get, ids, { signal, onProgress, workers = WORKERS } = {}) {
    const done = new Map();
    const failed = [];
    let next = 0, finished = 0, stop = null;
    const worker = async () => {
      while (next < ids.length && !stop) {
        const id = ids[next++];
        try {
          done.set(id, await fetchDetail(get, id, signal));
        } catch (e) {
          if (e instanceof StoppedError || signal?.aborted) stop = stop || "stopped";
          else if (e instanceof ExpiredError) stop = e.message;
          else failed.push([id, e.message || String(e)]);
        }
        finished++;
        onProgress?.(finished, ids.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, ids.length) }, worker));
    return { tasks: ids.filter((i) => done.has(i)).map((i) => done.get(i)), failed, stop };
  }

  // ---------- reading a task ----------

  const review = (t) => (t.currentVersionReview && typeof t.currentVersionReview === "object" ? t.currentVersionReview : {});
  const scoreOf = (t) => {
    const s = review(t).annotationScore;
    return typeof s === "number" && Number.isFinite(s) ? s : null;
  };
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function detectField(tasks) {
    return DATE_CANDIDATES.find((f) => tasks.filter((t) => isNum(t[f])).length > tasks.length * 0.5) || null;
  }

  /** Mon-Sun week of an epoch-ms timestamp in the given IANA zone. */
  function weekOf(ms, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(ms))
      .reduce((o, p) => ((o[p.type] = p.value), o), {});
    const day = Date.UTC(+parts.year, +parts.month - 1, +parts.day) / DAY_MS;
    const n = Math.floor((day - MONDAY) / 7);
    const s = MONDAY + 7 * n;
    const iso = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
    return { n, start: iso(s), end: iso(s + 6) };
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stats = (xs) => (xs.length ? { avg: mean(xs), min: Math.min(...xs), max: Math.max(...xs) } : null);

  /** The numbers the panel shows. Same rules as task_scores.report (overall + by week). */
  function summarize(tasks, timeZone) {
    const scores = tasks.map(scoreOf).filter((s) => s !== null);
    const status = {};
    for (const t of tasks) {
      if (!Object.keys(review(t)).length) continue;
      const k = review(t).status || "?";
      status[k] = (status[k] || 0) + 1;
    }
    const field = detectField(tasks);
    const weeks = new Map();
    let undated = 0;
    if (field) {
      for (const t of tasks) {
        if (!isNum(t[field])) { undated++; continue; }
        const w = weekOf(t[field], timeZone);
        if (!weeks.has(w.n)) weeks.set(w.n, { ...w, scores: [], unscored: 0 });
        const s = scoreOf(t);
        s === null ? weeks.get(w.n).unscored++ : weeks.get(w.n).scores.push(s);
      }
    }
    return {
      total: tasks.length,
      scored: scores.length,
      unscored: tasks.length - scores.length,
      overall: stats(scores),
      status: Object.entries(status).sort((a, b) => b[1] - a[1]),
      field,
      timeZone,
      undated,
      weeks: [...weeks.values()]
        .sort((a, b) => b.n - a.n) // newest first
        .map((w) => ({ start: w.start, end: w.end, scored: w.scores.length, unscored: w.unscored, ...stats(w.scores) })),
    };
  }

  const g = (x) => (x == null ? "-" : String(+x.toFixed(6))); // like Python's :g for scores
  const f2 = (x) => (x == null ? "-" : x.toFixed(2));

  /** Plain-text report, for "Copy as text". */
  function formatText(sum, note) {
    const lines = [];
    if (note) lines.push(note);
    lines.push(
      sum.overall
        ? `Average ${f2(sum.overall.avg)} · ${sum.scored} scored · ${sum.unscored} unscored   (min ${g(sum.overall.min)}, max ${g(sum.overall.max)})`
        : `${sum.total} tasks, none with a review score`,
    );
    if (sum.status.length) lines.push("review status: " + sum.status.map(([k, v]) => `${k} ${v}`).join(", "));
    if (sum.field) {
      lines.push("", `By week, grouped by '${sum.field}' (Mon-Sun, ${sum.timeZone}), newest first`);
      const pad = (s, n) => String(s).padStart(n);
      lines.push("week".padEnd(26) + pad("scored", 7) + pad("unscored", 10) + pad("avg", 7) + pad("min", 6) + pad("max", 6));
      for (const w of sum.weeks) {
        lines.push(`${w.start} .. ${w.end}`.padEnd(26) + pad(w.scored, 7) + pad(w.unscored, 10) + pad(f2(w.avg), 7) + pad(g(w.min), 6) + pad(g(w.max), 6));
      }
      if (sum.undated) lines.push(`${sum.undated} tasks had no usable date and were skipped`);
    } else if (sum.total) {
      lines.push("", "no usable date field, so no weekly table");
    }
    return lines.join("\n");
  }

  /** Whole run: list, drop CANCELED, fetch details, summarize. Never throws for partial results. */
  async function run({ get, signal, timeZone, onStatus }) {
    onStatus?.("listing tasks…");
    const items = await fetchAll(get, { signal, onPage: (n, total) => onStatus?.(`listing tasks… ${n}${total != null ? `/${total}` : ""}`) });
    const ids = items.filter((i) => i.state !== "CANCELED" && i.id != null).map((i) => i.id);
    const canceled = items.filter((i) => i.state === "CANCELED").length;
    onStatus?.(`fetched 0/${ids.length}`);
    const { tasks, failed, stop } = await fetchDetails(get, ids, { signal, onProgress: (n, of) => onStatus?.(`fetched ${n}/${of}`) });
    return { summary: summarize(tasks, timeZone), listed: items.length, canceled, wanted: ids.length, failed, stop };
  }

  const Core = { BASE, csrfToken, get, fetchAll, fetchDetail, fetchDetails, scoreOf, detectField, weekOf, summarize, formatText, run, HttpError, ExpiredError, StoppedError };

  if (typeof module === "object" && module.exports) {
    module.exports = Core;
    return;
  }

  // ======================= UI =======================

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      --bg: #ffffff; --fg: #1d2226; --muted: #5e6a75; --line: #dfe3e8; --accent: #0a66c2; --accent-fg: #ffffff;
      --warn-bg: #fff4e5; --warn-fg: #8a4b00; --err-bg: #fdecec; --err-fg: #a4000f;
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg);
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --bg: #1d2226; --fg: #e9ecef; --muted: #a2adb8; --line: #38434f; --accent: #70b5f9; --accent-fg: #0b1117;
        --warn-bg: #3b2a10; --warn-fg: #f5c37a; --err-bg: #3d1518; --err-fg: #ff9a9f;
      }
    }
    .fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 20px;
      padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    .panel {
      position: fixed; right: 20px; bottom: 68px; z-index: 2147483647; width: min(460px, calc(100vw - 32px));
      max-height: calc(100vh - 100px); overflow: auto; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.28); padding: 14px 16px;
    }
    .panel[hidden] { display: none; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    h2 { font-size: 15px; margin: 0; }
    .x { background: none; border: 0; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; }
    .big { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .muted { color: var(--muted); font-size: 12px; }
    .note { border-radius: 6px; padding: 6px 8px; margin: 8px 0; font-size: 13px; }
    .warn { background: var(--warn-bg); color: var(--warn-fg); }
    .err { background: var(--err-bg); color: var(--err-fg); }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; font-variant-numeric: tabular-nums; }
    th, td { padding: 4px 6px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; }
    th { color: var(--muted); font-weight: 600; }
    .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .actions button {
      font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 16px; cursor: pointer;
      border: 1px solid var(--accent); background: transparent; color: var(--accent);
    }
    .actions button.primary { background: var(--accent); color: var(--accent-fg); }
    .actions button[hidden] { display: none; }
  `;

  const host = document.createElement("div");
  host.id = "ai-trainer-task-scores";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="wrap">
      <button class="fab" title="Average review score of your tasks">Scores</button>
      <section class="panel" hidden role="dialog" aria-label="Task scores">
        <header><h2>Task scores</h2><button class="x" aria-label="Close">×</button></header>
        <div class="body"></div>
        <div class="actions">
          <button class="stop primary" hidden>Stop</button>
          <button class="refresh primary" hidden>Refresh all</button>
          <button class="copy" hidden>Copy as text</button>
          <button class="close">Close</button>
        </div>
      </section>
    </div>`;
  // The page is React hydrating the whole document, and that runs after `load`. A node added
  // before hydration finishes doesn't match the server HTML: React throws error #418, renders
  // the document again and drops the node. So attach a bit after load, then check every second
  // and re-attach if a later full re-render removed it.
  const attach = () => { if (!host.isConnected && document.body) document.body.appendChild(host); };
  const watch = () => { setTimeout(attach, 1500); setInterval(attach, 1000); };
  if (document.readyState === "complete") watch();
  else window.addEventListener("load", watch, { once: true });

  const $ = (s) => root.querySelector(s);
  const panel = $(".panel"), body = $(".body");
  const btn = { stop: $(".stop"), refresh: $(".refresh"), copy: $(".copy") };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let controller = null;
  let lastText = "";

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function setButtons(running) {
    btn.stop.hidden = !running;
    btn.refresh.hidden = running;
    btn.copy.hidden = running || !lastText;
  }

  function renderResult(res) {
    const s = res.summary;
    const notes = [];
    if (res.stop === "stopped") notes.push(["warn", `Stopped: partial result from ${s.total} of ${res.wanted} tasks.`]);
    else if (res.stop) notes.push(["err", `${res.stop} Partial result from ${s.total} of ${res.wanted} tasks.`]);
    if (res.failed.length) {
      const shown = res.failed.slice(0, 5).map(([id, why]) => `#${id} (${why})`).join(", ");
      notes.push(["warn", `${res.failed.length} task details failed and are left out: ${shown}${res.failed.length > 5 ? " …" : ""}`]);
    }
    const head = s.overall
      ? `<div class="big">${f2(s.overall.avg)}</div>
         <div>${s.scored} scored · ${s.unscored} unscored <span class="muted">· min ${g(s.overall.min)} · max ${g(s.overall.max)}</span></div>`
      : `<div>${s.total} tasks, none with a review score yet.</div>`;
    const status = s.status.length ? `<div class="muted">review status: ${s.status.map(([k, v]) => `${esc(k)} ${v}`).join(", ")}</div>` : "";
    const meta = `<div class="muted">${res.listed} tasks listed, ${res.canceled} canceled skipped${s.field ? ` · weeks Mon–Sun by '${esc(s.field)}', ${esc(s.timeZone)}` : ""}</div>`;
    let table = "";
    if (s.field && s.weeks.length) {
      table = `<table><thead><tr><th>week</th><th>scored</th><th>unscored</th><th>avg</th><th>min</th><th>max</th></tr></thead><tbody>${s.weeks
        .map((w) => `<tr><td>${w.start} … ${w.end.slice(5)}</td><td>${w.scored}</td><td>${w.unscored}</td><td>${f2(w.avg)}</td><td>${g(w.min)}</td><td>${g(w.max)}</td></tr>`)
        .join("")}</tbody></table>`;
      if (s.undated) table += `<div class="muted">${s.undated} tasks had no usable date and were skipped</div>`;
    } else if (s.total) {
      table = `<div class="muted">No usable date field, so no weekly table.</div>`;
    }
    body.innerHTML =
      notes.map(([cls, msg]) => `<div class="note ${cls}">${esc(msg)}</div>`).join("") + head + status + meta + table;
    lastText = Core.formatText(s, notes.map(([, m]) => m).join("\n") || null);
  }

  async function start() {
    if (controller) return;
    panel.hidden = false;
    controller = new AbortController();
    lastText = "";
    setButtons(true);
    body.innerHTML = `<div class="status">starting…</div>`;
    const status = (msg) => { const el = root.querySelector(".status"); if (el) el.textContent = msg; };
    try {
      renderResult(await Core.run({ get: Core.get, signal: controller.signal, timeZone, onStatus: status }));
    } catch (e) {
      const msg = e instanceof Core.StoppedError ? "Stopped before any task detail was fetched." : e.message || String(e);
      body.innerHTML = `<div class="note ${e instanceof Core.StoppedError ? "warn" : "err"}">${esc(msg)}</div>`;
    } finally {
      controller = null;
      setButtons(false);
    }
  }

  async function copy() {
    try {
      if (typeof GM_setClipboard === "function") GM_setClipboard(lastText, "text");
      else await navigator.clipboard.writeText(lastText);
      btn.copy.textContent = "Copied";
    } catch {
      btn.copy.textContent = "Copy failed";
    }
    setTimeout(() => (btn.copy.textContent = "Copy as text"), 1500);
  }

  $(".fab").addEventListener("click", () => {
    if (!panel.hidden && !controller) panel.hidden = true;
    else if (panel.hidden && lastText) panel.hidden = false;
    else start();
  });
  btn.refresh.addEventListener("click", start);
  btn.stop.addEventListener("click", () => controller?.abort());
  btn.copy.addEventListener("click", copy);
  const close = () => { controller?.abort(); panel.hidden = true; };
  $(".close").addEventListener("click", close);
  $(".x").addEventListener("click", close);

  if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand("Calculate task scores", start);
})();
