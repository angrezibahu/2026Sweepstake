#!/usr/bin/env python3
"""
World Cup 2026 Sweepstake - automatic results updater.

Runs on a schedule (GitHub Actions). For every match whose result is "due"
(kickoff + 4h, i.e. ~2h play + 2h buffer for extra time / penalties) it pulls
the final score from a live-scores API and writes it into results.json. It then
derives the full tournament state - group standings, who qualifies, and the
knockout bracket - into tracker-state.json, which the website reads to show
eliminations and how far each team (and therefore each sweepstake entrant) got.

Primary data source: openfootball (github.com/openfootball/worldcup.json) - free,
public-domain World Cup JSON served from raw.githubusercontent.com. No API key, no
rate limits, no bot protection, so it works from any CI runner out of the box.

Optional fallback: football-data.org v4 (free tier). It is only consulted when the
FOOTBALL_DATA_API_TOKEN secret is set and openfootball is missing a result.

A committed manual-results.json ({"<matchNo>": "2-1", ...}) always wins over every
feed, so results can be corrected or entered by hand if a source is off.

The script is deliberately fail-soft: any network/parse problem is logged and the
run still exits 0 with whatever it could update, so a flaky feed never turns the
schedule red.
"""
import json
import os
import re
import sys
import unicodedata
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEDULE = os.path.join(ROOT, "schedule.json")
RESULTS = os.path.join(ROOT, "results.json")
STATE = os.path.join(ROOT, "tracker-state.json")
MANUAL = os.path.join(ROOT, "manual-results.json")

API_TOKEN = os.environ.get("FOOTBALL_DATA_API_TOKEN", "").strip()
API_COMP = os.environ.get("FOOTBALL_DATA_COMPETITION", "WC").strip()
API_BASE = "https://api.football-data.org/v4"

# Primary feed: openfootball public-domain JSON (no key, no rate limit).
OPENFOOTBALL_URL = os.environ.get(
    "OPENFOOTBALL_URL",
    "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json",
).strip()

# Map provider team names onto the canonical names used in data.js / schedule.json.
# Keys are raw provider spellings; they are matched after normalisation (see
# _norm), so accents/punctuation/case don't need to be repeated here - only
# genuinely different names (e.g. "Czech Republic" -> "Czechia") need listing.
RAW_ALIASES = {
    "czech republic": "Czechia",
    "korea republic": "South Korea",
    "republic of korea": "South Korea",
    "korea dpr": "South Korea",
    "iran": "IR Iran",
    "turkey": "Türkiye",
    "usa": "United States",
    "united states of america": "United States",
    "us": "United States",
    "cote d'ivoire": "Ivory Coast",
    "ivory coast": "Ivory Coast",
    "cabo verde": "Cape Verde",
    "congo dr": "DR Congo",
    "dr congo": "DR Congo",
    "democratic republic of congo": "DR Congo",
}

# Connector words that carry no identifying weight when comparing team names,
# so "Bosnia-Herzegovina" / "Bosnia & Herzegovina" / "Bosnia and Herzegovina"
# all reduce to the same token set.
STOPWORDS = {"and", "of", "the"}


def _norm(name):
    """Lower-case, strip accents, and reduce punctuation to spaces."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _tokens(name):
    return frozenset(t for t in _norm(name).split() if t not in STOPWORDS)


# Alias lookup keyed by normalised spelling.
ALIASES = {_norm(k): v for k, v in RAW_ALIASES.items()}


def now_utc():
    # SWEEPSTAKE_NOW lets tests pin the clock (ISO8601, e.g. 2026-06-28T23:30:00Z).
    override = os.environ.get("SWEEPSTAKE_NOW", "").strip()
    if override:
        return parse_iso(override)
    return datetime.now(timezone.utc)


def parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def load(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def dump(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def canon(name, valid):
    """Best-effort map an external team name to a canonical schedule name."""
    if not name:
        return None
    key = _norm(name)
    if key in ALIASES:
        return ALIASES[key]
    # exact match on the normalised spelling, then on the connector-free token
    # set (so hyphen/"and"/"&"/accent variants all line up)
    ntok = _tokens(name)
    for v in valid:
        if _norm(v) == key:
            return v
    for v in valid:
        if _tokens(v) == ntok:
            return v
    # last resort: substring either direction on the normalised forms
    for v in valid:
        nv = _norm(v)
        if nv and (nv in key or key in nv):
            return v
    return None


# --------------------------------------------------------------------------
# Fetching final scores
# --------------------------------------------------------------------------
def _fetch_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def fetch_openfootball_matches():
    """Return finished matches from the openfootball 2026 JSON, or [] on failure.

    openfootball stores scores as score.ft (90'), score.et (after extra time,
    cumulative) and score.p (penalty shoot-out). We report the score that
    decided the match (et if it went that far, else ft) plus a winner token in
    the same HOME_TEAM/AWAY_TEAM/DRAW shape the rest of the code expects.
    """
    try:
        data = _fetch_json(OPENFOOTBALL_URL)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as e:
        print(f"openfootball fetch failed ({e}); continuing with existing data.")
        return []
    out = []
    for m in data.get("matches", []):
        score = m.get("score") or {}
        result = score.get("et") or score.get("ft")
        if not (isinstance(result, list) and len(result) == 2
                and isinstance(result[0], int) and isinstance(result[1], int)):
            continue  # not played yet, or a malformed entry
        pens = score.get("p")
        if (isinstance(pens, list) and len(pens) == 2
                and isinstance(pens[0], int) and isinstance(pens[1], int)
                and pens[0] != pens[1]):
            winner = "HOME_TEAM" if pens[0] > pens[1] else "AWAY_TEAM"
        elif result[0] > result[1]:
            winner = "HOME_TEAM"
        elif result[1] > result[0]:
            winner = "AWAY_TEAM"
        else:
            winner = "DRAW"
        out.append({
            "home": m.get("team1"),
            "away": m.get("team2"),
            "homeScore": result[0],
            "awayScore": result[1],
            "winner": winner,
            "utcDate": m.get("date"),
        })
    print(f"openfootball returned {len(out)} finished matches.")
    return out


def fetch_r32_pairings(valid):
    """Return the Round-of-32 team pairings from openfootball, regardless of score.

    Used to align our third-place-slot assignments with the real bracket. FIFA's
    allocation of the eight qualifying third-placed teams to specific R32 fixtures
    is one particular valid permutation; picking a *different* valid permutation
    (which plain backtracking can do) leaves a fixture with the wrong opponent, so
    that match's result never matches the feed and it sticks on "awaiting result".

    Returns a list of frozenset({home, away}) canonical-name pairs, or [] on any
    failure so the caller stays fail-soft and falls back to its own assignment.
    """
    try:
        data = _fetch_json(OPENFOOTBALL_URL)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as e:
        print(f"openfootball R32 fetch failed ({e}); using computed bracket.")
        return []
    pairings = []
    for m in data.get("matches", []):
        if (m.get("round") or "").strip().lower() != "round of 32":
            continue
        h, a = canon(m.get("team1"), valid), canon(m.get("team2"), valid)
        if h and a and h != a:
            pairings.append(frozenset((h, a)))
    print(f"openfootball provided {len(pairings)} R32 pairing(s).")
    return pairings


def feed_partner(known, pairings):
    """The team the feed pairs against `known` in R32, or None if unknown/ambiguous."""
    if not known:
        return None
    others = [next(iter(p - {known})) for p in pairings if known in p]
    return others[0] if len(others) == 1 else None


def fetch_api_matches():
    """Return list of finished matches from football-data.org, or [] on failure."""
    if not API_TOKEN:
        print("No FOOTBALL_DATA_API_TOKEN set - skipping API fetch.")
        return []
    url = f"{API_BASE}/competitions/{API_COMP}/matches?status=FINISHED"
    req = urllib.request.Request(url, headers={"X-Auth-Token": API_TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as e:
        print(f"API fetch failed ({e}); continuing with existing data.")
        return []
    out = []
    for m in data.get("matches", []):
        ft = (m.get("score") or {}).get("fullTime") or {}
        # require real integer scores so a malformed feed can't crash the run
        # or write junk into results.json
        if not isinstance(ft.get("home"), int) or not isinstance(ft.get("away"), int):
            continue
        out.append({
            "home": (m.get("homeTeam") or {}).get("name"),
            "away": (m.get("awayTeam") or {}).get("name"),
            "homeScore": ft["home"],
            "awayScore": ft["away"],
            "winner": (m.get("score") or {}).get("winner"),  # HOME_TEAM/AWAY_TEAM/DRAW
            "utcDate": m.get("utcDate"),
        })
    print(f"API returned {len(out)} finished matches.")
    return out


def apply_results(schedule, results):
    """Fill results.json for any match now due, from manual file then the API."""
    valid = {m["home"] for m in schedule if not m["homePlaceholder"]}
    valid |= {m["away"] for m in schedule if not m["awayPlaceholder"]}

    # openfootball is the primary feed; football-data.org only fills gaps when a
    # token is configured. Listing openfootball first means it wins a tie.
    api = fetch_openfootball_matches() + fetch_api_matches()
    # index matches by frozenset of the two canonical team names (first wins)
    api_idx = {}
    for a in api:
        h, w = canon(a["home"], valid), canon(a["away"], valid)
        if h and w:
            api_idx.setdefault(frozenset((h, w)), a)
        else:
            # surface the exact spelling so a missing alias is obvious in logs
            print(f"Unmapped feed match: {a['home']!r} ({h}) vs "
                  f"{a['away']!r} ({w}) - add an alias if these are real teams.")

    manual = load(MANUAL, {}) or {}
    now = now_utc()
    changed = 0

    for m in schedule:
        no = str(m["match"])
        rec = results["results"][no]
        if rec.get("status") == "FINISHED":
            continue
        due = parse_iso(m["resultsDueUTC"])
        if now < due:
            continue  # not enough time has passed since this match finished

        home = rec.get("home")
        away = rec.get("away")

        # 1) manual override wins, e.g. "2-1" (orientation = home-away of this
        # match). For a knockout decided on penalties after a level score, name
        # the side that progressed: "2-2:home" or "2-2:away".
        if no in manual and isinstance(manual[no], str):
            mm = re.match(r"^\s*(\d+)\s*-\s*(\d+)\s*(?::\s*(home|away|h|a)\s*)?$",
                          manual[no], re.IGNORECASE)
            if mm:
                hs, as_ = int(mm.group(1)), int(mm.group(2))
                decider = (mm.group(3) or "").lower()[:1]  # "h" / "a" / ""
                api_winner = {"h": "HOME_TEAM", "a": "AWAY_TEAM"}.get(decider)
                _set_result(rec, hs, as_, api_winner)
                changed += 1
                continue
            print(f"Bad manual result for match {no}: {manual[no]!r} "
                  f"(expected \"2-1\" or \"2-2:home\")")

        # 2) API (only once both teams are known, i.e. not still a placeholder)
        if home and away:
            a = api_idx.get(frozenset((home, away)))
            if a:
                if canon(a["home"], valid) == home:
                    _set_result(rec, a["homeScore"], a["awayScore"], a.get("winner"))
                else:
                    _set_result(rec, a["awayScore"], a["homeScore"], a.get("winner"), flip=True)
                changed += 1
            else:
                # due, both teams known, yet no API result landed - worth a note
                # so a silent mismatch doesn't look like "nothing happened"
                print(f"No result yet for due match {no}: {home} vs {away}.")

    print(f"Updated {changed} match result(s).")
    return changed


def _set_result(rec, home_score, away_score, api_winner=None, flip=False):
    rec["homeScore"] = home_score
    rec["awayScore"] = away_score
    rec["status"] = "FINISHED"
    rec["finishedAt"] = now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")
    if home_score > away_score:
        rec["winner"] = rec.get("home")
    elif away_score > home_score:
        rec["winner"] = rec.get("away")
    else:
        # draw on the day -> knockout decided by ET/pens; trust the API's winner flag
        if api_winner in ("HOME_TEAM", "AWAY_TEAM"):
            home_is = (api_winner == "HOME_TEAM") ^ flip
            # remember the side too, so the winner can still be filled in
            # later if this match's teams aren't resolved yet
            rec["winnerSide"] = "home" if home_is else "away"
            rec["winner"] = rec.get(rec["winnerSide"])
        else:
            rec["winner"] = None  # genuine group-stage draw


# --------------------------------------------------------------------------
# Deriving the tournament state
# --------------------------------------------------------------------------
def group_table(schedule, results, group):
    rows = {}
    teams = set()
    for m in schedule:
        if m.get("group") == group:
            teams.add(m["home"])
            teams.add(m["away"])
    for t in teams:
        rows[t] = {"team": t, "played": 0, "won": 0, "drawn": 0, "lost": 0,
                   "gf": 0, "ga": 0, "gd": 0, "pts": 0}
    for m in schedule:
        if m.get("group") != group:
            continue
        rec = results["results"][str(m["match"])]
        if rec["status"] != "FINISHED":
            continue
        h, a = rec["home"], rec["away"]
        hs, as_ = rec["homeScore"], rec["awayScore"]
        for t, gf, ga in ((h, hs, as_), (a, as_, hs)):
            r = rows[t]
            r["played"] += 1
            r["gf"] += gf
            r["ga"] += ga
            r["gd"] = r["gf"] - r["ga"]
            if gf > ga:
                r["won"] += 1
                r["pts"] += 3
            elif gf == ga:
                r["drawn"] += 1
                r["pts"] += 1
            else:
                r["lost"] += 1
    # FIFA primary ranking: points, goal difference, goals for.
    # (Finer tiebreakers - head-to-head, fair play, drawing of lots - are rare
    # and not reproduced here; the website lets the admin override if needed.)
    order = sorted(rows.values(), key=lambda r: (r["pts"], r["gd"], r["gf"], r["team"]),
                   reverse=True)
    for i, r in enumerate(order):
        r["rank"] = i + 1
    return order


def assign_thirds(third_slots, qualified_thirds, forced=None):
    """Backtracking match: assign each R32 third-place slot a qualifying team
    whose group is in that slot's allowed set. Returns {matchNo: team} or {}.

    `forced` ({matchNo: team}) pins slots whose occupant we already know from the
    real bracket (the feed); each pin is validated against that slot's allowed
    groups, and backtracking then fills only what's left. This keeps our bracket
    matching the official third-place allocation instead of an arbitrary valid one.
    """
    by_group = {t["group"]: t["team"] for t in qualified_thirds}
    group_of = {t["team"]: t["group"] for t in qualified_thirds}
    forced = forced or {}

    result = {}
    used = set()

    # Pin the slots the feed already decides (only when the team is a qualifying
    # third whose group is allowed here and not already taken).
    for s in third_slots:
        team = forced.get(s["match"])
        g = group_of.get(team)
        if g and g in s["allowed"] and g not in used:
            result[s["match"]] = team
            used.add(g)

    remaining = sorted((s for s in third_slots if s["match"] not in result),
                       key=lambda s: len(s["allowed"]))  # most-constrained first

    def bt(i):
        if i == len(remaining):
            return True
        s = remaining[i]
        for g in s["allowed"]:
            if g in by_group and g not in used:
                used.add(g)
                result[s["match"]] = by_group[g]
                if bt(i + 1):
                    return True
                used.discard(g)
                del result[s["match"]]
        return False

    if bt(0):
        return result
    # A feed pin made the rest unsolvable (shouldn't happen with a sane feed);
    # ignore the pins and solve cleanly so we never regress to no assignment.
    if forced:
        return assign_thirds(third_slots, qualified_thirds)
    return {}


def derive_state(schedule, results, prev, r32_pairings=None):
    r32_pairings = r32_pairings or []
    by_no = {m["match"]: m for m in schedule}
    teams = sorted({m["home"] for m in schedule if not m["homePlaceholder"]} |
                   {m["away"] for m in schedule if not m["awayPlaceholder"]})

    stages = {t: "groups" for t in teams}
    eliminated = set()
    standings = {}

    # ---- Group stage ----
    groups = sorted({m["group"] for m in schedule if m.get("group")})
    thirds = []
    qualifiers = {}  # "1A" / "2A" -> team
    for g in groups:
        table = group_table(schedule, results, g)
        standings[g] = table
        complete = all(results["results"][str(m["match"])]["status"] == "FINISHED"
                       for m in schedule if m.get("group") == g)
        if complete:
            qualifiers[f"1{g}"] = table[0]["team"]
            qualifiers[f"2{g}"] = table[1]["team"]
            for t in (table[0]["team"], table[1]["team"]):
                stages[t] = "r32"
            eliminated.add(table[3]["team"])  # 4th is always out
            thirds.append({"group": g, **table[2]})

    # ---- Best third-placed teams (top 8 of 12 advance) ----
    third_team = {}  # matchNo -> team (resolves "3A/B/..." slots)
    all_groups_done = len(thirds) == len(groups) and len(groups) == 12
    if all_groups_done:
        ranked = sorted(thirds, key=lambda r: (r["pts"], r["gd"], r["gf"], r["team"]),
                        reverse=True)
        qualified_thirds = ranked[:8]
        for t in ranked[8:]:
            eliminated.add(t["team"])
        for t in qualified_thirds:
            stages[t["team"]] = "r32"
        slots = []
        for m in schedule:
            # A third-place slot always faces a known seed (a group winner/
            # runner-up); record it so we can read the real opponent off the feed.
            if m["stage"] == "r32" and m["awayPlaceholder"] and m["away"].startswith("3"):
                slots.append({"match": m["match"], "allowed": m["away"][1:].split("/"),
                              "known": qualifiers.get(m["home"])})
            if m["stage"] == "r32" and m["homePlaceholder"] and m["home"].startswith("3"):
                slots.append({"match": m["match"], "allowed": m["home"][1:].split("/"),
                              "side": "home", "known": qualifiers.get(m["away"])})
        # Prefer the real bracket: the third-place team in a slot is whoever the
        # feed pairs against that slot's known seed. Falls back to backtracking
        # for any slot the feed can't resolve (offline, or pairing not listed).
        forced = {s["match"]: feed_partner(s.get("known"), r32_pairings) for s in slots}
        forced = {no: t for no, t in forced.items() if t}
        third_team = assign_thirds(slots, qualified_thirds, forced)

    # ---- Knockout propagation (iterate to a fixed point) ----
    KO_NEXT_STAGE = {"r32": "r16", "r16": "qf", "qf": "sf", "sf": "final", "final": "winner"}

    def resolve(ref, match):
        if ref in qualifiers:
            return qualifiers[ref]
        if re.match(r"^3[A-L/]+$", ref):
            return third_team.get(match)
        m = re.match(r"^([WL])(\d+)$", ref)
        if m:
            kind, src = m.group(1), int(m.group(2))
            rec = results["results"].get(str(src))
            if not rec or rec["status"] != "FINISHED" or not rec.get("winner"):
                return None
            win = rec["winner"]
            loser = rec["home"] if win == rec["away"] else rec["away"]
            return win if kind == "W" else loser
        return None  # already a literal team name handled elsewhere

    for _ in range(8):  # depth of the bracket; converges well before this
        progressed = False
        for m in schedule:
            if m["stage"] == "group":
                continue
            rec = results["results"][str(m["match"])]
            # fill in concrete teams as they become known
            for side, ph in (("home", m["homePlaceholder"]), ("away", m["awayPlaceholder"])):
                if not ph:
                    if rec.get(side) is None:  # a literal team name
                        rec[side] = m[side]
                        progressed = True
                    continue
                t = resolve(m[side], m["match"])
                # Fill an empty slot, or correct a stale resolution from an earlier
                # run (e.g. a third-place slot realigned to the real bracket) - but
                # never rewrite the teams of a match that has already been played.
                if t and rec.get(side) != t and rec.get("status") != "FINISHED":
                    rec[side] = t
                    progressed = True
            # a knockout score applied before its teams were known can't have a
            # winner yet; recompute it now that both teams are resolved
            if (rec["status"] == "FINISHED" and not rec.get("winner")
                    and rec.get("home") and rec.get("away")
                    and rec.get("homeScore") is not None):
                if rec["homeScore"] > rec["awayScore"]:
                    rec["winner"] = rec["home"]
                    progressed = True
                elif rec["awayScore"] > rec["homeScore"]:
                    rec["winner"] = rec["away"]
                    progressed = True
                elif rec.get("winnerSide") in ("home", "away"):
                    # level score decided on pens; the recorded side wins
                    rec["winner"] = rec[rec["winnerSide"]]
                    progressed = True
            # mark stage reached + eliminate the loser of a finished tie
            if rec["status"] == "FINISHED" and rec.get("winner"):
                win = rec["winner"]
                loser = rec["home"] if win == rec["away"] else rec["away"]
                if m["stage"] != "third":
                    nxt = KO_NEXT_STAGE.get(m["stage"])
                    if nxt and stages.get(win) != nxt:
                        stages[win] = nxt
                        progressed = True
                if loser:
                    eliminated.add(loser)
        if not progressed:
            break

    # a team that reached a round but lost is eliminated; champions are not
    eliminated.discard(_champion(schedule, results))

    return {
        "updatedAt": now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "auto",
        "eliminated": sorted(eliminated),
        "stages": stages,
        "standings": standings,
    }


def _champion(schedule, results):
    for m in schedule:
        if m["stage"] == "final":
            rec = results["results"][str(m["match"])]
            if rec["status"] == "FINISHED":
                return rec.get("winner")
    return None


def main():
    schedule = load(SCHEDULE)["matches"]
    results = load(RESULTS)
    prev_state = load(STATE, {})

    valid = {m["home"] for m in schedule if not m["homePlaceholder"]}
    valid |= {m["away"] for m in schedule if not m["awayPlaceholder"]}
    r32_pairings = fetch_r32_pairings(valid)

    changed = apply_results(schedule, results)
    # derive_state also fills concrete teams into knockout fixtures as earlier
    # rounds finish (and aligns third-place slots to the real bracket).
    state = derive_state(schedule, results, prev_state, r32_pairings)
    # Resolving knockout teams can correct a fixture's opponent (a third-place
    # slot realigned to match the feed); run the apply/derive pass once more so
    # the feed result for that now-correct pairing lands in the same run.
    changed += apply_results(schedule, results)
    state = derive_state(schedule, results, prev_state, r32_pairings)

    results["updatedAt"] = now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")
    # Persist results.json after deriving so the filled-in teams are kept.
    dump(RESULTS, results)
    dump(STATE, state)

    print(f"Done. {changed} new result(s); "
          f"{len(state['eliminated'])} team(s) eliminated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
