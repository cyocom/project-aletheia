const metaEl = document.getElementById("meta");
const errEl = document.getElementById("error");
const tbody = document.getElementById("tbody");
const filterInput = document.getElementById("filter");
const divisionTabsEl = document.getElementById("division-tabs");

/** @type {{ generatedAt: string, year: number, teamCount: number, teamsWithOpr: number, teams: Row[], teamsWithTrimmedOpr?: number } | null} */
let payload = null;

/**
 * @typedef {{
 *   teamKey: string,
 *   teamNumber: number,
 *   nickname: string,
 *   maxOpr: number | null,
 *   maxOprEventKey: string | null,
 *   maxOprEventName: string | null,
 *   recentOpr?: number | null,
 *   recentOprEventKey?: string | null,
 *   recentOprEventName?: string | null,
 *   latestEventTrimmedOpr?: number | null,
 *   trimmedMinusRecentOpr?: number | null,
 *   worldDivision?: string | null,
 * }} Row
 */

/** @param {Row} r */
function trimmedMinusRecentValue(r) {
  if (r.trimmedMinusRecentOpr != null && Number.isFinite(r.trimmedMinusRecentOpr)) {
    return r.trimmedMinusRecentOpr;
  }
  const t = r.latestEventTrimmedOpr;
  const rec = r.recentOpr;
  if (t != null && rec != null && Number.isFinite(t) && Number.isFinite(rec)) {
    return t - rec;
  }
  return null;
}

let sortKey = "teamNumber";
let sortDir = 1;
let filterText = "";
let activeDivision = "all";
const WORLD_DIVISION_NAMES = [
  "Archimedes",
  "Carson",
  "Curie",
  "Daly",
  "Galileo",
  "Hopper",
  "Johnson",
  "Milstein",
  "Newton",
  "Roebling",
];

/** @param {Row} row */
function worldDivisionOf(row) {
  if (typeof row.worldDivision === "string" && row.worldDivision.trim()) {
    return row.worldDivision.trim();
  }
  const names = [row.recentOprEventName, row.maxOprEventName];
  for (const eventName of names) {
    if (!eventName) continue;
    const lower = eventName.toLowerCase();
    for (const division of WORLD_DIVISION_NAMES) {
      if (lower.includes(`${division.toLowerCase()} division`)) {
        return `${division} Division`;
      }
    }
  }
  return null;
}

function renderDivisionTabs() {
  if (!payload || !divisionTabsEl) return;
  const divisions = new Set();
  payload.teams.forEach((r) => {
    const division = worldDivisionOf(r);
    if (division) divisions.add(division);
  });

  if (divisions.size === 0) {
    divisionTabsEl.replaceChildren();
    divisionTabsEl.classList.add("hidden");
    activeDivision = "all";
    return;
  }

  const sorted = [...divisions].sort((a, b) => a.localeCompare(b));
  if (activeDivision !== "all" && !sorted.includes(activeDivision)) {
    activeDivision = "all";
  }

  divisionTabsEl.classList.remove("hidden");
  const frag = document.createDocumentFragment();
  const tabs = [{ id: "all", label: "All teams" }, ...sorted.map((d) => ({ id: d, label: d }))];
  tabs.forEach((tab) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    const selected = activeDivision === tab.id;
    btn.setAttribute("aria-selected", selected ? "true" : "false");
    btn.textContent = tab.label;
    btn.addEventListener("click", () => {
      activeDivision = tab.id;
      renderDivisionTabs();
      render();
    });
    frag.appendChild(btn);
  });
  divisionTabsEl.replaceChildren(frag);
}

function showError(msg) {
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
}

function clearError() {
  errEl.textContent = "";
  errEl.classList.add("hidden");
}

function compare(a, b) {
  const av =
    sortKey === "trimmedMinusRecentOpr" ? trimmedMinusRecentValue(a) : a[sortKey];
  const bv =
    sortKey === "trimmedMinusRecentOpr" ? trimmedMinusRecentValue(b) : b[sortKey];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === "number" && typeof bv === "number") {
    if (av !== bv) return av < bv ? -1 : 1;
  } else {
    const as = String(av).toLowerCase();
    const bs = String(bv).toLowerCase();
    if (as !== bs) return as < bs ? -1 : 1;
  }
  return a.teamNumber - b.teamNumber;
}

function visibleRows() {
  if (!payload) return [];
  const q = filterText.trim().toLowerCase();
  let rows = payload.teams;
  if (activeDivision !== "all") {
    rows = rows.filter((r) => worldDivisionOf(r) === activeDivision);
  }
  if (q) {
    rows = rows.filter((r) => {
      const num = String(r.teamNumber);
      const nick = (r.nickname || "").toLowerCase();
      return num.includes(q) || nick.includes(q);
    });
  }
  const out = [...rows];
  out.sort((a, b) => {
    const c = compare(a, b) * sortDir;
    return c !== 0 ? c : a.teamNumber - b.teamNumber;
  });
  return out;
}

/** @param {Row} r @param {"max"|"recent"} which */
function eventCell(r, which) {
  const td = document.createElement("td");
  const key = which === "max" ? r.maxOprEventKey : r.recentOprEventKey;
  const name = which === "max" ? r.maxOprEventName : r.recentOprEventName;
  if (key && name) {
    const a = document.createElement("a");
    a.href = `https://www.thebluealliance.com/event/${encodeURIComponent(key)}`;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    a.textContent = name;
    td.appendChild(a);
  } else {
    td.className = "muted";
    td.textContent = "—";
  }
  return td;
}

function render() {
  if (!payload) return;
  const rows = visibleRows();
  tbody.replaceChildren();
  const frag = document.createDocumentFragment();
  rows.forEach((r, rankIndex) => {
    const tr = document.createElement("tr");
    const rank = rankIndex + 1;

    const tdRank = document.createElement("td");
    tdRank.className = "num col-rank";
    tdRank.textContent = String(rank);
    tdRank.setAttribute("aria-label", `Rank ${rank} in current view`);

    const tdNum = document.createElement("td");
    tdNum.className = "num";
    const teamA = document.createElement("a");
    teamA.href = `https://www.thebluealliance.com/team/${r.teamNumber}/${payload.year}`;
    teamA.rel = "noopener noreferrer";
    teamA.target = "_blank";
    teamA.textContent = String(r.teamNumber);
    tdNum.appendChild(teamA);

    const tdNick = document.createElement("td");
    tdNick.textContent = r.nickname || "";

    const tdMaxOpr = document.createElement("td");
    tdMaxOpr.className = "num";
    tdMaxOpr.textContent =
      r.maxOpr != null && !Number.isNaN(r.maxOpr) ? r.maxOpr.toFixed(3) : "—";

    const tdRecentOpr = document.createElement("td");
    tdRecentOpr.className = "num";
    const ro = r.recentOpr;
    tdRecentOpr.textContent =
      ro != null && !Number.isNaN(ro) ? ro.toFixed(3) : "—";

    const tdTrim = document.createElement("td");
    tdTrim.className = "num";
    const trm = r.latestEventTrimmedOpr;
    tdTrim.textContent =
      trm != null && !Number.isNaN(trm) ? trm.toFixed(3) : "—";

    const tdDelta = document.createElement("td");
    tdDelta.className = "num";
    const d = trimmedMinusRecentValue(r);
    tdDelta.textContent =
      d != null && !Number.isNaN(d) ? d.toFixed(3) : "—";

    tr.append(
      tdRank,
      tdNum,
      tdNick,
      tdMaxOpr,
      eventCell(r, "max"),
      tdRecentOpr,
      tdTrim,
      tdDelta,
      eventCell(r, "recent"),
    );
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

document.querySelectorAll("th button[data-sort]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-sort");
    if (!key) return;
    if (sortKey === key) sortDir *= -1;
    else {
      sortKey = key;
      const nameCols =
        key === "nickname" || key === "maxOprEventName" || key === "recentOprEventName";
      const descNum =
        key === "maxOpr" ||
        key === "recentOpr" ||
        key === "latestEventTrimmedOpr" ||
        key === "trimmedMinusRecentOpr";
      sortDir = nameCols ? 1 : descNum ? -1 : 1;
    }
    render();
  });
});

filterInput.addEventListener("input", () => {
  filterText = filterInput.value;
  render();
});

async function load() {
  clearError();
  metaEl.textContent = "Loading data…";
  let res;
  try {
    res = await fetch("data/teams-opr-2026.json", { cache: "no-store" });
  } catch (e) {
    showError("Could not load data/teams-opr-2026.json. Serve this folder over HTTP or run npm run fetch-data.");
    metaEl.textContent = "";
    return;
  }
  if (!res.ok) {
    showError(
      res.status === 404
        ? "Missing data/teams-opr-2026.json. From the project folder run: npm run fetch-data (with TBA_AUTH_KEY set)."
        : `Failed to load data (${res.status}).`,
    );
    metaEl.textContent = "";
    return;
  }
  try {
    payload = await res.json();
  } catch {
    showError("Invalid JSON in data/teams-opr-2026.json.");
    metaEl.textContent = "";
    return;
  }
  const when = payload.generatedAt
    ? new Date(payload.generatedAt).toLocaleString()
    : "unknown time";
  const teamLine = `${payload.teamCount ?? payload.teams?.length ?? 0} teams · ${
    payload.teamsWithOpr ?? "?"
  } with OPR`;
  let trimLine = "";
  if (payload.teamsWithTrimmedOpr != null) {
    trimLine = ` · ${payload.teamsWithTrimmedOpr} with trimmed (latest)`;
  }
  let eventLine = "";
  if (payload.eventsUsedForOpr != null && payload.eventsTotalInYear != null) {
    eventLine = ` · ${payload.eventsUsedForOpr}/${payload.eventsTotalInYear} official events for OPR`;
  }
  metaEl.textContent = `Data from ${when} · ${teamLine}${trimLine}${eventLine}`;
  renderDivisionTabs();
  render();
}

load();
