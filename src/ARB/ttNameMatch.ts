/**
 * ttNameMatch.ts -- Player/team name matching, sport abbreviation tables, and series classification.
 * Pure functions -- no mutable state, no I/O, no side effects.
 */

// --- Date extraction from PM slugs -------------------------------------------

/** Extract YYYY-MM-DD date from a Polymarket slug.
 *  Handles both "mlb-min-kc-2026-03-30" and "cs2-vit-navi-2026-03-29-game2". */
export function parseDateFromPmSlug(slug: string): string {
  const m = slug.match(/(\d{4}-\d{2}-\d{2})(?:-|$)/);
  return m ? m[1] : "";
}

/** Check if two date strings refer to the same calendar day. Empty strings don't match. */
export function datesMatch(kalDate: string, pmDate: string): boolean {
  if (!kalDate || !pmDate) return false;
  return kalDate === pmDate;
}

/** Check if two dates are within ±1 day. For tennis, Kalshi uses tournament-day dates
 *  while PM uses ET calendar dates, causing consistent 1-day offsets for non-US events. */
export function datesMatchTennis(kalDate: string, pmDate: string): boolean {
  if (!kalDate || !pmDate) return false;
  if (kalDate === pmDate) return true;
  const kalMs = new Date(kalDate + "T12:00:00Z").getTime();
  const pmMs = new Date(pmDate + "T12:00:00Z").getTime();
  if (isNaN(kalMs) || isNaN(pmMs)) return false;
  return Math.abs(kalMs - pmMs) <= 86_400_000; // ±1 day
}

// --- Entity name extraction from market titles -------------------------------

export function extractEntityName(title: string): string {
  const mWin = title.match(/^Will\s+(.+?)\s+win\b/i);
  if (mWin) return mWin[1].trim();
  const mBeat = title.match(/^Will\s+(?:the\s+)?(.+?)\s+beat\b/i);
  if (mBeat) return mBeat[1].trim();
  if (/\b(?:tie|draw)\b/i.test(title)) {
    if (/\bdraw\b/i.test(title)) return "Draw";
    return "Tie";
  }
  const mGeneric = title.match(/^Will\s+(?:the\s+)?(.+?)\s+(?:defeat|advance|qualify|make|reach|finish)\b/i);
  if (mGeneric) return mGeneric[1].trim();
  return "";
}

export function pmSlugToken(fullName: string): string {
  const last = fullName.trim().split(/\s+/).pop() ?? fullName;
  return last.toLowerCase().slice(0, 7);
}

// --- Date parsing from tickers and titles ------------------------------------

export const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

export function parseDateFromTicker(ticker: string): string {
  const m = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return "";
  return `20${m[1]}-${MONTHS[m[2].toUpperCase()] ?? "01"}-${m[3].padStart(2, "0")}`;
}

/** Parse full start datetime (UTC) from Kalshi ticker.
 *  Tickers encode date + optional time: KXCS2GAME-26APR031330HEROBB → Apr 3 13:30 UTC
 *  Format: -YY{MON}{DD}{HHMM?}{teams}- where HHMM is optional 4-digit time.
 *  Returns epoch ms, or 0 if not parseable. */
export function parseStartTimeFromTicker(ticker: string): number {
  // Match: YY + MON + DD + optional 4-digit time (HHMM) followed by non-digit (team names)
  const m = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{4})?/i);
  if (!m) return 0;
  const year = 2000 + parseInt(m[1], 10);
  const month = MONTHS[m[2].toUpperCase()] ?? "01";
  const day = m[3].padStart(2, "0");
  if (m[4]) {
    // Has time: HHMM
    const hh = m[4].slice(0, 2);
    const mm = m[4].slice(2, 4);
    return new Date(`${year}-${month}-${day}T${hh}:${mm}:00Z`).getTime();
  }
  // Date only — return midnight UTC (we can't tell if match started without time)
  return 0;
}

export function matchCodePrefix(ticker: string): string {
  return ticker.replace(/-[^-]+$/, "");
}

export function parseDateFromEventTitle(title: string): string {
  const m = title.match(/\(\s*(\w{3})\s+(\d{1,2})(?:,?\s*(\d{4}))?\s*\)/);
  if (!m) return "";
  const month = MONTHS[m[1].toUpperCase()];
  if (!month) return "";
  const year = m[3] ?? new Date().getFullYear().toString();
  return `${year}-${month}-${m[2].padStart(2, "0")}`;
}

// --- Series -> PM slug prefix mapping -----------------------------------------

export const SERIES_TO_PM_PREFIX: Record<string, string> = {
  // Esports
  KXATPMATCH: "atp",    KXWTAMATCH: "wta",
  KXATPCHALLENGERMATCH: "atp",
  KXWTACHALLENGERMATCH: "wta",
  KXATPSETWINNER: "atp",
  KXATPGAMETOTAL: "atp",
  KXCS2GAME: "cs2",     KXCS2MAP: "cs2",     KXCS2TOTALMAPS: "cs2",
  KXLOLGAME: "lol",     KXLOLMAP: "lol",     KXLOLTOTALMAPS: "lol",
  KXDOTA2GAME: "dota2", KXDOTA2MAP: "dota2",
  KXVALORANTGAME: "val",  KXVALORANTMAP: "val",
  KXCSGAME: "cs2",        KXCSMAP: "cs2",
  KXCODGAME: "codmw",     KXCODMAP: "codmw",
  // Basketball
  KXNBAGAME: "nba",     KXNBASPREAD: "nba",   KXNBATOTAL: "nba",
  KXNBLGAME: "bknbl",
  KXCBAGAME: "bkcba",
  KXKBLGAME: "bkkbl",
  KXACBGAME: "bkacb",
  KXBBLGAME: "bkbbl",
  KXBSLGAME: "bkbsl",
  KXVTBGAME: "bkvtb",
  KXABAGAME: "bkaba",
  KXEUROLEAGUEGAME: "euroleague",
  KXARGLNBGAME: "bkarg",
  KXBBSERIEAGAME: "bkseriea",
  // Hockey
  KXNHLGAME: "nhl",     KXNHLSPREAD: "nhl",   KXNHLTOTAL: "nhl",
  // Baseball
  KXMLBGAME: "mlb",
  KXMLBSTGAME: "mlb",
  // College basketball
  KXNCAAMBGAME: "cbb",   KXNCAAMBSPREAD: "cbb",
  KXNCAAWBGAME: "cwbb",
  // Soccer -- Top 5 leagues
  KXEPLGAME: "epl",         KXEPLSPREAD: "epl",         KXEPLTOTAL: "epl",
  KXLALIGAGAME: "lal",      KXLALIGASPREAD: "lal",      KXLALIGATOTAL: "lal",
  KXBUNDESLIGAGAME: "bun",  KXBUNDESLIGASPREAD: "bun",  KXBUNDESLIGATOTAL: "bun",
  KXSERIEAGAME: "sea",      KXSERIEASPREAD: "sea",      KXSERIEATOTAL: "sea",
  KXLIGUE1GAME: "fl1",      KXLIGUE1SPREAD: "fl1",      KXLIGUE1TOTAL: "fl1",
  // Soccer -- MLS
  KXMLSGAME: "mls",         KXMLSSPREAD: "mls",         KXMLSTOTAL: "mls",
  // Soccer -- European cups
  KXUCLGAME: "ucl",         KXUCLSPREAD: "ucl",         KXUCLTOTAL: "ucl",
  KXUELGAME: "uel",         KXUELSPREAD: "uel",         KXUELTOTAL: "uel",
  // Soccer -- Other European
  KXEFLCHAMPIONSHIPGAME: "elc",
  KXSCOTTISHPREMGAME: "scop",
  KXEREDIVISIEGAME: "ere",
  KXLIGAPORTUGALGAME: "por",
  KXSUPERLIGGAME: "tur",
  KXBELGIANPLGAME: "bel",
  KXEKSTRAKLASAGAME: "pol",
  KXSLGREECEGAME: "gre",
  KXSWISSLEAGUEGAME: "swi",
  KXDENSUPERLIGAGAME: "den",
  KXHNLGAME: "cro",
  // Soccer -- Second divisions
  KXBUNDESLIGA2GAME: "bl2",
  KXLALIGA2GAME: "es2",
  KXSERIEBGAME: "itsb",
  // Soccer -- Americas
  KXLIGAMXGAME: "mex",
  KXBRASILEIROGAME: "bra",     KXBRASILEIROSPREAD: "bra",   KXBRASILEIROTOTAL: "bra",
  KXARGPREMDIVGAME: "arg",
  KXDIMAYORGAME: "col1",
  KXCHLLDPGAME: "chi1",
  KXECULPGAME: "ecu",
  KXURYPDGAME: "uru",
  KXVENFUTVEGAME: "ven",
  KXAPFDDHGAME: "par",
  KXUSLGAME: "usl",
  KXNWSLGAME: "nwsl",
  KXCONCACAFCCUPGAME: "conc",
  // Soccer -- Asia / Middle East / Other
  KXSAUDIPLGAME: "spl",       KXSAUDIPLSPREAD: "spl",     KXSAUDIPLTOTAL: "spl",
  KXKLEAGUEGAME: "kor",
  KXJLEAGUEGAME: "j1-100",
  KXALEAGUEGAME: "aus",
  KXCHNSLGAME: "chi",
  KXTHAIL1GAME: "tha",
  KXAFCCLGAME: "afc",
  // Soccer -- International
  KXINTLFRIENDLYGAME: "fif",
  KXFIFAGAME: "uef",
  // Soccer -- Cups
  KXFACUPGAME: "efa",
  KXEFLCUPGAME: "efl",
  // Soccer -- Women
  KXEWSLGAME: "ewsl",
};

// --- Series classification Sets ----------------------------------------------

export const TENNIS_SERIES = new Set(["KXATPMATCH", "KXWTAMATCH", "KXATPCHALLENGERMATCH", "KXWTACHALLENGERMATCH"]);
export const NBA_SERIES = new Set(["KXNBAGAME"]);
export const NHL_SERIES = new Set(["KXNHLGAME"]);
export const MLB_SERIES = new Set(["KXMLBGAME", "KXMLBSTGAME"]);
export const CBB_SERIES = new Set(["KXNCAAMBGAME", "KXNCAAWBGAME"]);

export const NON_MONEYLINE_BINARY_SERIES = new Set([
  "KXNBASPREAD", "KXNBATOTAL",
  "KXNHLSPREAD", "KXNHLTOTAL",
  "KXNCAAMBSPREAD",
  "KXATPGAMETOTAL",
  "KXCS2TOTALMAPS", "KXLOLTOTALMAPS",
  "KXEPLSPREAD", "KXEPLTOTAL",
  "KXMLSSPREAD", "KXMLSTOTAL",
  "KXUCLSPREAD", "KXUCLTOTAL",
  "KXUELSPREAD", "KXUELTOTAL",
  "KXLALIGASPREAD", "KXLALIGATOTAL",
  "KXSERIEASPREAD", "KXSERIEATOTAL",
  "KXBUNDESLIGASPREAD", "KXBUNDESLIGATOTAL",
  "KXLIGUE1SPREAD", "KXLIGUE1TOTAL",
  "KXBRASILEIROSPREAD", "KXBRASILEIROTOTAL",
  "KXSAUDIPLSPREAD", "KXSAUDIPLTOTAL",
  "KXARGPREMDIVSPREAD", "KXARGPREMDIVTOTAL",
  "KXKLEAGUESPREAD", "KXKLEAGUETOTAL",
]);

export const SET_WINNER_SERIES = new Set(["KXATPSETWINNER"]);

export const SOCCER_SERIES = new Set([
  "KXEPLGAME", "KXLALIGAGAME", "KXBUNDESLIGAGAME", "KXSERIEAGAME", "KXLIGUE1GAME", "KXMLSGAME",
  "KXUCLGAME", "KXUELGAME",
  "KXEFLCHAMPIONSHIPGAME", "KXSCOTTISHPREMGAME", "KXEREDIVISIEGAME", "KXLIGAPORTUGALGAME",
  "KXSUPERLIGGAME", "KXBELGIANPLGAME", "KXEKSTRAKLASAGAME", "KXSLGREECEGAME",
  "KXSWISSLEAGUEGAME", "KXDENSUPERLIGAGAME", "KXHNLGAME",
  "KXBUNDESLIGA2GAME", "KXLALIGA2GAME", "KXSERIEBGAME",
  "KXLIGAMXGAME", "KXBRASILEIROGAME", "KXARGPREMDIVGAME", "KXDIMAYORGAME",
  "KXCHLLDPGAME", "KXECULPGAME", "KXURYPDGAME", "KXVENFUTVEGAME", "KXAPFDDHGAME",
  "KXUSLGAME", "KXNWSLGAME", "KXCONCACAFCCUPGAME",
  "KXSAUDIPLGAME", "KXKLEAGUEGAME", "KXJLEAGUEGAME", "KXALEAGUEGAME",
  "KXCHNSLGAME", "KXTHAIL1GAME", "KXAFCCLGAME",
  "KXINTLFRIENDLYGAME", "KXFIFAGAME",
  "KXFACUPGAME", "KXEFLCUPGAME",
  "KXEWSLGAME",
  "KXEPLSPREAD", "KXEPLTOTAL",
  "KXMLSSPREAD", "KXMLSTOTAL",
  "KXUCLSPREAD", "KXUCLTOTAL",
  "KXUELSPREAD", "KXUELTOTAL",
  "KXLALIGASPREAD", "KXLALIGATOTAL",
  "KXSERIEASPREAD", "KXSERIEATOTAL",
  "KXBUNDESLIGASPREAD", "KXBUNDESLIGATOTAL",
  "KXLIGUE1SPREAD", "KXLIGUE1TOTAL",
  "KXBRASILEIROSPREAD", "KXBRASILEIROTOTAL",
  "KXSAUDIPLSPREAD", "KXSAUDIPLTOTAL",
]);

// --- Team abbreviation tables ------------------------------------------------

export const NHL_TEAM_ABBRS: Record<string, string> = {
  "anaheim ducks": "ana", "arizona coyotes": "ari", "boston bruins": "bos",
  "buffalo sabres": "buf", "calgary flames": "cal", "carolina hurricanes": "car",
  "chicago blackhawks": "chi", "colorado avalanche": "col", "columbus blue jackets": "cbj",
  "dallas stars": "dal", "detroit red wings": "det", "edmonton oilers": "edm",
  "florida panthers": "fla", "los angeles kings": "lak", "minnesota wild": "min",
  "montreal canadiens": "mon", "nashville predators": "nsh", "new jersey devils": "nj",
  "new york islanders": "nyi", "new york rangers": "nyr", "ottawa senators": "ott",
  "philadelphia flyers": "phi", "pittsburgh penguins": "pit", "san jose sharks": "sj",
  "seattle kraken": "sea", "st. louis blues": "stl", "st louis blues": "stl",
  "tampa bay lightning": "tb", "toronto maple leafs": "tor", "utah hockey club": "utah", "utah mammoth": "utah",
  "vancouver canucks": "van", "vegas golden knights": "las", "washington capitals": "wsh",
  "winnipeg jets": "wpg",
};

export const NBA_TEAM_ABBRS: Record<string, string> = {
  "atlanta hawks": "atl", "boston celtics": "bos", "brooklyn nets": "bkn",
  "charlotte hornets": "cha", "chicago bulls": "chi", "cleveland cavaliers": "cle",
  "dallas mavericks": "dal", "denver nuggets": "den", "detroit pistons": "det",
  "golden state warriors": "gsw", "houston rockets": "hou", "indiana pacers": "ind",
  "los angeles clippers": "lac", "los angeles lakers": "lal", "memphis grizzlies": "mem",
  "miami heat": "mia", "milwaukee bucks": "mil", "minnesota timberwolves": "min",
  "new orleans pelicans": "nop", "new york knicks": "nyk", "oklahoma city thunder": "okc",
  "orlando magic": "orl", "philadelphia 76ers": "phi", "phoenix suns": "phx",
  "portland trail blazers": "por", "sacramento kings": "sac", "san antonio spurs": "sas",
  "toronto raptors": "tor", "utah jazz": "uta", "washington wizards": "was",
};

export const SOCCER_TEAM_ABBRS: Record<string, string> = {
  // EPL
  "arsenal": "ars", "aston villa": "ast", "bournemouth": "bou", "brentford": "bre",
  "brighton": "bri", "burnley": "bur", "chelsea": "che", "crystal palace": "cry",
  "everton": "eve", "fulham": "ful", "ipswich": "ips", "leeds": "lee",
  "leicester": "lei", "liverpool": "liv", "luton": "lut", "manchester city": "mac",
  "man city": "mac", "manchester united": "mau", "man united": "mau", "man utd": "mau",
  "newcastle": "new", "nottingham forest": "not", "nottingham": "not",
  "sheffield united": "she", "southampton": "sou", "sunderland": "sun",
  "tottenham": "tot", "west ham": "wes", "wolverhampton": "wol", "wolves": "wol",
  // La Liga
  "atletico madrid": "mad", "atletico": "mad", "real madrid": "rea",
  "real sociedad": "rea", "athletic bilbao": "bil", "athletic": "bil",
  "real betis": "bet", "celta vigo": "cel", "celta": "cel",
  "rayo vallecano": "ray", "deportivo alaves": "ala", "alaves": "ala",
  "espanyol": "esp", "las palmas": "las", "cadiz": "cad",
  // Bundesliga
  "bayern munich": "bay", "bayern": "bay", "borussia dortmund": "dor", "dortmund": "dor",
  "rb leipzig": "lei", "leipzig": "lei", "bayer leverkusen": "b04", "leverkusen": "b04",
  "eintracht frankfurt": "ein", "frankfurt": "ein", "borussia monchengladbach": "mon",
  "sc freiburg": "fre", "freiburg": "fre", "vfb stuttgart": "stu", "stuttgart": "stu",
  "union berlin": "uni", "werder bremen": "wer", "bremen": "wer",
  "hoffenheim": "hof", "wolfsburg": "wol", "augsburg": "aug", "heidenheim": "hei",
  "mainz": "mai", "bochum": "boc", "st pauli": "stp", "hamburg": "hsv",
  "koln": "koe", "cologne": "koe", "gladbach": "moe", "monchengladbach": "moe",
  // Ligue 1
  "monaco": "asm", "as monaco": "asm", "nice": "ogc", "ogc nice": "ogc",
  "psg": "psg", "paris saint-germain": "psg", "paris": "pfc",
  "lyon": "lyo", "olympique lyonnais": "lyo",
  "marseille": "mar", "olympique marseille": "mar",
  "lille": "lil", "lens": "rcl", "rc lens": "rcl",
  "rennes": "ren", "stade rennais": "ren",
  "strasbourg": "str", "rc strasbourg": "str",
  "toulouse": "tou", "nantes": "nan", "montpellier": "mon",
  "lorient": "lor", "le havre": "hac", "metz": "met",
  "stade brest": "sbr", "brest": "sbr", "clermont": "cle",
  "auxerre": "aja", "angers": "ang", "reims": "rei",
  // MLS
  "toronto": "tor", "toronto fc": "tor",
  "new york red bulls": "nyr", "ny red bulls": "nyr",
  "philadelphia union": "phi",
  "atlanta united": "atl", "atlanta": "atl",
  "inter miami": "mia",
  "la galaxy": "lag", "los angeles galaxy": "lag",
  "lafc": "laf", "los angeles fc": "laf",
  "seattle sounders": "sea", "portland timbers": "por",
  "nashville sc": "nas", "columbus crew": "col",
  "charlotte fc": "clf", "new york city fc": "nyc",
  "new england revolution": "ner",
  "orlando city": "orl", "chicago fire": "cfc",
  "houston dynamo": "hou", "fc dallas": "dal",
  "sporting kc": "skc", "kansas city": "skc",
  "minnesota united": "min", "austin fc": "aus",
  "real salt lake": "rsl", "colorado rapids": "cor",
  "san jose earthquakes": "sje", "vancouver whitecaps": "van",
  "st louis city": "stl",
  "dc united": "dcu",
};

export const MLB_TEAM_ABBRS: Record<string, string> = {
  "arizona diamondbacks": "ari", "diamondbacks": "ari", "arizona": "ari",
  "atlanta braves": "atl", "braves": "atl",
  "baltimore orioles": "bal", "orioles": "bal", "baltimore": "bal",
  "boston red sox": "bos", "red sox": "bos",
  "chicago cubs": "chc", "cubs": "chc", "chicago c": "chc",
  "chicago white sox": "cws", "white sox": "cws", "chicago ws": "cws",
  "cincinnati reds": "cin", "reds": "cin", "cincinnati": "cin",
  "cleveland guardians": "cle", "guardians": "cle", "cleveland": "cle",
  "colorado rockies": "col", "rockies": "col", "colorado": "col",
  "detroit tigers": "det", "tigers": "det", "detroit": "det",
  "houston astros": "hou", "astros": "hou",
  "kansas city royals": "kc", "royals": "kc",
  "los angeles angels": "laa", "angels": "laa", "los angeles a": "laa",
  "los angeles dodgers": "lad", "dodgers": "lad", "los angeles d": "lad",
  "miami marlins": "mia", "marlins": "mia",
  "milwaukee brewers": "mil", "brewers": "mil", "milwaukee": "mil",
  "minnesota twins": "min", "twins": "min",
  "new york mets": "nym", "mets": "nym", "new york m": "nym",
  "new york yankees": "nyy", "yankees": "nyy", "new york y": "nyy",
  "oakland athletics": "oak", "athletics": "oak", "oakland": "oak", "a's": "oak",
  "philadelphia phillies": "phi", "phillies": "phi",
  "pittsburgh pirates": "pit", "pirates": "pit", "pittsburgh": "pit",
  "san diego padres": "sd", "padres": "sd", "san diego": "sd",
  "san francisco giants": "sf", "giants": "sf", "san francisco": "sf",
  "seattle mariners": "sea", "mariners": "sea", "seattle": "sea",
  "st. louis cardinals": "stl", "st louis cardinals": "stl", "cardinals": "stl",
  "tampa bay rays": "tb", "rays": "tb", "tampa bay": "tb",
  "texas rangers": "tex", "rangers": "tex", "texas": "tex",
  "toronto blue jays": "tor", "blue jays": "tor",
  "washington nationals": "wsh", "nationals": "wsh",
};

// --- CBB name aliases --------------------------------------------------------

export const CBB_NAME_ALIASES: Record<string, string> = {
  "uconn": "connecticut",
  "conn": "connecticut",
  "smu": "southern methodist",
  "ucf": "central florida",
  "byu": "brigham young",
  "vcu": "virginia commonwealth",
  "umass": "massachusetts",
  "ole miss": "mississippi",
  "usc": "southern california",
  "lsu": "louisiana state",
  "unlv": "nevada las vegas",
  "utep": "texas el paso",
  "unc": "north carolina",
  "uab": "alabama birmingham",
  "utsa": "texas san antonio",
};

// --- Name matching functions -------------------------------------------------

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

export function namesMatch(kalName: string, pmOutcome: string): boolean {
  const k = normalizeName(kalName);
  const p = normalizeName(pmOutcome);
  if (!k || !p) return false;
  if (k === p) return true;
  if (p.includes(k) || k.includes(p)) return true;
  const kw = k.split(" "), pw = p.split(" ");
  const [shorter, longer] = kw.length <= pw.length ? [kw, pw] : [pw, kw];
  if (shorter.length === 1 && shorter[0].length >= 4 && shorter.every(w => longer.includes(w))) return true;
  if (shorter.length > 1 && shorter.every(w => longer.includes(w))) return true;
  for (const [full, abbr] of [[k, p], [p, k]] as [string, string][]) {
    const a = abbr.replace(/\d+$/, "").replace(/\s/g, "");
    if (a.length < 2) continue;
    const words = full.split(" ").filter(w => w.length > 0);
    const initials = words.map(w => w[0]).join("");
    if (initials === a) return true;
    if (full.replace(/\s/g, "").startsWith(a)) return true;
  }
  return false;
}

export function fuzzyIntlNamesMatch(kalName: string, pmName: string): boolean {
  const k = normalizeName(kalName);
  const p = normalizeName(pmName);
  if (!k || !p) return false;
  if (namesMatch(kalName, pmName)) return true;
  const EURO_PREFIXES = /^(bc|kk|fk|fc|sc|sk|as|ia|saski|real|sporting|instituto|samsung|seoul)\s+/i;
  const kStripped = k.replace(EURO_PREFIXES, "").split(" ").filter(w => w.length >= 4);
  const pStripped = p.replace(EURO_PREFIXES, "").split(" ").filter(w => w.length >= 4);
  if (kStripped.length > 0 && pStripped.length > 0) {
    const shared = kStripped.filter(w => pStripped.some(pw => pw === w || pw.startsWith(w) || w.startsWith(pw)));
    if (shared.length >= 1 && shared[0].length >= 5) return true;
  }
  return false;
}

// --- CBB name matching -------------------------------------------------------

export function cbbExpandName(name: string): string {
  const n = name.toLowerCase().trim();
  return CBB_NAME_ALIASES[n] ?? n;
}

export function cbbNamesMatch(kalName: string, pmOutcome: string): boolean {
  if (namesMatch(kalName, pmOutcome)) return true;
  const expanded = cbbExpandName(kalName);
  if (expanded !== kalName.toLowerCase().trim() && namesMatch(expanded, pmOutcome)) return true;
  const pmExpanded = cbbExpandName(pmOutcome);
  if (pmExpanded !== pmOutcome.toLowerCase().trim() && namesMatch(kalName, pmExpanded)) return true;
  return false;
}

// --- Sport-specific abbreviation lookups -------------------------------------

export function soccerNameToAbbr(entityName: string): string {
  const norm = entityName.toLowerCase().trim().replace(/^the\s+/, "");
  if (SOCCER_TEAM_ABBRS[norm]) return SOCCER_TEAM_ABBRS[norm];
  for (const [full, abbr] of Object.entries(SOCCER_TEAM_ABBRS)) {
    if (norm.includes(full) || full.includes(norm)) return abbr;
  }
  return norm.replace(/[^a-z]/g, "").slice(0, 3);
}

export function mlbNameToAbbr(entityName: string): string {
  const norm = entityName.toLowerCase().trim().replace(/^the\s+/, "");
  if (MLB_TEAM_ABBRS[norm]) return MLB_TEAM_ABBRS[norm];
  for (const [full, abbr] of Object.entries(MLB_TEAM_ABBRS)) {
    const parts = full.split(" ");
    const nickname = parts[parts.length - 1];
    const city = parts.slice(0, -1).join(" ");
    if (norm === nickname || norm === city) return abbr;
  }
  for (const [full, abbr] of Object.entries(MLB_TEAM_ABBRS)) {
    if (norm.includes(full) || full.includes(norm)) return abbr;
  }
  return "";
}

export function nbaNameToAbbr(entityName: string): string {
  const norm = entityName.toLowerCase().trim().replace(/^the\s+/, "");
  if (NBA_TEAM_ABBRS[norm]) return NBA_TEAM_ABBRS[norm];
  for (const [full, abbr] of Object.entries(NBA_TEAM_ABBRS)) {
    const parts = full.split(" ");
    const nickname = parts[parts.length - 1];
    const city = parts.slice(0, -1).join(" ");
    if (norm === nickname || norm === city) return abbr;
  }
  for (const [full, abbr] of Object.entries(NBA_TEAM_ABBRS)) {
    if (norm.includes(full) || full.includes(norm)) return abbr;
  }
  return "";
}

export function nhlNameToAbbr(entityName: string): string {
  const norm = entityName.toLowerCase().trim().replace(/^the\s+/, "");
  if (NHL_TEAM_ABBRS[norm]) return NHL_TEAM_ABBRS[norm];
  for (const [full, abbr] of Object.entries(NHL_TEAM_ABBRS)) {
    const parts = full.split(" ");
    const nickname = parts[parts.length - 1];
    const city = parts.slice(0, -1).join(" ");
    if (norm === nickname || norm === city) return abbr;
  }
  for (const [full, abbr] of Object.entries(NHL_TEAM_ABBRS)) {
    if (norm.includes(full) || full.includes(norm)) return abbr;
  }
  const spaceIdx = norm.indexOf(" ");
  if (spaceIdx > 0 && spaceIdx <= 4) {
    const nicknamePart = norm.slice(spaceIdx + 1);
    for (const [full, _abbr] of Object.entries(NHL_TEAM_ABBRS)) {
      const parts = full.split(" ");
      for (let i = 1; i < parts.length; i++) {
        if (nicknamePart === parts.slice(i).join(" ")) return _abbr;
      }
    }
  }
  if (norm === "new york r") return "nyr";
  if (norm === "new york i") return "nyi";
  return "";
}
