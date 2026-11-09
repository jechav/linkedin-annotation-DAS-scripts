// ==UserScript==
// @name         AI Trainer payment audit
// @namespace    https://github.com/jechav/linkedin-annotation-DAS-scripts
// @version      0.2.0
// @description  Compares the tasks you did on LinkedIn AI Trainer with what Greenlight paid you, batch by batch.
// @match        https://www.linkedin.com/ai-trainer/*
// @match        https://portal.greenlight.ai/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @updateURL    https://raw.githubusercontent.com/jechav/linkedin-annotation-DAS-scripts/main/userscripts/payment_audit.user.js
// @downloadURL  https://raw.githubusercontent.com/jechav/linkedin-annotation-DAS-scripts/main/userscripts/payment_audit.user.js
// ==/UserScript==

/*
 * Unofficial. Calls LinkedIn's and Greenlight's internal, undocumented endpoints with your own
 * logged-in sessions. See the README.
 *
 * The two sites can't read each other's session, so the script works in two halves that share
 * Violentmonkey's storage (GM_setValue is per script, not per site):
 *   LinkedIn AI Trainer: lists your tasks (one request per 50 tasks) and saves how many you did
 *                        per batch. Runs by itself on page load, at most every 15 minutes.
 *   Greenlight portal:   the Audit button fetches your deliverables and compares them with
 *                        the saved LinkedIn counts, then fetches your wallet transactions and
 *                        compares what each week billed with what was actually credited.
 *
 * Core (no DOM) is exported for Node with module.exports, like task_scores.user.js.
 */
(function () {
  "use strict";

  // ======================= Core =======================

  const LI_BASE = "https://www.linkedin.com/ai-trainer/api/frontendAnnotationTaskResults";
  const GL_API = "https://app.greenlight.ai/ui";
  const RATE_PER_ATT = 65 / 3; // every deliverable so far pays $65.00 per 3 Att ($21.67 each)
  const TOLERANCE = 0.02; // dollars: rounding of 65/3
  const EXPIRED_CODES = [301, 302, 303, 307, 308, 401, 403]; // 3xx = bounced to the login page
  const DATE_FIELDS = ["submittedAt", "completedAt", "finishedAt", "endedAt", "createdAt", "startedAt", "lastModifiedAt"];
  const DAY_MS = 86400000;
  const SNAPSHOT_KEY = "linkedinSnapshot";
  const AUTO_SYNC_EVERY_MS = 15 * 60000;
  const STALE_AFTER_MS = DAY_MS;

  class HttpError extends Error {
    constructor(status) {
      super(`HTTP ${status}`);
      this.status = status;
    }
  }
  class ExpiredError extends Error {}

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const round2 = (x) => Math.round(x * 100) / 100;

  // ---------- LinkedIn: tasks per batch ----------

  function csrfToken(cookieString) {
    const m = /(?:^|;\s*)JSESSIONID="?([^";]+)/.exec(cookieString || "");
    return m ? m[1] : null;
  }

  /** GET a same-origin AI Trainer API URL with the page's session. */
  async function liGet(url) {
    const token = csrfToken(document.cookie);
    if (!token) throw new ExpiredError("JSESSIONID cookie not found. Are you signed in to LinkedIn?");
    const r = await fetch(url, {
      credentials: "include",
      redirect: "manual",
      headers: { accept: "application/json", "csrf-token": token, "x-restli-protocol-version": "2.0.0" },
    });
    if (r.type === "opaqueredirect" || EXPIRED_CODES.includes(r.status)) {
      throw new ExpiredError("LinkedIn session expired. Sign in to AI Trainer again.");
    }
    if (!r.ok) throw new HttpError(r.status);
    return r.json();
  }

  /** Every task result (all projects), paging like tasks_weeks.fetch_all. */
  async function fetchAllTasks(get, { count = 50 } = {}) {
    const items = [];
    const seen = new Set();
    let start = 0;
    for (;;) {
      let data;
      try {
        data = await get(`${LI_BASE}?q=annotator&start=${start}&count=${count}`);
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
      if (!els.length || !fresh.length || (total != null && items.length >= total)) return items;
      start += els.length;
    }
  }

  /** What the Greenlight side needs from LinkedIn: non-canceled task counts per batch. */
  function snapshotOf(items, now = Date.now()) {
    const done = items.filter((t) => t.state !== "CANCELED");
    const batches = new Map();
    for (const t of done) {
      const name = t.pipeline?.name || "(no batch)";
      const ms = DATE_FIELDS.map((f) => t[f]).find(isNum) ?? null;
      const b = batches.get(name) || { name, tasks: 0, last: null };
      b.tasks++;
      if (ms !== null && (b.last === null || ms > b.last)) b.last = ms;
      batches.set(name, b);
    }
    return { syncedAt: now, listed: items.length, canceled: items.length - done.length, batches: [...batches.values()] };
  }

  // ---------- Greenlight: deliverables ----------

  /** Token and member header the portal itself uses, read from its localStorage. */
  function glAuth(storage) {
    const token = storage.getItem("gl:a");
    let member = null;
    try {
      member = JSON.parse(storage.getItem("gl:m") || "null");
    } catch {}
    const org = member?.organization?.id;
    const role = member?.roleId;
    if (!token || !org || !role) throw new ExpiredError("Greenlight sign-in not found. Sign in to the portal and try again.");
    return {
      org,
      headers: { accept: "application/json", authorization: `Bearer ${token}`, "x-gl-member": btoa(`${org}|${role}`) },
    };
  }

  /** All your deliverables in one request (the endpoint accepts a range of years). */
  async function fetchDeliverables(storage, { start = "2024-01-01T00:00:00", now = Date.now() } = {}) {
    const { org, headers } = glAuth(storage);
    const end = new Date(now + 90 * DAY_MS).toISOString().slice(0, 10) + "T23:59:59";
    const url = `${GL_API}/suppliers/${encodeURIComponent(org)}/time?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const r = await fetch(url, { headers });
    if (r.status === 401 || r.status === 403) throw new ExpiredError("Greenlight session expired. Reload the page and try again.");
    if (!r.ok) throw new HttpError(r.status);
    const data = await r.json();
    const all = data.deliverables || [];
    const mine = data.userId ? all.filter((d) => !d.userId || d.userId === data.userId) : all;
    return { deliverables: mine, all, others: all.length - mine.length };
  }

  // ---------- Greenlight: wallet transactions (what was actually paid) ----------

  /** Every wallet transaction: Credit = a payment into the wallet, Debit = a transfer out to the bank. */
  async function fetchTransactions(storage, { pageSize = 100 } = {}) {
    const { org, headers } = glAuth(storage);
    const id = encodeURIComponent(org);
    const out = [];
    for (let page = 0; ; page++) {
      const url = `${GL_API}/suppliers/paymentpreferences/${id}/transactions?supplierId=${id}&pageSize=${pageSize}&page=${page}`;
      const r = await fetch(url, { headers });
      if (r.status === 401 || r.status === 403) throw new ExpiredError("Greenlight session expired. Reload the page and try again.");
      if (!r.ok) throw new HttpError(r.status);
      const data = await r.json();
      if (data.success === false) throw new Error(`Greenlight transactions: ${data.error?.message || data.error || "request failed"}`);
      const rows = data.data || [];
      out.push(...rows);
      if (!rows.length || out.length >= (data.total ?? 0) || rows.length < pageSize) return out;
    }
  }

  // "Payment for 2026-10-19 to 2026-10-25"
  const PAYMENT_FOR_RE = /payment for\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i;

  function parseTransaction(t) {
    const m = PAYMENT_FOR_RE.exec(t.description || "");
    return {
      id: t.id,
      date: String(t.transactionDate || t.createdAt || "").slice(0, 10),
      amount: Number(t.amount) || 0,
      credit: String(t.transactionType).toLowerCase() === "credit",
      description: String(t.description || ""),
      week: m ? { from: m[1], to: m[2] } : null,
    };
  }

  /** "2026-10-22" -> "2026-10-19", the Monday of its week (Greenlight pays Monday to Sunday). */
  function mondayOf(day) {
    const ms = Date.parse(`${day}T00:00:00Z`);
    if (!isNum(ms)) return null;
    const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
    return new Date(ms - dow * DAY_MS).toISOString().slice(0, 10);
  }

  /**
   * Compare what deliverables billed, week by week, with the "Payment for <from> to <to>"
   * credits in the wallet. Pure. diff = credited - billed; negative means not (fully) paid yet.
   */
  function reconcilePayouts(rawDeliverables, rawTransactions) {
    const deliverables = rawDeliverables.map(parseDeliverable);
    const txs = rawTransactions.map(parseTransaction).sort((a, b) => b.date.localeCompare(a.date));
    const credits = txs.filter((t) => t.credit);
    const debits = txs.filter((t) => !t.credit);

    const weeks = new Map();
    const week = (from, to) => {
      if (!weeks.has(from)) weeks.set(from, { from, to: to || null, billed: 0, credited: 0, deliverables: 0, statuses: new Set(), paidOn: new Set() });
      const w = weeks.get(from);
      if (to && !w.to) w.to = to;
      return w;
    };
    for (const c of credits) {
      if (!c.week) continue;
      const w = week(c.week.from, c.week.to);
      w.credited += c.amount;
      w.paidOn.add(c.date);
    }
    // a deliverable goes in the paid week that contains its date, else in its Monday-to-Sunday week
    const ranges = [...weeks.values()].filter((w) => w.to);
    for (const d of deliverables) {
      if (!d.date || !d.amount) continue;
      const hit = ranges.find((w) => w.from <= d.date && d.date <= w.to);
      const from = hit ? hit.from : mondayOf(d.date);
      if (!from) continue;
      const w = week(from, hit ? hit.to : new Date(Date.parse(`${from}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10));
      w.billed += d.amount;
      w.deliverables++;
      w.statuses.add(d.status);
    }

    const rows = [...weeks.values()]
      .map((w) => {
        const billed = round2(w.billed), credited = round2(w.credited), diff = round2(credited - billed);
        const state = Math.abs(diff) <= TOLERANCE ? "paid" : credited === 0 ? "unpaid" : diff < 0 ? "short" : "over";
        return { from: w.from, to: w.to, billed, credited, diff, state, deliverables: w.deliverables, statuses: [...w.statuses].sort(), paidOn: [...w.paidOn].sort() };
      })
      .sort((a, b) => b.from.localeCompare(a.from));

    const sum = (xs) => round2(xs.reduce((s, x) => s + x.amount, 0));
    const credited = sum(credits);
    const withdrawn = sum(debits);
    const billed = round2(deliverables.reduce((s, d) => s + d.amount, 0));
    return {
      rows,
      transactions: txs,
      otherCredits: credits.filter((c) => !c.week),
      totals: {
        billed,
        credited,
        withdrawn,
        balance: round2(credited - withdrawn),
        pending: round2(billed - credited),
        payments: credits.length,
        transfers: debits.length,
        unpaidWeeks: rows.filter((r) => r.state === "unpaid").length,
        shortWeeks: rows.filter((r) => r.state === "short").length,
        overWeeks: rows.filter((r) => r.state === "over").length,
      },
    };
  }

  // ---------- reading a deliverable's notes ----------

  // "<batch>- Att: 3, Rev: 0", the first one prefixed with "UI Berry 3R: "
  const LINE_RE = /^(.*?)\s*-\s*Att:\s*(\d+),\s*Rev:\s*(\d+)\s*$/i;
  const PROJECT_PREFIX_RE = /^[^:]{1,40}:\s+/;
  const CORRECTION_RE =
    /^Correction for incorrect payment in batch (.+?)\s*\(Paid:\s*(\d+)\s*Att,\s*(\d+)\s*Rev\s*\|\s*Actual:\s*(\d+)\s*Att,\s*(\d+)\s*Rev\s*\)/i;
  const DEDUCTION_RE = /Correction applied[^:]*:\s*-?\$\s*([\d,]+(?:\.\d+)?)/i;

  function parseDeliverable(d) {
    const notes = String(d.notes || "").replace(/^[^|;]*\|/, ""); // "UIBerry-COD-FO-52|..." engagement tag
    const out = {
      id: d.id,
      date: String(d.date || "").slice(0, 10),
      status: d.status,
      amount: Number(d.amount) || 0,
      lines: [],
      corrections: [],
      deducted: 0,
      unparsed: [],
    };
    for (const raw of notes.split(";")) {
      const seg = raw.trim();
      if (!seg) continue;
      let m;
      if ((m = CORRECTION_RE.exec(seg))) {
        out.corrections.push({ batch: m[1].trim(), paidAtt: +m[2], paidRev: +m[3], actualAtt: +m[4], actualRev: +m[5] });
      } else if ((m = DEDUCTION_RE.exec(seg))) {
        out.deducted += Number(m[1].replace(/,/g, ""));
      } else if ((m = LINE_RE.exec(seg))) {
        out.lines.push({ batch: m[1].replace(PROJECT_PREFIX_RE, "").trim(), att: +m[2], rev: +m[3] });
      } else {
        out.unparsed.push(seg);
      }
    }
    return out;
  }

  // ---------- matching batch names ----------

  // LinkedIn adds " Aesthetics/Functionality/Overall Preference <date>" and cuts names at 100 chars
  const SUFFIX_RE = /\s*aesthetics\s*\/\s*functionality\s*\/\s*overall\s*preference\b.*$/i;
  const MIN_PREFIX = 12; // normalized chars both names must share before a prefix counts

  /** Comparable form of a batch name: no leading "H ", no LinkedIn suffix, only [a-z0-9]. */
  function norm(name) {
    return String(name).trim().replace(/^h\s+/i, "").replace(SUFFIX_RE, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  /** "Webapp ... - S930 - Set BA - 2026-11-05" -> "ba|2026-11-05" (short code before the date). */
  function codeKey(name) {
    const parts = String(name).split(/\s+-\s+/).map((s) => s.trim());
    const i = parts.findIndex((p) => /^\d{4}-\d{2}-\d{2}$/.test(p));
    if (i < 1) return null;
    const m = /^(?:set\s+)?([a-z0-9]{1,6})$/i.exec(parts[i - 1]);
    return m ? `${m[1].toLowerCase()}|${parts[i]}` : null;
  }

  // ---------- the audit ----------

  /**
   * Compare the LinkedIn snapshot with Greenlight deliverables. Pure: no network, no DOM.
   * diff = Att paid (net of corrections) - tasks done; negative means underpaid.
   */
  function reconcile(snapshot, rawDeliverables, { rate = RATE_PER_ATT } = {}) {
    const deliverables = rawDeliverables.map(parseDeliverable);

    // Greenlight, per batch
    const gl = new Map();
    const glBatch = (name) => {
      const key = norm(name);
      if (!gl.has(key)) gl.set(key, { key, name, att: 0, rev: 0, statuses: new Set(), dates: new Set(), corrected: false, duplicates: [] });
      return gl.get(key);
    };
    for (const d of deliverables) {
      for (const l of d.lines) {
        const b = glBatch(l.batch);
        b.att += l.att;
        b.rev += l.rev;
        if (l.att || l.rev) {
          b.statuses.add(d.status);
          b.dates.add(d.date);
        }
      }
      for (const c of d.corrections) {
        const b = glBatch(c.batch);
        b.att += c.actualAtt - c.paidAtt;
        b.rev += c.actualRev - c.paidRev;
        b.corrected = true;
        b.dates.add(d.date);
      }
    }
    gl.delete("");

    // the same lines and amount in two deliverables: likely paid twice
    const fingerprints = new Map();
    for (const d of deliverables) {
      if (!d.lines.some((l) => l.att || l.rev)) continue;
      const fp = JSON.stringify([d.amount, d.lines.map((l) => [norm(l.batch), l.att, l.rev]).sort(), d.corrections]);
      (fingerprints.get(fp) || fingerprints.set(fp, []).get(fp)).push(d);
    }
    const duplicates = [...fingerprints.values()].filter((g) => g.length > 1);
    for (const group of duplicates) {
      for (const l of group[0].lines) {
        if (l.att || l.rev) gl.get(norm(l.batch))?.duplicates.push(group.map((d) => d.date));
      }
    }

    // each deliverable's amount should be its Att x rate, minus any deduction
    const amountMismatches = [];
    const amountUnchecked = [];
    for (const d of deliverables) {
      const att = d.lines.reduce((s, l) => s + l.att, 0);
      const rev = d.lines.reduce((s, l) => s + l.rev, 0);
      if (rev) {
        amountUnchecked.push(d); // no known rate for reviews
        continue;
      }
      const expected = round2(round2(att * rate) - d.deducted);
      if (Math.abs(d.amount - expected) > TOLERANCE) amountMismatches.push({ id: d.id, date: d.date, att, deducted: d.deducted, amount: d.amount, expected });
    }

    // match every LinkedIn batch to one Greenlight batch: exact name, then prefix, then code + date
    const glKeys = [...gl.keys()];
    const byCode = new Map();
    for (const b of gl.values()) {
      const c = codeKey(b.name);
      if (c) (byCode.get(c) || byCode.set(c, []).get(c)).push(b.key);
    }
    const candidates = (name) => {
      const k = norm(name);
      if (gl.has(k)) return { how: "name", keys: [k] };
      const prefix = glKeys.filter((g) => Math.min(g.length, k.length) >= MIN_PREFIX && (k.startsWith(g) || g.startsWith(k)));
      if (prefix.length) return { how: "prefix", keys: prefix };
      const c = codeKey(name);
      return { how: "code", keys: (c && byCode.get(c)) || [] };
    };

    const rows = new Map();
    const notBilled = [];
    for (const li of snapshot.batches) {
      const { how, keys } = candidates(li.name);
      if (!keys.length) {
        notBilled.push(li);
        continue;
      }
      const [pick, ...others] = [...keys].sort((a, b) => b.length - a.length); // most specific name wins
      const row = rows.get(pick) || { gl: gl.get(pick), li: [], tasks: 0, how: new Set(), ambiguous: new Set() };
      row.li.push(li);
      row.tasks += li.tasks;
      row.how.add(how);
      others.forEach((k) => row.ambiguous.add(gl.get(k).name));
      rows.set(pick, row);
    }

    const out = [...rows.values()].map((r) => ({
      name: r.gl.name,
      linkedinNames: r.li.map((l) => l.name),
      tasks: r.tasks,
      att: r.gl.att,
      rev: r.gl.rev,
      diff: r.gl.att - r.tasks,
      statuses: [...r.gl.statuses].sort(),
      dates: [...r.gl.dates].sort(),
      corrected: r.gl.corrected,
      duplicates: r.gl.duplicates,
      how: [...r.how],
      ambiguous: [...r.ambiguous],
    }));
    const rank = (r) => (r.diff < 0 ? 0 : r.diff > 0 ? 1 : 2);
    out.sort((a, b) => rank(a) - rank(b) || Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name));

    const matchedKeys = new Set(rows.keys());
    const unmatched = [...gl.values()]
      .filter((b) => !matchedKeys.has(b.key) && (b.att || b.rev))
      .map((b) => ({ name: b.name, att: b.att, rev: b.rev, dates: [...b.dates].sort(), statuses: [...b.statuses].sort(), duplicates: b.duplicates }));
    notBilled.sort((a, b) => (b.last || 0) - (a.last || 0));

    const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
    const tasksAll = sum(snapshot.batches, (b) => b.tasks);
    const tasksNotBilled = sum(notBilled, (b) => b.tasks);
    return {
      rate,
      rows: out,
      unmatched,
      notBilled,
      duplicates: duplicates.map((g) => ({ dates: g.map((d) => d.date), amount: g[0].amount, batches: g[0].lines.filter((l) => l.att || l.rev).map((l) => l.batch) })),
      amountMismatches,
      amountUnchecked: amountUnchecked.map((d) => ({ id: d.id, date: d.date, amount: d.amount })),
      unparsed: deliverables.flatMap((d) => d.unparsed.map((text) => ({ date: d.date, text }))),
      showStatus: deliverables.some((d) => d.status !== 4),
      showRev: out.some((r) => r.rev !== 0),
      totals: {
        deliverables: deliverables.length,
        paidAmount: round2(sum(deliverables, (d) => d.amount)),
        paidAtt: sum([...gl.values()], (b) => b.att),
        tasksAll,
        tasksMatched: tasksAll - tasksNotBilled,
        tasksNotBilled,
        attMatched: sum(out, (r) => r.att),
        under: out.filter((r) => r.diff < 0).length,
        over: out.filter((r) => r.diff > 0).length,
        ok: out.filter((r) => r.diff === 0).length,
      },
    };
  }

  // ---------- text ----------

  const money = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  const dayOf = (ms) => (isNum(ms) ? new Date(ms).toISOString().slice(0, 10) : "-");

  function ago(ms, now = Date.now()) {
    const min = Math.round((now - ms) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }

  /** Flags shown next to a row, as plain strings. */
  function flagsOf(r) {
    const f = [];
    if (r.duplicates.length) f.push(`possible duplicate payment (${r.duplicates.map((ds) => ds.join(" & ")).join("; ")})`);
    if (r.corrected) f.push("corrected");
    if (r.ambiguous?.length) f.push(`ambiguous, also matches: ${r.ambiguous.join(" | ")}`);
    if (r.how && !r.how.includes("name")) f.push(`matched by ${r.how.join("+")}: ${r.linkedinNames.join(" | ")}`);
    return f;
  }

  /** Plain-text report, for "Copy as text". */
  function formatText(res, { snapshot, payouts, payoutsError, now = Date.now() } = {}) {
    const t = res.totals;
    const L = [];
    if (snapshot) L.push(`LinkedIn synced ${ago(snapshot.syncedAt, now)} (${snapshot.listed} tasks, ${snapshot.canceled} canceled)`);
    L.push(`Greenlight: ${t.deliverables} deliverables, ${money(t.paidAmount)} billed, ${t.paidAtt} Att net`);
    L.push(`Matched batches: ${t.tasksMatched} tasks done vs ${t.attMatched} Att paid (${signed(t.attMatched - t.tasksMatched)}, ${money((t.attMatched - t.tasksMatched) * res.rate)})`);
    L.push(`${t.under} underpaid, ${t.over} overpaid, ${t.ok} ok · rate ${money(res.rate)} per Att`);
    const pad = (s, n) => String(s).padStart(n);
    const head = "tasks".padStart(6) + pad("paid", 6) + pad("diff", 6) + pad("$diff", 9) + (res.showRev ? pad("rev", 5) : "") + (res.showStatus ? pad("status", 8) : "") + "  batch";
    L.push("", head);
    for (const r of res.rows) {
      L.push(
        pad(r.tasks, 6) + pad(r.att, 6) + pad(signed(r.diff), 6) + pad(money(r.diff * res.rate), 9) +
          (res.showRev ? pad(r.rev, 5) : "") + (res.showStatus ? pad(r.statuses.join(",") || "-", 8) : "") + "  " + r.name,
      );
      for (const f of flagsOf(r)) L.push(" ".repeat(29) + "! " + f);
    }
    if (res.notBilled.length) {
      L.push("", `Not billed yet: ${t.tasksNotBilled} tasks in ${res.notBilled.length} batches`);
      for (const b of res.notBilled) L.push(`${pad(b.tasks, 6)}  last ${dayOf(b.last)}  ${b.name}`);
    }
    if (res.unmatched.length) {
      L.push("", "Paid on Greenlight, no LinkedIn batch found:");
      for (const u of res.unmatched) L.push(`${pad(u.att, 6)} Att  ${u.dates.join(", ")}  ${u.name}`);
    }
    if (res.amountMismatches.length) {
      L.push("", "Deliverable amounts that don't match their Att:");
      for (const m of res.amountMismatches) L.push(`  ${m.date}  paid ${money(m.amount)}, expected ${money(m.expected)} (${m.att} Att${m.deducted ? `, -${money(m.deducted)} deducted` : ""})`);
    }
    if (res.amountUnchecked.length) L.push("", `${res.amountUnchecked.length} deliverables with reviews were not amount-checked (no review rate known)`);
    if (res.unparsed.length) {
      L.push("", "Note parts the script could not read:");
      for (const u of res.unparsed) L.push(`  ${u.date}  ${u.text}`);
    }
    if (payouts) L.push("", formatPayoutsText(payouts));
    else if (payoutsError) L.push("", `Actually paid: could not load wallet transactions (${payoutsError})`);
    return L.join("\n");
  }

  const STATE_LABEL = { paid: "paid", unpaid: "not paid yet", short: "paid short", over: "paid extra" };

  /** The "actually paid" part of the plain-text report. */
  function formatPayoutsText(p) {
    const t = p.totals;
    const pad = (s, n) => String(s).padStart(n);
    const L = [
      "Actually paid (Greenlight wallet):",
      `  ${money(t.credited)} credited in ${t.payments} payments · ${money(t.withdrawn)} transferred to your bank in ${t.transfers} · balance ${money(t.balance)}`,
      `  ${money(t.billed)} billed in deliverables · ${money(t.pending)} ${t.pending >= 0 ? "not paid yet" : "paid beyond deliverables"}`,
      "",
      "week".padEnd(25) + pad("billed", 10) + pad("credited", 10) + pad("diff", 10) + "  state / paid on",
    ];
    for (const r of p.rows) {
      L.push(`${r.from} to ${r.to || "?"}`.padEnd(25) + pad(money(r.billed), 10) + pad(money(r.credited), 10) + pad(money(r.diff), 10) +
        `  ${STATE_LABEL[r.state]}${r.paidOn.length ? ` (${r.paidOn.join(", ")})` : ""}`);
    }
    if (p.otherCredits.length) {
      L.push("", "Credits without a week:");
      for (const c of p.otherCredits) L.push(`  ${c.date}  ${money(c.amount)}  ${c.description}`);
    }
    L.push("", "Transactions:");
    for (const x of p.transactions) L.push(`  ${x.date}  ${x.credit ? "+" : "-"}${money(x.amount).padStart(9)}  ${x.description}`);
    return L.join("\n");
  }

  const Core = {
    RATE_PER_ATT, csrfToken, fetchAllTasks, snapshotOf, glAuth, fetchDeliverables, parseDeliverable,
    norm, codeKey, reconcile, formatText, flagsOf, ago, HttpError, ExpiredError,
    fetchTransactions, parseTransaction, mondayOf, reconcilePayouts, formatPayoutsText,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = Core;
    return;
  }

  // ======================= Shared UI bits =======================

  const store = {
    get: (k) => (typeof GM_getValue === "function" ? GM_getValue(k, null) : null),
    set: (k, v) => typeof GM_setValue === "function" && GM_setValue(k, v),
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const BASE_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      --bg: #ffffff; --fg: #1d2226; --muted: #5e6a75; --line: #dfe3e8; --accent: #0a66c2; --accent-fg: #ffffff;
      --warn-bg: #fff4e5; --warn-fg: #8a4b00; --err-bg: #fdecec; --err-fg: #a4000f; --ok-fg: #057642;
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg);
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --bg: #1d2226; --fg: #e9ecef; --muted: #a2adb8; --line: #38434f; --accent: #70b5f9; --accent-fg: #0b1117;
        --warn-bg: #3b2a10; --warn-fg: #f5c37a; --err-bg: #3d1518; --err-fg: #ff9a9f; --ok-fg: #7fd1a7;
      }
    }
  `;

  /** A shadow-DOM host that survives React/SPA re-renders (see task_scores.user.js). */
  function mountHost(id, html) {
    const host = document.createElement("div");
    host.id = id;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    const attach = () => { if (!host.isConnected && document.body) document.body.appendChild(host); };
    const watch = () => { setTimeout(attach, 1500); setInterval(attach, 1000); };
    if (document.readyState === "complete") watch();
    else window.addEventListener("load", watch, { once: true });
    return root;
  }

  // ======================= LinkedIn: sync =======================

  function linkedinSide() {
    const root = mountHost(
      "ai-trainer-payment-audit-sync",
      `<style>${BASE_CSS}
        .toast { position: fixed; left: 20px; bottom: 20px; z-index: 2147483646; max-width: 360px; padding: 8px 12px;
          border-radius: 8px; background: var(--bg); color: var(--fg); border: 1px solid var(--line);
          box-shadow: 0 4px 16px rgba(0,0,0,.2); font-size: 13px; }
        .toast.err { background: var(--err-bg); color: var(--err-fg); }
        .toast[hidden] { display: none; }
      </style><div class="wrap"><div class="toast" hidden></div></div>`,
    );
    const toast = root.querySelector(".toast");
    let hideTimer = null;
    const show = (msg, isErr) => {
      toast.textContent = msg;
      toast.className = `toast${isErr ? " err" : ""}`;
      toast.hidden = false;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => (toast.hidden = true), isErr ? 10000 : 4000);
    };

    let running = false;
    async function sync({ manual }) {
      if (running) return;
      const prev = store.get(SNAPSHOT_KEY);
      if (!manual && prev && Date.now() - prev.syncedAt < AUTO_SYNC_EVERY_MS) return;
      running = true;
      if (manual) show("Payment audit: syncing your tasks…");
      try {
        const snap = snapshotOf(await fetchAllTasks(liGet));
        store.set(SNAPSHOT_KEY, snap);
        if (manual) show(`Payment audit: synced ${snap.listed - snap.canceled} tasks in ${snap.batches.length} batches.`);
      } catch (e) {
        show(`Payment audit: sync failed. ${e.message || e}`, true);
      } finally {
        running = false;
      }
    }

    const auto = () => setTimeout(() => sync({ manual: false }), 3000);
    if (document.readyState === "complete") auto();
    else window.addEventListener("load", auto, { once: true });
    if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand("Sync tasks for payment audit", () => sync({ manual: true }));
  }

  // ======================= Greenlight: audit panel =======================

  function greenlightSide() {
    const root = mountHost(
      "greenlight-payment-audit",
      `<style>${BASE_CSS}
        .fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; background: var(--accent); color: var(--accent-fg);
          border: 0; border-radius: 20px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer;
          box-shadow: 0 2px 8px rgba(0,0,0,.25); }
        .panel { position: fixed; right: 20px; bottom: 68px; z-index: 2147483647; width: min(760px, calc(100vw - 32px));
          max-height: calc(100vh - 100px); overflow: auto; background: var(--bg); color: var(--fg);
          border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.28); padding: 14px 16px; }
        .panel[hidden] { display: none; }
        header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        h2 { font-size: 15px; margin: 0; }
        h3 { font-size: 13px; margin: 14px 0 4px; }
        .x { background: none; border: 0; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; }
        .muted { color: var(--muted); font-size: 12px; }
        .note { border-radius: 6px; padding: 6px 8px; margin: 8px 0; font-size: 13px; }
        .warn { background: var(--warn-bg); color: var(--warn-fg); }
        .err { background: var(--err-bg); color: var(--err-fg); }
        .neg { color: var(--err-fg); font-weight: 600; }
        .pos { color: var(--warn-fg); font-weight: 600; }
        .ok { color: var(--ok-fg); }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 13px; font-variant-numeric: tabular-nums; }
        th, td { padding: 4px 6px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; vertical-align: top; }
        th.l, td.l { text-align: left; white-space: normal; }
        th { color: var(--muted); font-weight: 600; }
        td.l .name { display: block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        td.l .flag { display: block; font-size: 12px; color: var(--warn-fg); white-space: normal; }
        tr.match[hidden], tr.tx[hidden] { display: none; }
        .linkbtn { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; font-size: 12px; cursor: pointer; margin-top: 6px; }
        .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
        .actions button { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 16px; cursor: pointer;
          border: 1px solid var(--accent); background: transparent; color: var(--accent); }
        .actions button.primary { background: var(--accent); color: var(--accent-fg); }
        .actions button[hidden] { display: none; }
      </style>
      <div class="wrap">
        <button class="fab" title="Compare Greenlight payments with your AI Trainer tasks">Audit</button>
        <section class="panel" hidden role="dialog" aria-label="Payment audit">
          <header><h2>Payment audit</h2><button class="x" aria-label="Close">×</button></header>
          <div class="body"></div>
          <div class="actions">
            <button class="refresh primary">Refresh</button>
            <button class="copy" hidden>Copy as text</button>
            <button class="close">Close</button>
          </div>
        </section>
      </div>`,
    );
    const $ = (s) => root.querySelector(s);
    const panel = $(".panel"), body = $(".body"), copyBtn = $(".copy");
    let busy = false;
    let lastText = "";

    const cell = (r, res) => {
      const cls = r.diff < 0 ? "neg" : r.diff > 0 ? "pos" : "ok";
      const flags = flagsOf(r).map((f) => `<span class="flag">⚠ ${esc(f)}</span>`).join("");
      return `<tr class="${r.diff === 0 ? "match" : ""}"${r.diff === 0 ? " hidden" : ""}>
        <td class="l"><span class="name" title="${esc(r.name)}">${esc(r.name)}</span>${flags}</td>
        <td>${r.tasks}</td><td>${r.att}</td><td class="${cls}">${signed(r.diff)}</td><td class="${cls}">${money(r.diff * res.rate)}</td>
        ${res.showRev ? `<td>${r.rev}</td>` : ""}${res.showStatus ? `<td>${esc(r.statuses.join(",") || "-")}</td>` : ""}</tr>`;
    };

    function payoutsHtml(p, error) {
      if (!p) return `<h3>Actually paid</h3><div class="note warn">Could not load your Greenlight wallet transactions: ${esc(error || "unknown error")}. The batch audit above doesn't depend on them.</div>`;
      const t = p.totals;
      const cls = (x) => (Math.abs(x) <= 0.02 ? "ok" : x < 0 ? "neg" : "pos");
      const stateCls = { paid: "ok", unpaid: "pos", short: "neg", over: "pos" };
      const rows = p.rows
        .map((r) => `<tr><td class="l">${r.from} to ${r.to || "?"}</td><td>${r.deliverables}</td><td>${money(r.billed)}</td><td>${money(r.credited)}</td>
          <td class="${cls(r.diff)}">${money(r.diff)}</td><td class="l"><span class="${stateCls[r.state]}">${STATE_LABEL[r.state]}</span>${r.paidOn.length ? ` <span class="muted">${esc(r.paidOn.join(", "))}</span>` : ""}</td></tr>`)
        .join("");
      const txRows = p.transactions
        .map((x) => `<tr class="tx" hidden><td class="l">${x.date}</td><td class="${x.credit ? "ok" : ""}">${x.credit ? "+" : "-"}${money(x.amount)}</td><td class="l">${esc(x.description)}</td></tr>`)
        .join("");
      const other = p.otherCredits.length
        ? `<div class="note warn">${p.otherCredits.length} credit${p.otherCredits.length > 1 ? "s" : ""} without a "Payment for … to …" week: ${esc(p.otherCredits.map((c) => `${c.date} ${money(c.amount)} "${c.description}"`).join("; "))}</div>`
        : "";
      return `<h3>Actually paid (Greenlight wallet)</h3>
        <div><b>${money(t.credited)}</b> credited in ${t.payments} payments · ${money(t.withdrawn)} transferred to your bank · balance <b>${money(t.balance)}</b></div>
        <div>${money(t.billed)} billed in deliverables ·
          <span class="${t.pending > 0.02 ? "pos" : t.pending < -0.02 ? "neg" : "ok"}">${money(Math.abs(t.pending))} ${t.pending >= 0 ? "not paid yet" : "paid beyond deliverables"}</span></div>
        <div class="muted">${t.unpaidWeeks} weeks not paid yet · ${t.shortWeeks} paid short · ${t.overWeeks} paid extra · deliverables go in the paid week that contains their date</div>
        ${p.rows.length ? `<table><thead><tr><th class="l">week</th><th>deliv.</th><th>billed</th><th>credited</th><th>diff</th><th class="l">state · paid on</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
        ${other}
        ${p.transactions.length ? `<button class="linkbtn txtoggle">Show ${p.transactions.length} transactions</button>
          <table><tbody>${txRows}</tbody></table>` : `<div class="muted">No wallet transactions yet.</div>`}`;
    }

    function render(res, snap, others, payouts, payoutsError) {
      const t = res.totals;
      const notes = [];
      const age = Date.now() - snap.syncedAt;
      notes.push([age > STALE_AFTER_MS ? "warn" : "", `LinkedIn synced ${ago(snap.syncedAt)} · ${snap.listed - snap.canceled} tasks (${snap.canceled} canceled left out)` +
        (age > STALE_AFTER_MS ? ". Open an AI Trainer page to refresh it." : "")]);
      if (others) notes.push(["warn", `${others} deliverables belong to other people in this organization and were left out.`]);
      const dup = res.rows.filter((r) => r.duplicates.length).length + res.unmatched.filter((u) => u.duplicates.length).length;
      if (dup) notes.push(["err", `${dup} batch${dup > 1 ? "es look" : " looks"} paid twice: the same deliverable appears on two dates.`]);

      const summary = `<div>Greenlight: <b>${t.deliverables}</b> deliverables, <b>${money(t.paidAmount)}</b> billed, ${t.paidAtt} Att net${
        payouts ? ` · <b>${money(payouts.totals.credited)}</b> actually paid` : ""}</div>
        <div>Matched batches: ${t.tasksMatched} tasks done vs ${t.attMatched} Att paid
          (<span class="${t.attMatched < t.tasksMatched ? "neg" : t.attMatched > t.tasksMatched ? "pos" : "ok"}">${signed(t.attMatched - t.tasksMatched)}, ${money((t.attMatched - t.tasksMatched) * res.rate)}</span>)</div>
        <div class="muted">${t.under} underpaid · ${t.over} overpaid · ${t.ok} ok · ${money(res.rate)} per Att</div>`;

      const head = `<tr><th class="l">batch</th><th>tasks</th><th>paid Att</th><th>diff</th><th>$ diff</th>${res.showRev ? "<th>rev</th>" : ""}${res.showStatus ? "<th>status</th>" : ""}</tr>`;
      const shownRows = res.rows.filter((r) => r.diff !== 0).length;
      const table = res.rows.length
        ? `<table><thead>${head}</thead><tbody>${res.rows.map((r) => cell(r, res)).join("")}</tbody></table>
           ${shownRows === 0 ? `<div class="muted ok">Every matched batch was paid exactly.</div>` : ""}
           ${t.ok ? `<button class="linkbtn toggle">Show ${t.ok} matching batches</button>` : ""}`
        : `<div class="muted">No LinkedIn batch matched a Greenlight line.</div>`;

      const notBilled = res.notBilled.length
        ? `<h3>Not billed yet: ${t.tasksNotBilled} tasks in ${res.notBilled.length} batches</h3><table><thead><tr><th class="l">batch</th><th>tasks</th><th>last task</th></tr></thead><tbody>${res.notBilled
            .map((b) => `<tr><td class="l"><span class="name" title="${esc(b.name)}">${esc(b.name)}</span></td><td>${b.tasks}</td><td>${dayOf(b.last)}</td></tr>`).join("")}</tbody></table>`
        : "";
      const unmatched = res.unmatched.length
        ? `<h3>Paid on Greenlight, no LinkedIn batch found</h3><table><thead><tr><th class="l">batch</th><th>Att</th><th>dates</th></tr></thead><tbody>${res.unmatched
            .map((u) => `<tr><td class="l"><span class="name" title="${esc(u.name)}">${esc(u.name)}</span>${u.duplicates.length ? `<span class="flag">⚠ possible duplicate payment</span>` : ""}</td><td>${u.att}</td><td>${esc(u.dates.join(", "))}</td></tr>`).join("")}</tbody></table>`
        : "";
      const amounts = res.amountMismatches.length
        ? `<h3>Deliverable amounts that don't match their Att</h3><table><thead><tr><th class="l">date</th><th>Att</th><th>deducted</th><th>paid</th><th>expected</th></tr></thead><tbody>${res.amountMismatches
            .map((m) => `<tr><td class="l">${m.date}</td><td>${m.att}</td><td>${m.deducted ? money(m.deducted) : "-"}</td><td class="neg">${money(m.amount)}</td><td>${money(m.expected)}</td></tr>`).join("")}</tbody></table>`
        : "";
      const extra = [
        res.amountUnchecked.length ? `${res.amountUnchecked.length} deliverables with reviews were not amount-checked (no review rate known).` : "",
        res.unparsed.length ? `Could not read: ${res.unparsed.map((u) => `${u.date} "${u.text}"`).join("; ")}` : "",
      ].filter(Boolean).map((m) => `<div class="note warn">${esc(m)}</div>`).join("");

      body.innerHTML =
        notes.map(([cls, m]) => `<div class="${cls ? `note ${cls}` : "muted"}">${esc(m)}</div>`).join("") +
        summary + table + payoutsHtml(payouts, payoutsError) + notBilled + unmatched + amounts + extra;
      const toggle = root.querySelector(".toggle");
      toggle?.addEventListener("click", () => {
        const rows = root.querySelectorAll("tr.match");
        const hide = !rows[0]?.hidden;
        rows.forEach((tr) => (tr.hidden = hide));
        toggle.textContent = `${hide ? "Show" : "Hide"} ${t.ok} matching batches`;
      });
      const txToggle = root.querySelector(".txtoggle");
      txToggle?.addEventListener("click", () => {
        const rows = root.querySelectorAll("tr.tx");
        const hide = !rows[0]?.hidden;
        rows.forEach((tr) => (tr.hidden = hide));
        txToggle.textContent = `${hide ? "Show" : "Hide"} ${rows.length} transactions`;
      });
      lastText = formatText(res, { snapshot: snap, payouts, payoutsError });
    }

    async function start() {
      if (busy) return;
      busy = true;
      panel.hidden = false;
      copyBtn.hidden = true;
      lastText = "";
      body.innerHTML = `<div class="muted">fetching deliverables…</div>`;
      try {
        const snap = store.get(SNAPSHOT_KEY);
        if (!snap) {
          body.innerHTML = `<div class="note warn">No LinkedIn tasks saved yet. Open any AI Trainer page on linkedin.com while signed in (the script syncs by itself), then click Refresh.</div>`;
          return;
        }
        // the wallet is optional: if it fails, the batch audit still shows
        const [{ deliverables, all, others }, txs] = await Promise.all([
          fetchDeliverables(localStorage),
          fetchTransactions(localStorage).then((v) => ({ v }), (e) => ({ e })),
        ]);
        if (txs.e instanceof ExpiredError) throw txs.e;
        // the wallet belongs to the supplier organization, so compare it with every deliverable in it
        const payouts = txs.v ? reconcilePayouts(all, txs.v) : null;
        render(reconcile(snap, deliverables), snap, others, payouts, txs.e && (txs.e.message || String(txs.e)));
        copyBtn.hidden = false;
      } catch (e) {
        body.innerHTML = `<div class="note err">${esc(e.message || String(e))}</div>`;
      } finally {
        busy = false;
      }
    }

    async function copy() {
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(lastText, "text");
        else await navigator.clipboard.writeText(lastText);
        copyBtn.textContent = "Copied";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => (copyBtn.textContent = "Copy as text"), 1500);
    }

    $(".fab").addEventListener("click", () => {
      if (!panel.hidden && !busy) panel.hidden = true;
      else if (panel.hidden && lastText) panel.hidden = false;
      else start();
    });
    $(".refresh").addEventListener("click", start);
    copyBtn.addEventListener("click", copy);
    const close = () => (panel.hidden = true);
    $(".close").addEventListener("click", close);
    $(".x").addEventListener("click", close);
    if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand("Audit Greenlight payments", start);
  }

  if (location.hostname === "www.linkedin.com") linkedinSide();
  else if (location.hostname === "portal.greenlight.ai") greenlightSide();
})();
