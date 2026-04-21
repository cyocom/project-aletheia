/**
 * Fetches 2026 FRC teams and each team's highest OPR across any event that year (TBA).
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

async function main() {
  console.log(`Loading ${YEAR} teams…`);
  const teamRows = await fetchAllTeamsForYear();
  const byKey = new Map();
  for (const t of teamRows) {
    byKey.set(t.key, {
      teamKey: t.key,
      teamNumber: t.team_number,
      nickname: t.nickname ?? "",
      maxOpr: null,
      maxOprEventKey: null,
      maxOprEventName: null,
      recentOpr: null,
      recentOprEventKey: null,
      recentOprEventName: null,
    });
  }

  console.log(`Loading ${YEAR} events…`);
  const events = await fetchEventSimpleList();
  const eventNameByKey = new Map(events.map((e) => [e.key, e.name ?? e.key]));
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

  function numberFromTeamKey(teamKey) {
    const m = /^frc(\d+)$/.exec(teamKey);
    return m ? parseInt(m[1], 10) : 0;
  }

  for (const [teamKey, { opr, eventKey }] of best) {
    let row = byKey.get(teamKey);
    if (!row) {
      row = {
        teamKey,
        teamNumber: numberFromTeamKey(teamKey),
        nickname: "",
        maxOpr: null,
        maxOprEventKey: null,
        maxOprEventName: null,
        recentOpr: null,
        recentOprEventKey: null,
        recentOprEventName: null,
      };
      byKey.set(teamKey, row);
    }
    row.maxOpr = Math.round(opr * 1000) / 1000;
    row.maxOprEventKey = eventKey;
    row.maxOprEventName = eventNameByKey.get(eventKey) ?? eventKey;
  }

  for (const [teamKey, { opr, eventKey }] of mostRecent) {
    let row = byKey.get(teamKey);
    if (!row) {
      row = {
        teamKey,
        teamNumber: numberFromTeamKey(teamKey),
        nickname: "",
        maxOpr: null,
        maxOprEventKey: null,
        maxOprEventName: null,
        recentOpr: null,
        recentOprEventKey: null,
        recentOprEventName: null,
      };
      byKey.set(teamKey, row);
    }
    row.recentOpr = Math.round(opr * 1000) / 1000;
    row.recentOprEventKey = eventKey;
    row.recentOprEventName = eventNameByKey.get(eventKey) ?? eventKey;
  }

  const teams = [...byKey.values()].sort((a, b) => a.teamNumber - b.teamNumber);
  const teamsWithOpr = teams.filter((t) => t.maxOpr != null).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    year: YEAR,
    source: "The Blue Alliance API v3",
    teamCount: teams.length,
    teamsWithOpr,
    teams,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 0), "utf8");
  console.log(`Wrote ${OUT} (${teams.length} teams, ${teamsWithOpr} with OPR data).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
