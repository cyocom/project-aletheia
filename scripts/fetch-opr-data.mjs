/**
 * Fetches 2026 FRC teams and each team's highest OPR across official season events only (TBA),
 * plus latest-event trimmed OPR (per-team refit, residual row choice) from qual match scores.
 * Requires: TBA_AUTH_KEY from https://www.thebluealliance.com/account
 * Run: npm run fetch-data
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "teams-opr-2026.json");

const BASE = "https://www.thebluealliance.com/api/v3";
const YEAR = 2026;
const MIN_INTERVAL_MS = 150;
const RIDGE = 1e-6;
const ROWS_TO_DROP = 3;

/**
 * TBA `event_type` values that count as FIRST season play (not preseason/offseason).
 * @see https://github.com/the-blue-alliance/the-blue-alliance/blob/main/src/backend/common/consts/event_type.py
 */
const OFFICIAL_SEASON_EVENT_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
// 0 REGIONAL, 1 DISTRICT, 2 DISTRICT_CMP, 3 CMP_DIVISION, 4 CMP_FINALS,
// 5 DISTRICT_CMP_DIVISION, 6 FOC, 7 REMOTE — excludes 99 OFFSEASON, 100 PRESEASON, -1 UNLABLED

const key = process.env.TBA_AUTH_KEY?.trim();
if (!key) {
  console.error("Missing TBA_AUTH_KEY. Create a key at https://www.thebluealliance.com/account");
  console.error("PowerShell: $env:TBA_AUTH_KEY='your_key'; npm run fetch-data");
  process.exit(1);
}

let lastReq = 0;
async function throttle() {
  const now = Date.now();
  const wait = lastReq + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
}

async function tba(apiPath) {
  await throttle();
  const res = await fetch(`${BASE}${apiPath}`, {
    headers: { "X-TBA-Auth-Key": key, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${apiPath} -> ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAllTeamsForYear() {
  const teams = [];
  let page = 0;
  for (;;) {
    const batch = await tba(`/teams/${YEAR}/${page}`);
    if (!batch?.length) break;
    teams.push(...batch);
    if (batch.length < 500) break;
    page += 1;
  }
  return teams;
}

async function fetchEventSimpleList() {
  return (await tba(`/events/${YEAR}/simple`)) ?? [];
}

/** @typedef {{ teamKeys: string[], score: number }} AllianceRow */

/**
 * @param {unknown[]} matches
 * @returns {AllianceRow[]}
 */
function qualAllianceRowsFromMatches(matches) {
  if (!Array.isArray(matches)) return [];
  /** @type {AllianceRow[]} */
  const out = [];
  for (const match of matches) {
    if (!match || typeof match !== "object") continue;
    if (match.comp_level !== "qm") continue;
    const al = match.alliances;
    if (!al || typeof al !== "object") continue;
    for (const color of ["red", "blue"]) {
      const side = al[color];
      if (!side || typeof side !== "object") continue;
      const keys = side.team_keys;
      if (!Array.isArray(keys) || keys.length !== 3) continue;
      const sc = side.score;
      if (typeof sc !== "number" || !Number.isFinite(sc) || sc < 0) continue;
      out.push({ teamKeys: keys.map(String), score: sc });
    }
  }
  return out;
}

/**
 * @param {AllianceRow[]} rows
 * @returns {Map<string, number>}
 */
function teamIndexMap(rows) {
  const set = new Set();
  for (const r of rows) {
    for (const k of r.teamKeys) set.add(k);
  }
  const order = [...set].sort();
  const m = new Map();
  order.forEach((k, i) => m.set(k, i));
  return m;
}

/**
 * Classic OPR normal equations: each alliance row is score ≈ sum of three team coefficients (no intercept), matching TBA’s formulation.
 * @param {AllianceRow[]} rows
 * @param {Map<string, number>} teamIndex
 * @param {number} numTeams
 * @returns {{ M: number[][], c: number[], n: number }}
 */
function accumulateNormalEquations(rows, teamIndex, numTeams) {
  const n = numTeams;
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  const c = new Array(n).fill(0);
  for (const row of rows) {
    const cols = [];
    for (const tk of row.teamKeys) {
      const j = teamIndex.get(tk);
      if (j === undefined) continue;
      cols.push(j);
    }
    if (cols.length !== 3) continue;
    const b = row.score;
    for (const j of cols) {
      c[j] += b;
      for (const k of cols) {
        M[j][k] += 1;
      }
    }
  }
  for (let i = 0; i < n; i++) M[i][i] += RIDGE;
  return { M, c, n };
}

/**
 * Solve M x = c with partial-pivot Gaussian elimination (M should be SPD-ish after ridge).
 * @param {number[][]} M0
 * @param {number[]} c0
 * @returns {number[] | null}
 */
function solveLinear(M0, c0) {
  const n = c0.length;
  const M = M0.map((row) => [...row]);
  const b = [...c0];
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
    }
    if (Math.abs(M[piv][k]) < 1e-11) return null;
    if (piv !== k) {
      [M[k], M[piv]] = [M[piv], M[k]];
      [b[k], b[piv]] = [b[piv], b[k]];
    }
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      for (let j = k; j < n; j++) M[i][j] -= f * M[k][j];
      b[i] -= f * b[k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    const d = M[i][i];
    if (Math.abs(d) < 1e-11) return null;
    x[i] = s / d;
  }
  return x;
}

/**
 * @param {AllianceRow[]} rows
 * @param {Map<string, number>} teamIndex
 * @param {number[]} x
 */
function predictScores(rows, teamIndex, x) {
  const pred = [];
  for (const row of rows) {
    let p = 0;
    for (const tk of row.teamKeys) {
      const j = teamIndex.get(tk);
      if (j !== undefined) p += x[j];
    }
    pred.push(p);
  }
  return pred;
}

/**
 * Per-team refit after residual trim: global qual LS once, then for each team T drop up to
 * three of T’s most negative-residual rows and re-estimate **only T’s** coefficient with
 * every other team’s coefficient fixed at the global solution (mean implied contribution on kept rows).
 * @param {AllianceRow[]} rows
 * @returns {Map<string, number | null>}
 */
function trimmedOprByTeamResidual(rows) {
  /** @type {Map<string, number | null>} */
  const out = new Map();
  if (rows.length < 4) return out;

  const teamIndex = teamIndexMap(rows);
  const numTeams = teamIndex.size;
  if (numTeams < 2) return out;

  const { M: Mfull, c: cfull } = accumulateNormalEquations(rows, teamIndex, numTeams);
  const xGlobal = solveLinear(Mfull, cfull);
  if (!xGlobal) return out;

  const pred = predictScores(rows, teamIndex, xGlobal);

  for (const teamKey of teamIndex.keys()) {
    /** @type {{ i: number, res: number }[]} */
    const withRes = [];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].teamKeys.includes(teamKey)) continue;
      withRes.push({ i, res: rows[i].score - pred[i] });
    }
    if (withRes.length === 0) {
      out.set(teamKey, null);
      continue;
    }
    withRes.sort((a, b) => a.res - b.res);
    let dropN = ROWS_TO_DROP;
    if (withRes.length < dropN) dropN = withRes.length;
    const dropIdx = new Set(withRes.slice(0, dropN).map((o) => o.i));

    let sumImplied = 0;
    let nKept = 0;
    for (let i = 0; i < rows.length; i++) {
      if (dropIdx.has(i)) continue;
      const row = rows[i];
      if (!row.teamKeys.includes(teamKey)) continue;
      let implied = row.score;
      for (const tk of row.teamKeys) {
        if (tk === teamKey) continue;
        const j = teamIndex.get(tk);
        if (j === undefined) {
          implied = NaN;
          break;
        }
        implied -= xGlobal[j];
      }
      if (!Number.isFinite(implied)) continue;
      sumImplied += implied;
      nKept += 1;
    }
    if (nKept === 0) {
      out.set(teamKey, null);
      continue;
    }
    out.set(teamKey, sumImplied / nKept);
  }
  return out;
}

function emptyTeamRow(teamKey, teamNumber, nickname) {
  return {
    teamKey,
    teamNumber,
    nickname,
    worldDivision: null,
    maxOpr: null,
    maxOprEventKey: null,
    maxOprEventName: null,
    recentOpr: null,
    recentOprEventKey: null,
    recentOprEventName: null,
    latestEventTrimmedOpr: null,
    trimmedMinusRecentOpr: null,
  };
}

async function main() {
  console.log(`Loading ${YEAR} teams…`);
  const teamRows = await fetchAllTeamsForYear();
  const byKey = new Map();
  for (const t of teamRows) {
    byKey.set(t.key, emptyTeamRow(t.key, t.team_number, t.nickname ?? ""));
  }

  console.log(`Loading ${YEAR} events…`);
  const allEvents = await fetchEventSimpleList();
  const events = allEvents.filter((e) => OFFICIAL_SEASON_EVENT_TYPES.has(e.event_type));
  console.log(
    `Using ${events.length} official season events for OPR (${allEvents.length} total in ${YEAR} on TBA).`,
  );
  const eventNameByKey = new Map(events.map((e) => [e.key, e.name ?? e.key]));
  const worldDivisionEvents = events.filter((e) => e.event_type === 3);
  console.log(
    `Loading teams for ${worldDivisionEvents.length} Championship division events (event_type=3)…`,
  );
  /** @type {Map<string, string>} */
  const worldDivisionByTeamKey = new Map();
  for (const divEvent of worldDivisionEvents) {
    const teamKeys = (await tba(`/event/${divEvent.key}/teams/keys`)) ?? [];
    const divisionName = divEvent.name ?? divEvent.key;
    for (const teamKey of teamKeys) {
      if (!worldDivisionByTeamKey.has(teamKey)) {
        worldDivisionByTeamKey.set(teamKey, divisionName);
      }
    }
  }
  /** yyyy-mm-dd for sorting; missing dates sort before any real date */
  const eventSortDateByKey = new Map(
    events.map((e) => {
      const raw = e.end_date || e.start_date;
      const d =
        typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "0000-00-00";
      return [e.key, d];
    }),
  );

  /** @type {Map<string, { opr: number, eventKey: string }>} */
  const best = new Map();
  /** @type {Map<string, { opr: number, eventKey: string, sortDate: string }>} */
  const mostRecent = new Map();

  function isNewerEvent(aKey, aDate, bKey, bDate) {
    if (aDate !== bDate) return aDate > bDate;
    return aKey > bKey;
  }

  function numberFromTeamKey(teamKey) {
    const m = /^frc(\d+)$/.exec(teamKey);
    return m ? parseInt(m[1], 10) : 0;
  }

  const keys = events.map((e) => e.key);
  console.log(`Fetching OPR for ${keys.length} events…`);

  let done = 0;
  for (const eventKey of keys) {
    const sortDate = eventSortDateByKey.get(eventKey) ?? "0000-00-00";
    const oprsPayload = await tba(`/event/${eventKey}/oprs`);
    const oprs = oprsPayload?.oprs;
    if (oprs && typeof oprs === "object") {
      for (const [teamKey, val] of Object.entries(oprs)) {
        if (typeof val !== "number" || Number.isNaN(val)) continue;
        const prev = best.get(teamKey);
        if (!prev || val > prev.opr) {
          best.set(teamKey, { opr: val, eventKey });
        }
        const prevR = mostRecent.get(teamKey);
        if (!prevR || isNewerEvent(eventKey, sortDate, prevR.eventKey, prevR.sortDate)) {
          mostRecent.set(teamKey, { opr: val, eventKey, sortDate });
        }
      }
    }
    done += 1;
    if (done % 25 === 0 || done === keys.length) {
      process.stdout.write(`\r  events ${done}/${keys.length}`);
    }
  }
  console.log("");

  for (const [teamKey, { opr, eventKey }] of best) {
    let row = byKey.get(teamKey);
    if (!row) {
      row = emptyTeamRow(teamKey, numberFromTeamKey(teamKey), "");
      byKey.set(teamKey, row);
    }
    row.maxOpr = Math.round(opr * 1000) / 1000;
    row.maxOprEventKey = eventKey;
    row.maxOprEventName = eventNameByKey.get(eventKey) ?? eventKey;
  }

  for (const [teamKey, { opr, eventKey }] of mostRecent) {
    let row = byKey.get(teamKey);
    if (!row) {
      row = emptyTeamRow(teamKey, numberFromTeamKey(teamKey), "");
      byKey.set(teamKey, row);
    }
    row.recentOpr = Math.round(opr * 1000) / 1000;
    row.recentOprEventKey = eventKey;
    row.recentOprEventName = eventNameByKey.get(eventKey) ?? eventKey;
  }

  const recentEventKeys = new Set();
  for (const row of byKey.values()) {
    if (row.recentOprEventKey) recentEventKeys.add(row.recentOprEventKey);
  }

  console.log(`Fetching qual matches for ${recentEventKeys.size} unique “recent” events (trimmed OPR)…`);
  /** @type {Map<string, Map<string, number | null>>} */
  const trimmedByEvent = new Map();
  let evDone = 0;
  for (const eventKey of recentEventKeys) {
    const matches = (await tba(`/event/${eventKey}/matches`)) ?? [];
    const rows = qualAllianceRowsFromMatches(matches);
    trimmedByEvent.set(eventKey, trimmedOprByTeamResidual(rows));
    evDone += 1;
    if (evDone % 10 === 0 || evDone === recentEventKeys.size) {
      process.stdout.write(`\r  recent-event matches ${evDone}/${recentEventKeys.size}`);
    }
  }
  console.log("");

  for (const row of byKey.values()) {
    const ek = row.recentOprEventKey;
    if (!ek) continue;
    const map = trimmedByEvent.get(ek);
    if (!map) continue;
    const coef = map.get(row.teamKey);
    if (coef == null || !Number.isFinite(coef)) continue;
    row.latestEventTrimmedOpr = Math.round(coef * 1000) / 1000;
    const recent = row.recentOpr;
    if (recent != null && Number.isFinite(recent)) {
      row.trimmedMinusRecentOpr = Math.round((row.latestEventTrimmedOpr - recent) * 1000) / 1000;
    }
  }

  const teams = [...byKey.values()].sort((a, b) => a.teamNumber - b.teamNumber);
  for (const row of teams) {
    row.worldDivision = worldDivisionByTeamKey.get(row.teamKey) ?? null;
  }
  const teamsWithOpr = teams.filter((t) => t.maxOpr != null).length;
  const teamsWithTrimmed = teams.filter((t) => t.latestEventTrimmedOpr != null).length;
  const teamsWithWorldDivision = teams.filter((t) => t.worldDivision != null).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    year: YEAR,
    source: "The Blue Alliance API v3",
    eventScope: "official_season",
    eventsUsedForOpr: events.length,
    eventsTotalInYear: allEvents.length,
    teamCount: teams.length,
    teamsWithOpr,
    teamsWithTrimmedOpr: teamsWithTrimmed,
    teamsWithWorldDivision,
    eventsFetchedForTrimmedOpr: recentEventKeys.size,
    trimmedOprBasis: "residual",
    trimmedOprMethod: "perTeamRefitFixedPartners",
    trimmedOprNote:
      "At each team’s calendar-latest official event with TBA OPR: one global classic qual least squares (three team coefficients per alliance row, no intercept, small ridge). For each team T, up to three qual alliance rows involving T with the most negative residual (actual minus global prediction) are dropped. T’s trimmed value is then the **per-team refit**: on each remaining row containing T, score minus the sum of the **global** OPRs of T’s two alliance partners gives an implied contribution for T; latestEventTrimmedOpr is the arithmetic mean of those implied values (equivalently the single-team least squares estimate for T with all other teams fixed at the global fit). No second joint solve and no clamping vs TBA.",
    teams,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 0), "utf8");
  console.log(
    `Wrote ${OUT} (${teams.length} teams, ${teamsWithOpr} with OPR data, ${teamsWithTrimmed} with trimmed OPR).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
