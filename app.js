const metaEl = document.getElementById("meta");
const errEl = document.getElementById("error");
const tbody = document.getElementById("tbody");
const filterInput = document.getElementById("filter");

/** @type {{ generatedAt: string, year: number, teamCount: number, teamsWithOpr: number, teams: Row[] }} */
let payload = null;

/** @typedef {{ teamKey: string, teamNumber: number, nickname: string, maxOpr: number | null, maxOprEventKey: string | null, maxOprEventName: string | null }} Row */

let sortKey = "teamNumber";
let sortDir = 1;
let filterText = "";

function showError(msg) {
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
}

function clearError() {
  errEl.textContent = "";
  errEl.classList.add("hidden");
}

function compare(a, b) {
  const av = a[sortKey];
  const bv = b[sortKey];
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

function render() {
  if (!payload) return;
  const rows = visibleRows();
  tbody.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");

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

    const tdOpr = document.createElement("td");
    tdOpr.className = "num";
    tdOpr.textContent =
      r.maxOpr != null && !Number.isNaN(r.maxOpr) ? r.maxOpr.toFixed(3) : "—";

    const tdEv = document.createElement("td");
    if (r.maxOprEventKey && r.maxOprEventName) {
      const a = document.createElement("a");
      a.href = `https://www.thebluealliance.com/event/${encodeURIComponent(r.maxOprEventKey)}`;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      a.textContent = r.maxOprEventName;
      tdEv.appendChild(a);
    } else {
      tdEv.className = "muted";
      tdEv.textContent = "—";
    }

    tr.append(tdNum, tdNick, tdOpr, tdEv);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

document.querySelectorAll("th button[data-sort]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-sort");
    if (!key) return;
    if (sortKey === key) sortDir *= -1;
    else {
      sortKey = key;
      sortDir = key === "nickname" || key === "maxOprEventName" ? 1 : key === "maxOpr" ? -1 : 1;
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
  metaEl.textContent = `Data from ${when} · ${payload.teamCount ?? payload.teams?.length ?? 0} teams · ${
    payload.teamsWithOpr ?? "?"
  } with OPR`;
  render();
}

load();
