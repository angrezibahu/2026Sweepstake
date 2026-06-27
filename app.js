// ============================================
// World Cup 2026 Sweepstake - Kewford South
// ============================================

let state = loadState();
if (!state.overrides) state.overrides = {};   // migrate older saved state
const isAdmin = new URLSearchParams(window.location.search).get("admin") === "true";

const TOTAL_SPOTS = 48;

// ---- Init ----
document.addEventListener("DOMContentLoaded", async () => {
    setupTabs();
    renderSpotsBadge();
    updateDrawStatus();
    updateBankDetails();

    await loadLiveData();          // pull committed schedule + auto-updated results
    renderGroups();
    selectCurrentStage();          // open the tracker on the round currently being played
    renderBracket();
    renderFixtures();
    setupAdmin();
    setupTeamClicks();

    // Open on today's fixtures rather than the very first match back in June.
    setTimeout(() => scrollFixturesToToday(false), 60);
});

// Delegated click: anywhere a team name is rendered with [data-team-click],
// tapping it replays the right animation for that team's current state.
function setupTeamClicks() {
    // In the Tournament Tracker, a tap opens the team's detail card (results +
    // current standing). Everywhere else (e.g. fixtures) it replays the animation.
    const activate = (el) => {
        if (document.querySelector(".anim-overlay")) return;  // one at a time
        if (el.closest("#bracket")) {
            showTeamDetail(el.dataset.teamClick);
        } else {
            playTeamStatus(el.dataset.teamClick);
        }
    };
    document.addEventListener("click", (e) => {
        const el = e.target.closest("[data-team-click]");
        if (!el) return;
        e.preventDefault();
        activate(el);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const el = e.target.closest("[data-team-click]");
        if (!el) return;
        e.preventDefault();
        activate(el);
    });
}

function playTeamStatus(name) {
    const team = findTeam(name);
    if (!team) return;
    const stage = getStage(name);
    playAdvanceAnimation(team, "groups", stage, { review: true });
}

// ---- Effective team state: auto results (LIVE), with admin overrides on top ----
function isEliminated(name) {
    const o = state.overrides[name];
    if (o && typeof o.eliminated === "boolean") return o.eliminated;
    return (LIVE.eliminated || []).includes(name);
}

function getStage(name) {
    const o = state.overrides[name];
    if (o && o.stage) return o.stage;
    return (LIVE.stages || {})[name] || "groups";
}

// ---- Spots badge ----
function renderSpotsBadge() {
    const taken = Math.max(0, Math.min(SPOTS_TAKEN, TOTAL_SPOTS));
    document.getElementById("spots-taken").textContent = taken;
    document.getElementById("spots-total").textContent = TOTAL_SPOTS;
}

// ---- Tabs ----
function setupTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById(tab.dataset.tab).classList.add("active");
            // Jump straight to today's matches when opening Fixtures & Results
            if (tab.dataset.tab === "fixtures") {
                requestAnimationFrame(() => scrollFixturesToToday(true));
            }
        });
    });
}

// ---- Render Groups ----
function renderGroups() {
    const grid = document.getElementById("groups-grid");
    grid.innerHTML = "";

    for (const [groupName, teams] of Object.entries(WORLD_CUP_DATA.groups)) {
        const card = document.createElement("div");
        card.className = "group-card";

        let teamsHTML = "";
        for (const team of teams) {
            const owner = state.assignments[team.name];
            const eliminated = isEliminated(team.name);
            const ownerDisplay = owner
                ? `<span class="team-owner">${escapeHtml(owner)}</span>`
                : `<span class="team-owner unassigned">Available</span>`;

            teamsHTML += `
                <div class="team-row${eliminated ? ' eliminated' : ''}">
                    <span class="team-flag">${team.flag}</span>
                    <span class="team-name">${team.name}</span>
                    ${state.drawComplete ? ownerDisplay : ''}
                </div>`;
        }

        card.innerHTML = `
            <div class="group-header">Group ${groupName}</div>
            ${teamsHTML}`;
        grid.appendChild(card);
    }
}

// ---- Render Bracket ----
function renderBracket() {
    const view = document.getElementById("bracket-view");
    view.innerHTML = "";

    const activeStage = document.querySelector(".stage-btn.active")?.dataset.stage || "groups";

    const allTeams = getAllTeams();
    const filteredTeams = filterTeamsByStage(allTeams, activeStage);

    if (filteredTeams.length === 0) {
        view.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 2rem;">
            No teams at this stage yet. The tournament hasn't reached here!
        </div>`;
        return;
    }

    for (const team of filteredTeams) {
        const eliminated = isEliminated(team.name);
        const owner = state.assignments[team.name];
        const stage = getStage(team.name);

        const card = document.createElement("div");
        card.className = `bracket-team ${eliminated ? 'eliminated' : 'alive'} is-clickable`;
        card.dataset.teamClick = team.name;
        card.innerHTML = `
            <span class="team-flag">${team.flag}</span>
            <div class="bracket-team-info">
                <div class="bracket-team-name">${team.name}</div>
                ${owner ? `<div class="bracket-team-owner">${escapeHtml(owner)}</div>` : ''}
            </div>
            <span class="bracket-team-stage">${getStageName(stage)}</span>`;
        view.appendChild(card);
    }

    // Stage button listeners
    document.querySelectorAll(".stage-btn").forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll(".stage-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderBracket();
        };
    });
}

// The round currently being contested: the furthest stage any team has reached.
// Used to open the Tournament Tracker on the live round (e.g. once every group
// is done it jumps to Round of 32) rather than always showing the group stage
// with the teams that have already gone home.
function currentStage() {
    const stageOrder = ["groups", "r32", "r16", "qf", "sf", "final", "winner"];
    let maxIdx = 0;
    for (const team of getAllTeams()) {
        const idx = stageOrder.indexOf(getStage(team.name));
        if (idx > maxIdx) maxIdx = idx;
    }
    // There's no "winner" tab - the trophy lift lives under the Final.
    return stageOrder[Math.min(maxIdx, stageOrder.indexOf("final"))];
}

// Highlight the stage button matching the current round so renderBracket() opens
// there. Falls back to the group stage before any team has progressed.
function selectCurrentStage() {
    const stage = currentStage();
    document.querySelectorAll(".stage-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.stage === stage);
    });
}

function filterTeamsByStage(teams, viewStage) {
    const stageOrder = ["groups", "r32", "r16", "qf", "sf", "final", "winner"];
    const viewIdx = stageOrder.indexOf(viewStage);

    if (viewStage === "groups") return teams;

    // Show teams that reached at least this stage - including ones knocked out
    // here - but not teams that went home in an earlier round.
    return teams.filter(t => {
        const teamStage = getStage(t.name);
        const teamIdx = stageOrder.indexOf(teamStage);
        return teamIdx >= viewIdx;
    });
}

function getAllTeams() {
    const teams = [];
    for (const group of Object.values(WORLD_CUP_DATA.groups)) {
        teams.push(...group);
    }
    return teams;
}

function getStageName(stage) {
    const names = {
        groups: "Groups",
        r32: "R32",
        r16: "R16",
        qf: "QF",
        sf: "Semi",
        final: "Final",
        winner: "WINNER!"
    };
    return names[stage] || stage;
}

// ---- Fixtures / internal calendar ----
function teamFlag(name) {
    for (const team of getAllTeams()) {
        if (team.name === name) return team.flag;
    }
    return "";
}

// Friendly label for an unresolved placeholder like "2A", "3A/B/C/D/F", "W73", "L101".
function placeholderLabel(ref) {
    let m;
    if ((m = /^1([A-L])$/.exec(ref))) return `Winner Group ${m[1]}`;
    if ((m = /^2([A-L])$/.exec(ref))) return `Runner-up Group ${m[1]}`;
    if (/^3[A-L/]+$/.test(ref)) return "3rd place";
    if ((m = /^W(\d+)$/.exec(ref))) return `Winner of #${m[1]}`;
    if ((m = /^L(\d+)$/.exec(ref))) return `Loser of #${m[1]}`;
    return ref;
}

function fixtureSide(match, side) {
    const rec = RESULTS[String(match.match)] || {};
    const resolved = rec[side];                    // filled in by the engine as rounds finish
    const ref = side === "home" ? match.home : match.away;
    const placeholder = side === "home" ? match.homePlaceholder : match.awayPlaceholder;
    const name = resolved || (placeholder ? null : ref);
    if (name) {
        const owner = state.assignments[name];
        return {
            name,
            html: `<span class="fx-flag">${teamFlag(name)}</span>
                   <span class="fx-side-text">
                       <span class="fx-team-name${isEliminated(name) ? ' eliminated' : ''}">${escapeHtml(name)}</span>
                       ${owner ? `<span class="fx-owner">${escapeHtml(owner)}</span>` : ""}
                   </span>`,
        };
    }
    return { name: null, html: `<span class="fx-team-name tbd">${escapeHtml(placeholderLabel(ref))}</span>` };
}

const STAGE_LABEL_LONG = {
    group: "Group Stage", r32: "Round of 32", r16: "Round of 16",
    qf: "Quarter-final", sf: "Semi-final", third: "Third-place play-off", final: "Final",
};

function renderFixtures() {
    const view = document.getElementById("fixtures-view");
    if (!view) return;

    if (!SCHEDULE.length) {
        view.innerHTML = `<div class="fx-empty">Fixture calendar unavailable.</div>`;
        return;
    }

    if (LIVE.updatedAt) {
        const updated = new Date(LIVE.updatedAt);
        document.getElementById("fixtures-updated").textContent =
            `Results auto-update ~2 hours after each match finishes. Last update: ${updated.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`;
    }

    const now = Date.now();
    const byDate = {};
    for (const m of SCHEDULE) {
        (byDate[m.ukDate] = byDate[m.ukDate] || []).push(m);
    }

    // Anchor day: today if it has matches, otherwise the next day that does
    // (falling back to the final matchday once the tournament is over).
    const sortedDates = Object.keys(byDate).sort();
    const todayStr = ymdToday();
    const anchorDate = sortedDates.find(dt => dt >= todayStr) || sortedDates[sortedDates.length - 1] || null;

    let html = "";
    for (const date of sortedDates) {
        const d = new Date(date + "T12:00:00Z");
        const isAnchor = date === anchorDate;
        const dayLabel = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
        const pill = isAnchor
            ? `<span class="fx-today-pill">${date === todayStr ? "Today" : "Next up"}</span>`
            : "";
        html += `<div class="fx-day${isAnchor ? " is-today" : ""}"${isAnchor ? ' id="fx-today"' : ""}>${dayLabel}${pill}</div>`;
        for (const m of byDate[date].sort((a, b) => a.match - b.match)) {
            const rec = RESULTS[String(m.match)] || {};
            const finished = rec.status === "FINISHED";
            const due = now >= Date.parse(m.resultsDueUTC);
            const home = fixtureSide(m, "home");
            const away = fixtureSide(m, "away");

            let middle, statusClass;
            if (finished && rec.homeScore != null) {
                middle = `<span class="fx-score">${rec.homeScore} – ${rec.awayScore}</span>`;
                statusClass = "done";
            } else if (due) {
                middle = `<span class="fx-vs">v</span>`;
                statusClass = "due";
            } else {
                middle = `<span class="fx-ko">${m.ukTime}</span>`;
                statusClass = "upcoming";
            }

            const tag = m.stage === "group" ? `Group ${m.group}` : STAGE_LABEL_LONG[m.stage];
            const note = finished ? "Full time"
                : due ? "Awaiting result"
                : `${m.ukTime} BST`;

            const sideAttrs = (s, sideName) => {
                const cls = `fx-side ${sideName}${s.name ? ' is-clickable' : ''}`;
                const extra = s.name
                    ? ` data-team-click="${escapeHtml(s.name)}" role="button" tabindex="0"`
                    : '';
                return `class="${cls}"${extra}`;
            };
            html += `
                <div class="fx-match ${statusClass}">
                    <div class="fx-meta"><span class="fx-tag">${tag}</span><span class="fx-num">#${m.match}</span></div>
                    <div class="fx-teams">
                        <div ${sideAttrs(home, "home")}>${home.html}</div>
                        <div class="fx-mid">${middle}</div>
                        <div ${sideAttrs(away, "away")}>${away.html}</div>
                    </div>
                    <div class="fx-foot"><span class="fx-venue">${escapeHtml(m.venue)}</span><span class="fx-status">${note}</span></div>
                </div>`;
        }
    }
    view.innerHTML = html;
}

// Today's date as YYYY-MM-DD (matches the ukDate keys in the schedule).
function ymdToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Scroll the page so today's fixtures sit just below the sticky tab bar.
function scrollFixturesToToday(smooth) {
    const anchor = document.getElementById("fx-today");
    if (!anchor) return;
    const tabsH = document.querySelector(".tabs")?.offsetHeight || 0;
    const y = window.scrollY + anchor.getBoundingClientRect().top - tabsH - 10;
    window.scrollTo({ top: Math.max(0, y), behavior: smooth ? "smooth" : "auto" });
}

// ---- Team detail card (Tournament Tracker) ----
const TRACKER_STAGE_LONG = {
    groups: "the group stage",
    r32: "the Round of 32",
    r16: "the Round of 16",
    qf: "the Quarter-finals",
    sf: "the Semi-finals",
    final: "the Final",
    winner: "the Final",
};

function matchStageLabel(m) {
    return m.stage === "group" ? `Group ${m.group}` : (STAGE_LABEL_LONG[m.stage] || m.stage);
}

function shortDate(ymd) {
    return new Date(ymd + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// The team actually in a fixture slot: a resolved knockout name, or the listed
// team when it isn't a placeholder. Mirrors fixtureSide() without the markup.
function resolvedSideName(match, side) {
    const rec = RESULTS[String(match.match)] || {};
    const resolved = rec[side];
    const ref = side === "home" ? match.home : match.away;
    const placeholder = side === "home" ? match.homePlaceholder : match.awayPlaceholder;
    return resolved || (placeholder ? null : ref);
}

// Every scheduled fixture this team is confirmed to be part of, in match order.
function getTeamMatches(name) {
    const out = [];
    for (const m of SCHEDULE) {
        const home = resolvedSideName(m, "home");
        const away = resolvedSideName(m, "away");
        if (home !== name && away !== name) continue;
        out.push({ m, isHome: home === name, opponent: home === name ? away : home });
    }
    return out.sort((a, b) => a.m.match - b.m.match);
}

// Win / loss / draw for one finished fixture from this team's point of view.
// Returns null if the match hasn't been played (no halo).
function matchResultFor(teamName, m) {
    const rec = RESULTS[String(m.match)] || {};
    if (rec.status !== "FINISHED" || rec.homeScore == null) return null;
    const isHome = resolvedSideName(m, "home") === teamName;
    const teamScore = isHome ? rec.homeScore : rec.awayScore;
    const oppScore = isHome ? rec.awayScore : rec.homeScore;
    if (teamScore > oppScore) return "win";
    if (teamScore < oppScore) return "loss";
    return "draw";
}

// Checkpoint stages, indexed to line up with stagesPath in playAdvanceAnimation.
const CHECKPOINT_STAGE_KEYS = ["group", "r32", "r16", "qf", "sf", "final", "winner"];

// The halo result for one stage checkpoint: "win" (gold), "loss" (red),
// "draw" (grey) or null (no halo — not played yet).
function checkpointResult(teamName, stageKey, stageIdx, currentIdx, eliminated) {
    if (stageKey === "winner") {
        return currentIdx >= 6 ? "win" : null; // lifted the trophy
    }
    const results = getTeamMatches(teamName)
        .filter(({ m }) => m.stage === stageKey)
        .map(({ m }) => matchResultFor(teamName, m))
        .filter(Boolean);

    if (stageKey === "group") {
        if (!results.length) return null;
        const wins = results.filter(r => r === "win").length;
        const losses = results.filter(r => r === "loss").length;
        if (wins > losses) return "win";
        if (losses > wins) return "loss";
        return "draw";
    }

    // Knockout rounds: a single match.
    if (!results.length) {
        // Advanced past this round without a recorded score: count it as a win.
        return stageIdx < currentIdx ? "win" : null;
    }
    const res = results[0];
    if (res === "draw") {
        // Decided on penalties: advancing is a win, exiting here is a loss.
        if (stageIdx < currentIdx) return "win";
        if (eliminated && stageIdx === currentIdx) return "loss";
    }
    return res;
}

function teamStanding(name) {
    const stage = getStage(name);
    if (stage === "winner") return { cls: "champ", text: "🏆 Champions of the World!" };
    if (isEliminated(name)) {
        return { cls: "out", text: `Eliminated in ${TRACKER_STAGE_LONG[stage] || stage}` };
    }
    if (stage === "groups") return { cls: "alive", text: "Still in it — playing the group stage" };
    return { cls: "alive", text: `Still in it — through to ${TRACKER_STAGE_LONG[stage] || stage}` };
}

function showTeamDetail(name) {
    const team = findTeam(name);
    if (!team) return;
    const owner = state.assignments[name];
    const standing = teamStanding(name);

    let playedHtml = "", upcomingHtml = "";
    let w = 0, d = 0, l = 0, gf = 0, ga = 0;

    for (const { m, isHome, opponent } of getTeamMatches(name)) {
        const rec = RESULTS[String(m.match)] || {};
        const finished = rec.status === "FINISHED" && rec.homeScore != null;
        const oppFlag = opponent ? teamFlag(opponent) : "";
        const oppName = opponent ? escapeHtml(opponent) : "To be decided";
        const stageLbl = matchStageLabel(m);

        if (finished) {
            const teamScore = isHome ? rec.homeScore : rec.awayScore;
            const oppScore = isHome ? rec.awayScore : rec.homeScore;
            gf += teamScore; ga += oppScore;
            let res, badge;
            if (teamScore > oppScore) { res = "win"; badge = "W"; w++; }
            else if (teamScore < oppScore) { res = "loss"; badge = "L"; l++; }
            else { res = "draw"; badge = "D"; d++; }
            playedHtml += `
                <li class="td-match ${res}">
                    <span class="td-res-badge">${badge}</span>
                    <span class="td-mid">
                        <span class="td-vs">v <span class="td-mflag">${oppFlag}</span>${oppName}</span>
                        <span class="td-mdate">${shortDate(m.ukDate)} &middot; ${stageLbl}</span>
                    </span>
                    <span class="td-mscore">${teamScore}&ndash;${oppScore}</span>
                </li>`;
        } else {
            upcomingHtml += `
                <li class="td-match upcoming">
                    <span class="td-res-badge">⏳</span>
                    <span class="td-mid">
                        <span class="td-vs">v <span class="td-mflag">${oppFlag}</span>${oppName}</span>
                        <span class="td-mdate">${shortDate(m.ukDate)} &middot; ${m.ukTime} &middot; ${stageLbl}</span>
                    </span>
                    <span class="td-mscore">&mdash;</span>
                </li>`;
        }
    }

    const recordHtml = (w + d + l)
        ? `<div class="td-record">Played ${w + d + l} &middot; <strong>W${w} D${d} L${l}</strong> &middot; Goals ${gf}&ndash;${ga}</div>`
        : "";
    const playedSection = playedHtml
        ? `<div class="td-section-title">Results so far</div><ul class="td-matches">${playedHtml}</ul>` : "";
    const upcomingSection = upcomingHtml
        ? `<div class="td-section-title">Still to play</div><ul class="td-matches">${upcomingHtml}</ul>` : "";
    const noneNote = (!playedHtml && !upcomingHtml)
        ? `<div class="td-empty">No matches scheduled yet.</div>` : "";

    const overlay = document.createElement("div");
    overlay.className = "anim-overlay team-detail";
    overlay.innerHTML = `
        <button class="anim-close" aria-label="Close">&times;</button>
        <div class="td-card">
            <div class="td-head">
                <span class="td-flag">${team.flag}</span>
                <div>
                    <div class="td-name">${escapeHtml(team.name)}</div>
                    ${owner ? `<div class="td-owner">${escapeHtml(owner)}'s team</div>` : ""}
                </div>
            </div>
            <div class="td-standing ${standing.cls}">${standing.text}</div>
            ${recordHtml}
            ${playedSection}
            ${upcomingSection}
            ${noneNote}
            <button class="td-replay" type="button">▶ Replay the animation</button>
        </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".anim-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".td-replay").addEventListener("click", () => {
        close();
        playTeamStatus(name);
    });

    requestAnimationFrame(() => overlay.classList.add("show"));
}

// ---- Draw Status ----
function updateDrawStatus() {
    const el = document.getElementById("draw-status");
    if (state.drawComplete) {
        el.innerHTML = `<span class="status-badge complete">Draw complete! Good luck everyone!</span>`;
    } else {
        el.innerHTML = `<span class="status-badge pending">Draw not yet made - watch this space!</span>`;
    }
}

// ---- Bank details ----
function updateBankDetails() {
    const sortEl = document.getElementById("sort-code");
    const accEl = document.getElementById("account-no");
    if (sortEl) sortEl.textContent = state.bankSortCode;
    if (accEl) accEl.textContent = state.bankAccountNo;
}

// ---- Admin ----
function setupAdmin() {
    if (!isAdmin) return;

    document.getElementById("admin-panel").classList.remove("hidden");
    document.getElementById("bracket-admin").classList.remove("hidden");

    // Draw button
    document.getElementById("run-draw-btn").addEventListener("click", runDraw);
    document.getElementById("clear-draw-btn").addEventListener("click", clearDraw);
    document.getElementById("export-btn").addEventListener("click", exportData);
    document.getElementById("import-btn").addEventListener("click", () => {
        document.getElementById("import-file").click();
    });
    document.getElementById("import-file").addEventListener("change", importData);

    // Bracket admin
    populateTeamSelects();
    document.getElementById("eliminate-btn").addEventListener("click", eliminateTeam);
    document.getElementById("reinstate-btn").addEventListener("click", reinstateTeam);
    document.getElementById("advance-btn").addEventListener("click", advanceTeam);
}

function runDraw() {
    const input = document.getElementById("participants-input").value.trim();
    if (!input) {
        alert("Enter some names first!");
        return;
    }

    const names = input.split("\n").map(n => n.trim()).filter(n => n.length > 0);
    const teams = getAllTeams();

    if (names.length > teams.length) {
        alert(`Too many names! You have ${names.length} names but only ${teams.length} teams.`);
        return;
    }

    // Shuffle teams
    const shuffled = [...teams];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Assign
    state.assignments = {};
    for (let i = 0; i < names.length; i++) {
        state.assignments[shuffled[i].name] = names[i];
    }
    state.drawComplete = true;

    // Initialize stages
    state.stages = {};
    for (const team of teams) {
        state.stages[team.name] = "groups";
    }

    saveState(state);

    // Animate
    animateDraw(names, shuffled).then(() => {
        renderGroups();
        renderBracket();
        updateDrawStatus();
        populateTeamSelects();
        launchConfetti();
    });
}

async function animateDraw(names, shuffledTeams) {
    const animDiv = document.getElementById("draw-animation");
    const slotName = document.getElementById("slot-name");
    const slotTeam = document.getElementById("slot-team");
    animDiv.classList.remove("hidden");

    for (let i = 0; i < names.length; i++) {
        slotName.classList.add("spinning");
        slotTeam.classList.add("spinning");

        // Spin for a bit
        const spinTime = 600 + Math.random() * 400;
        const spinInterval = setInterval(() => {
            slotName.textContent = names[Math.floor(Math.random() * names.length)];
            slotTeam.textContent = shuffledTeams[Math.floor(Math.random() * shuffledTeams.length)].name;
        }, 50);

        await sleep(spinTime);
        clearInterval(spinInterval);

        slotName.classList.remove("spinning");
        slotTeam.classList.remove("spinning");
        slotName.textContent = names[i];
        slotTeam.textContent = shuffledTeams[i].name;

        await sleep(800);
    }
}

function clearDraw() {
    if (!confirm("Clear the entire draw? This cannot be undone!")) return;
    state = getDefaultState();
    saveState(state);
    renderGroups();
    renderBracket();
    updateDrawStatus();
    populateTeamSelects();
}

function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sweepstake-data.json";
    a.click();
    URL.revokeObjectURL(url);
}

function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if (typeof data !== "object" || data === null || Array.isArray(data)) {
                throw new Error("not an object");
            }
            state = { ...getDefaultState(), ...data };
            if (typeof state.overrides !== "object" || state.overrides === null) state.overrides = {};
            if (typeof state.assignments !== "object" || state.assignments === null) state.assignments = {};
            saveState(state);
            renderGroups();
            renderBracket();
            updateDrawStatus();
            updateBankDetails();
            populateTeamSelects();
            alert("Data imported!");
        } catch {
            alert("Invalid JSON file!");
        }
    };
    reader.readAsText(file);
}

function populateTeamSelects() {
    const teams = getAllTeams();
    const eliminateSelect = document.getElementById("eliminate-team");
    const advanceSelect = document.getElementById("set-stage-team");

    [eliminateSelect, advanceSelect].forEach(sel => {
        const firstOpt = sel.options[0];
        sel.innerHTML = "";
        sel.appendChild(firstOpt);
        for (const team of teams) {
            const opt = document.createElement("option");
            opt.value = team.name;
            const owner = state.assignments[team.name];
            opt.textContent = `${team.flag} ${team.name}${owner ? ` (${owner})` : ''}`;
            sel.appendChild(opt);
        }
    });
}

// Admin actions write to the overrides layer, which takes precedence over the
// auto-updated results (so the organiser can correct a wrong/late feed by hand).
function setOverride(name, patch) {
    state.overrides[name] = { ...(state.overrides[name] || {}), ...patch };
    saveState(state);
}

function eliminateTeam() {
    const name = document.getElementById("eliminate-team").value;
    if (!name) return;
    if (!isEliminated(name)) {
        setOverride(name, { eliminated: true });
        const team = findTeam(name);
        playEliminationAnimation(team).then(() => {
            renderGroups();
            renderBracket();
            renderFixtures();
        });
    }
}

function reinstateTeam() {
    const name = document.getElementById("eliminate-team").value;
    if (!name) return;
    setOverride(name, { eliminated: false });
    renderGroups();
    renderBracket();
    renderFixtures();
}

function advanceTeam() {
    const name = document.getElementById("set-stage-team").value;
    const stage = document.getElementById("set-stage-to").value;
    if (!name) return;
    const previousStage = getStage(name);
    setOverride(name, { stage, eliminated: false });
    const team = findTeam(name);
    playAdvanceAnimation(team, previousStage, stage).then(() => {
        renderBracket();
        renderFixtures();
    });
}

function findTeam(name) {
    return getAllTeams().find(t => t.name === name);
}

// ---- Confetti ----
function launchConfetti() {
    const canvas = document.getElementById("confetti-canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const pieces = [];
    const colors = ["#FFD700", "#4CAF50", "#e53935", "#1565C0", "#FF9800", "#9C27B0", "#fff"];

    for (let i = 0; i < 150; i++) {
        pieces.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            w: Math.random() * 10 + 5,
            h: Math.random() * 6 + 3,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: (Math.random() - 0.5) * 3,
            vy: Math.random() * 3 + 2,
            rot: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 10
        });
    }

    let frame = 0;
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;

        for (const p of pieces) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.05;
            p.rot += p.rotSpeed;

            if (p.y < canvas.height + 50) alive = true;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rot * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }

        frame++;
        if (alive && frame < 300) {
            requestAnimationFrame(animate);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
    animate();
}

// ---- Elimination: half-mast flag ----
function playEliminationAnimation(team) {
    if (!team) return Promise.resolve();
    const owner = state.assignments[team.name];
    const overlay = document.createElement("div");
    overlay.className = "anim-overlay elimination";
    overlay.innerHTML = `
        <div class="anim-stage">
            <div class="flagpole">
                <div class="pole-top"></div>
                <div class="pole"></div>
                <div class="pole-base"></div>
                <div class="flag-hoist" id="elim-flag">
                    <div class="flag-cloth">
                        <span class="flag-emoji">${team.flag}</span>
                        <span class="flag-name">${escapeHtml(team.name)}</span>
                    </div>
                </div>
            </div>
            <div class="anim-caption">
                <div class="anim-title">Going Home</div>
                <div class="anim-sub">${escapeHtml(team.name)} eliminated${owner ? ` &mdash; commiserations ${escapeHtml(owner)}` : ''}</div>
            </div>
        </div>
        <button class="anim-close" aria-label="Close">&times;</button>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".anim-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    return new Promise(resolve => {
        // Trigger the descent
        requestAnimationFrame(() => {
            overlay.classList.add("show");
            setTimeout(() => {
                overlay.querySelector("#elim-flag").classList.add("half-mast");
            }, 600);
        });
        setTimeout(() => {
            overlay.classList.add("fade-out");
            setTimeout(() => { close(); resolve(); }, 500);
        }, 4200);
    });
}

// ---- Advancement: march toward the trophy ----
const STAGE_PROGRESS = {
    groups: 0,
    r32: 1,
    r16: 2,
    qf: 3,
    sf: 4,
    final: 5,
    winner: 6
};

function playAdvanceAnimation(team, fromStage, toStage, opts = {}) {
    if (!team) return Promise.resolve();
    const review = !!opts.review;
    const owner = state.assignments[team.name];
    const fromIdx = STAGE_PROGRESS[fromStage] ?? 0;
    const toIdx = STAGE_PROGRESS[toStage] ?? 0;
    // Real advancements need to actually move; review mode plays even at equal stages.
    if (!review && toIdx <= fromIdx) return Promise.resolve();

    const stagesPath = ["Groups", "R32", "R16", "QF", "Semi", "Final", "🥅"];
    const totalSteps = 6;
    const startPct = (fromIdx / totalSteps) * 100;
    const endPct = (toIdx / totalSteps) * 100;
    const isWinner = toStage === "winner";
    const eliminated = isEliminated(team.name) && !isWinner;
    const stillInGroups = toIdx === 0;
    let title, sub;
    if (isWinner) {
        title = 'CHAMPIONS!';
        sub = `${escapeHtml(team.name)} lift the Jules Rimet!`;
    } else if (eliminated) {
        title = 'Knocked out';
        sub = stillInGroups
            ? `${escapeHtml(team.name)} went out in the group stage`
            : `${escapeHtml(team.name)} went out in the ${getStageName(toStage)}`;
    } else if (review) {
        title = stillInGroups ? 'Still flying the flag' : 'Marching on!';
        sub = stillInGroups
            ? `${escapeHtml(team.name)} are in the group stage`
            : `${escapeHtml(team.name)} are currently in the ${getStageName(toStage)}`;
    } else {
        title = 'Through to the next round!';
        sub = `${escapeHtml(team.name)} march on to the ${getStageName(toStage)}`;
    }
    const ownerLine = owner
        ? (eliminated ? ` &mdash; commiserations ${escapeHtml(owner)}`
            : isWinner || !review ? ` &mdash; well played ${escapeHtml(owner)}!`
            : ` &mdash; come on ${escapeHtml(owner)}!`)
        : '';

    const overlay = document.createElement("div");
    overlay.className = "anim-overlay advance" + (isWinner ? " winner" : "");
    overlay.innerHTML = `
        <div class="anim-stage advance-stage">
            <div class="march-track">
                <div class="march-pitch"></div>
                <div class="march-checkpoints">
                    ${stagesPath.map((s, i) => {
                        const result = checkpointResult(team.name, CHECKPOINT_STAGE_KEYS[i], i, toIdx, eliminated);
                        const isExit = eliminated && i === toIdx;
                        return `
                        <div class="checkpoint${i <= toIdx ? ' reached' : ''}${i === toIdx ? ' active' : ''}${result ? ` result-${result}` : ''}${isExit ? ' knocked-out' : ''}">
                            <div class="checkpoint-dot"></div>
                            <div class="checkpoint-label">${s}</div>
                        </div>`;
                    }).join("")}
                </div>
                <div class="trophy-target">
                    <div class="trophy-glow"></div>
                    <div class="trophy-icon">🥅</div>
                </div>
                <div class="march-lane">
                    <div class="marcher" id="adv-marcher" style="--start: ${startPct}%; --end: ${endPct}%;">
                        <div class="marcher-flag">${team.flag}</div>
                        <div class="marcher-name">${escapeHtml(team.name)}</div>
                    </div>
                </div>
            </div>
            <div class="anim-caption">
                <div class="anim-title">${title}</div>
                <div class="anim-sub">${sub}${ownerLine}</div>
            </div>
        </div>
        <button class="anim-close" aria-label="Close">&times;</button>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".anim-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    return new Promise(resolve => {
        requestAnimationFrame(() => {
            overlay.classList.add("show");
            setTimeout(() => {
                overlay.querySelector("#adv-marcher").classList.add("marching");
            }, 400);
            if (isWinner) {
                setTimeout(() => launchConfetti(), 1800);
            }
        });
        const duration = isWinner ? 5200 : 4200;
        setTimeout(() => {
            overlay.classList.add("fade-out");
            setTimeout(() => { close(); resolve(); }, 500);
        }, duration);
    });
}

// ---- Helpers ----
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Escapes quotes too, so output is safe in attribute values as well as text.
function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));
}
