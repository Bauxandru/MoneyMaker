import { describe, it, expect } from "vitest";
import {
  extractEntityName, pmSlugToken, parseDateFromTicker, parseDateFromEventTitle,
  matchCodePrefix, normalizeName, namesMatch, fuzzyIntlNamesMatch,
  cbbExpandName, cbbNamesMatch,
  soccerNameToAbbr, mlbNameToAbbr, nbaNameToAbbr, nhlNameToAbbr,
  SERIES_TO_PM_PREFIX, TENNIS_SERIES, NBA_SERIES, NHL_SERIES, MLB_SERIES,
  CBB_SERIES, SOCCER_SERIES, NON_MONEYLINE_BINARY_SERIES, SET_WINNER_SERIES,
} from "./ttNameMatch.js";

// ─── extractEntityName ──────────────────────────────────────────────────────

describe("extractEntityName", () => {
  it("extracts 'Will X win' pattern", () => {
    expect(extractEntityName("Will Djokovic win the match?")).toBe("Djokovic");
  });

  it("extracts 'Will X beat' pattern", () => {
    expect(extractEntityName("Will the Lakers beat the Celtics?")).toBe("Lakers");
  });

  it("returns Draw for draw markets", () => {
    expect(extractEntityName("Will the match end in a draw?")).toBe("Draw");
  });

  it("returns Tie for tie markets", () => {
    expect(extractEntityName("Will the game end in a tie?")).toBe("Tie");
  });

  it("extracts defeat/advance/qualify patterns", () => {
    expect(extractEntityName("Will France advance to the final?")).toBe("France");
  });

  it("returns empty for unmatched titles", () => {
    expect(extractEntityName("Total goals over 2.5")).toBe("");
  });

  it("handles empty string", () => {
    expect(extractEntityName("")).toBe("");
  });
});

// ─── pmSlugToken ────────────────────────────────────────────────────────────

describe("pmSlugToken", () => {
  it("returns last word, lowercase, max 7 chars", () => {
    expect(pmSlugToken("Carlos Alcaraz")).toBe("alcaraz");
  });

  it("handles single word", () => {
    expect(pmSlugToken("Djokovic")).toBe("djokovi");
  });

  it("handles empty string", () => {
    expect(pmSlugToken("")).toBe("");
  });

  it("trims whitespace", () => {
    expect(pmSlugToken("  LeBron James  ")).toBe("james");
  });
});

// ─── parseDateFromTicker ────────────────────────────────────────────────────

describe("parseDateFromTicker", () => {
  it("parses standard ticker format", () => {
    expect(parseDateFromTicker("KXATPMATCH-26MAR09-DJOKOVIC")).toBe("2026-03-09");
  });

  it("parses case insensitive", () => {
    expect(parseDateFromTicker("KXNBAGAME-25jan15LALBOS")).toBe("2025-01-15");
  });

  it("returns empty for no date", () => {
    expect(parseDateFromTicker("NODATEHERE")).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(parseDateFromTicker("")).toBe("");
  });
});

// ─── parseDateFromEventTitle ────────────────────────────────────────────────

describe("parseDateFromEventTitle", () => {
  it("parses (Mon DD, YYYY) format", () => {
    expect(parseDateFromEventTitle("Lakers vs Celtics (Mar 15, 2025)")).toBe("2025-03-15");
  });

  it("parses without year (defaults to current year)", () => {
    const result = parseDateFromEventTitle("Game (Jan 5)");
    expect(result).toMatch(/^\d{4}-01-05$/);
  });

  it("returns empty for no date", () => {
    expect(parseDateFromEventTitle("No date here")).toBe("");
  });

  it("returns empty for invalid month", () => {
    expect(parseDateFromEventTitle("(Xyz 15, 2025)")).toBe("");
  });
});

// ─── matchCodePrefix ────────────────────────────────────────────────────────

describe("matchCodePrefix", () => {
  it("strips last segment after dash", () => {
    expect(matchCodePrefix("KXATPMATCH-26MAR09-DJOKOVIC")).toBe("KXATPMATCH-26MAR09");
  });

  it("returns full string if no dash", () => {
    expect(matchCodePrefix("NODASH")).toBe("NODASH");
  });
});

// ─── normalizeName ──────────────────────────────────────────────────────────

describe("normalizeName", () => {
  it("lowercases", () => {
    expect(normalizeName("DJOKOVIC")).toBe("djokovic");
  });

  it("strips special characters", () => {
    expect(normalizeName("St. Louis")).toBe("st louis");
  });

  it("collapses whitespace", () => {
    expect(normalizeName("  Los   Angeles  ")).toBe("los angeles");
  });

  it("handles empty string", () => {
    expect(normalizeName("")).toBe("");
  });

  it("preserves digits", () => {
    expect(normalizeName("76ers")).toBe("76ers");
  });
});

// ─── namesMatch ─────────────────────────────────────────────────────────────

describe("namesMatch", () => {
  it("matches exact (case insensitive)", () => {
    expect(namesMatch("Lakers", "lakers")).toBe(true);
  });

  it("matches when one contains the other", () => {
    expect(namesMatch("Lakers", "Los Angeles Lakers")).toBe(true);
  });

  it("matches reversed containment", () => {
    expect(namesMatch("Los Angeles Lakers", "Lakers")).toBe(true);
  });

  it("matches multi-word subset", () => {
    expect(namesMatch("Golden State Warriors", "Warriors Golden State")).toBe(true);
  });

  it("matches single word >= 4 chars that appears in longer name", () => {
    expect(namesMatch("Djokovic", "Novak Djokovic")).toBe(true);
  });

  it("matches short words via substring containment", () => {
    // "li" is contained in "li na" — namesMatch uses substring check
    expect(namesMatch("Li", "Li Na")).toBe(true);
  });

  it("does not match completely unrelated short words", () => {
    expect(namesMatch("Li", "Kim")).toBe(false);
  });

  it("matches initials", () => {
    expect(namesMatch("Golden State Warriors", "gsw")).toBe(true);
  });

  it("returns false for empty strings", () => {
    expect(namesMatch("", "Lakers")).toBe(false);
    expect(namesMatch("Lakers", "")).toBe(false);
  });

  it("returns false for unrelated names", () => {
    expect(namesMatch("Lakers", "Celtics")).toBe(false);
  });

  it("matches abbreviation prefix", () => {
    // "lakers" starts with "lake"
    expect(namesMatch("Lakers", "lake")).toBe(true);
  });
});

// ─── fuzzyIntlNamesMatch ────────────────────────────────────────────────────

describe("fuzzyIntlNamesMatch", () => {
  it("falls back to namesMatch first", () => {
    expect(fuzzyIntlNamesMatch("Lakers", "Los Angeles Lakers")).toBe(true);
  });

  it("matches after stripping European prefixes", () => {
    expect(fuzzyIntlNamesMatch("FC Barcelona", "Barcelona")).toBe(true);
  });

  it("matches stripped prefix (BC, FK, etc)", () => {
    expect(fuzzyIntlNamesMatch("BC Zalgiris", "Zalgiris Kaunas")).toBe(true);
  });

  it("returns false for short unmatched words", () => {
    expect(fuzzyIntlNamesMatch("FC Abc", "XY Def")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(fuzzyIntlNamesMatch("", "test")).toBe(false);
  });
});

// ─── cbbExpandName / cbbNamesMatch ──────────────────────────────────────────

describe("cbbExpandName", () => {
  it("expands UConn to connecticut", () => {
    expect(cbbExpandName("UConn")).toBe("connecticut");
  });

  it("returns lowercased name if no alias", () => {
    expect(cbbExpandName("Duke")).toBe("duke");
  });

  it("expands SMU", () => {
    expect(cbbExpandName("SMU")).toBe("southern methodist");
  });
});

describe("cbbNamesMatch", () => {
  it("matches via direct namesMatch", () => {
    expect(cbbNamesMatch("Duke", "Duke Blue Devils")).toBe(true);
  });

  it("matches via expanded alias (kalName)", () => {
    expect(cbbNamesMatch("UConn", "Connecticut Huskies")).toBe(true);
  });

  it("matches via expanded alias (pmOutcome)", () => {
    expect(cbbNamesMatch("Connecticut Huskies", "UConn")).toBe(true);
  });

  it("returns false for non-matching names", () => {
    expect(cbbNamesMatch("Duke", "UNC")).toBe(false);
  });
});

// ─── Sport abbreviation lookups ─────────────────────────────────────────────

describe("nbaNameToAbbr", () => {
  it("full name match", () => {
    expect(nbaNameToAbbr("Los Angeles Lakers")).toBe("lal");
  });

  it("nickname only", () => {
    expect(nbaNameToAbbr("Lakers")).toBe("lal");
  });

  it("city only", () => {
    expect(nbaNameToAbbr("Golden State")).toBe("gsw");
  });

  it("case insensitive", () => {
    expect(nbaNameToAbbr("BOSTON CELTICS")).toBe("bos");
  });

  it("strips 'the' prefix", () => {
    expect(nbaNameToAbbr("the Lakers")).toBe("lal");
  });

  it("returns empty for unknown", () => {
    expect(nbaNameToAbbr("Unknown Team")).toBe("");
  });
});

describe("nhlNameToAbbr", () => {
  it("full name match", () => {
    expect(nhlNameToAbbr("Tampa Bay Lightning")).toBe("tb");
  });

  it("nickname only", () => {
    expect(nhlNameToAbbr("Lightning")).toBe("tb");
  });

  it("handles St. Louis vs St Louis", () => {
    expect(nhlNameToAbbr("St. Louis Blues")).toBe("stl");
    expect(nhlNameToAbbr("St Louis Blues")).toBe("stl");
  });

  it("handles special NY disambiguation", () => {
    expect(nhlNameToAbbr("New York R")).toBe("nyr");
    expect(nhlNameToAbbr("New York I")).toBe("nyi");
  });
});

describe("mlbNameToAbbr", () => {
  it("full name match", () => {
    expect(mlbNameToAbbr("New York Yankees")).toBe("nyy");
  });

  it("nickname only", () => {
    expect(mlbNameToAbbr("Yankees")).toBe("nyy");
  });

  it("city only", () => {
    expect(mlbNameToAbbr("Baltimore")).toBe("bal");
  });

  it("returns empty for unknown", () => {
    expect(mlbNameToAbbr("Unknown")).toBe("");
  });
});

describe("soccerNameToAbbr", () => {
  it("full name match", () => {
    expect(soccerNameToAbbr("Manchester City")).toBe("mac");
  });

  it("short name match", () => {
    expect(soccerNameToAbbr("Arsenal")).toBe("ars");
  });

  it("strips 'the' prefix", () => {
    expect(soccerNameToAbbr("the Arsenal")).toBe("ars");
  });

  it("returns 3-char fallback for unknown", () => {
    const result = soccerNameToAbbr("Xyztownfc");
    expect(result).toBe("xyz");
  });
});

// ─── Series classification Sets ─────────────────────────────────────────────

describe("Series classification", () => {
  it("TENNIS_SERIES contains ATP/WTA", () => {
    expect(TENNIS_SERIES.has("KXATPMATCH")).toBe(true);
    expect(TENNIS_SERIES.has("KXWTAMATCH")).toBe(true);
  });

  it("NBA_SERIES contains KXNBAGAME", () => {
    expect(NBA_SERIES.has("KXNBAGAME")).toBe(true);
  });

  it("SOCCER_SERIES contains EPL", () => {
    expect(SOCCER_SERIES.has("KXEPLGAME")).toBe(true);
  });

  it("NON_MONEYLINE_BINARY_SERIES has spreads/totals", () => {
    expect(NON_MONEYLINE_BINARY_SERIES.has("KXNBASPREAD")).toBe(true);
    expect(NON_MONEYLINE_BINARY_SERIES.has("KXNBATOTAL")).toBe(true);
  });

  it("SET_WINNER_SERIES has ATP set winner", () => {
    expect(SET_WINNER_SERIES.has("KXATPSETWINNER")).toBe(true);
  });
});

// ─── SERIES_TO_PM_PREFIX mapping ────────────────────────────────────────────

describe("SERIES_TO_PM_PREFIX", () => {
  it("maps ATP match to atp", () => {
    expect(SERIES_TO_PM_PREFIX["KXATPMATCH"]).toBe("atp");
  });

  it("maps NBA game to nba", () => {
    expect(SERIES_TO_PM_PREFIX["KXNBAGAME"]).toBe("nba");
  });

  it("maps CS2 game to cs2", () => {
    expect(SERIES_TO_PM_PREFIX["KXCS2GAME"]).toBe("cs2");
  });

  it("maps EPL spread to epl", () => {
    expect(SERIES_TO_PM_PREFIX["KXEPLSPREAD"]).toBe("epl");
  });

  it("returns undefined for unknown series", () => {
    expect(SERIES_TO_PM_PREFIX["UNKNOWN"]).toBeUndefined();
  });
});
