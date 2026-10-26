import { describe, it, expect } from "vitest";
import C from "../../src/core.js";

const at = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

describe("fmtTime", () => {
  it("formats HH:MM:SS with zero padding", () => {
    expect(C.fmtTime(at(2026, 10, 26, 9, 5, 3))).toBe("09:05:03");
  });
  it("uses 24-hour time", () => {
    expect(C.fmtTime(at(2026, 10, 26, 23, 59, 59))).toBe("23:59:59");
    expect(C.fmtTime(at(2026, 10, 26, 0, 0, 0))).toBe("00:00:00");
  });
  it("adds zero-padded milliseconds when asked", () => {
    expect(C.fmtTime(at(2026, 10, 26, 12, 18, 37, 7), true)).toBe("12:18:37.007");
    expect(C.fmtTime(at(2026, 10, 26, 12, 18, 37, 450), true)).toBe("12:18:37.450");
  });
});

describe("dayKey / dayLabel", () => {
  it("dayKey is local-date based and zero padded", () => {
    expect(C.dayKey(at(2026, 3, 4, 8, 55))).toBe("2026-03-04");
  });
  it("one second before and after midnight are different days", () => {
    expect(C.dayKey(at(2026, 10, 26, 23, 59, 59))).not.toBe(C.dayKey(at(2026, 10, 27, 0, 0, 0)));
  });
  it("dayLabel reads like the original app", () => {
    expect(C.dayLabel(at(2026, 10, 26, 12))).toBe("October 26, 2026");
    expect(C.dayLabel(at(2026, 3, 3, 12))).toBe("March 3, 2026");
  });
});

describe("tags", () => {
  it("extracts lowercase tags without the hash", () => {
    expect(C.extractTags("notes #Meeting and #idea")).toEqual(["meeting", "idea"]);
  });
  it("returns each tag once per line", () => {
    expect(C.extractTags("#a #a #A")).toEqual(["a"]);
  });
  it("supports hyphens, underscores, digits and unicode letters", () => {
    expect(C.extractTags("#follow-up #to_do #q4 #café")).toEqual(["follow-up", "to_do", "q4", "café"]);
  });
  it("does not treat a lone # as a tag", () => {
    expect(C.extractTags("# heading # ")).toEqual([]);
  });
  it("does not treat mid-word # as a tag (C#, urls, anchors)", () => {
    expect(C.extractTags("I write C# daily")).toEqual([]);
    expect(C.extractTags("see https://x.com/page#section")).toEqual([]);
    expect(C.extractTags("a#b")).toEqual([]);
  });
  it("accepts a tag after punctuation like ( or a comma", () => {
    expect(C.extractTags("(#idea), #todo")).toEqual(["idea", "todo"]);
  });
  it("does not swallow a trailing hyphen or full stop", () => {
    expect(C.extractTags("done #todo.")).toEqual(["todo"]);
    expect(C.extractTags("done #todo-")).toEqual(["todo"]);
  });
  it("splitTags returns alternating text/tag parts that rejoin to the original", () => {
    const t = "a #x b #y-z end C#";
    const parts = C.splitTags(t);
    expect(parts.join("")).toBe(t);
    expect(parts.filter((_, i) => i % 2 === 1)).toEqual(["#x", "#y-z"]);
  });
  it("splitTags on empty text is safe", () => {
    expect(C.splitTags("").join("")).toBe("");
  });
  it("hue is deterministic, in range, and case/hash insensitive", () => {
    expect(C.hue("idea")).toBe(C.hue("#Idea"));
    for (const s of ["a", "meeting", "café", "x".repeat(500)]) {
      const h = C.hue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
  it("tagCounts counts lines, sorts by count then name, and limits", () => {
    const es = [{ text: "#b #a" }, { text: "#a" }, { text: "#c #c" }];
    expect(C.tagCounts(es, 2)).toEqual([["a", 2], ["b", 1]]);
  });
});

describe("grouping and ordering", () => {
  const items = [
    { id: 1, ts: at(2026, 10, 25, 23, 0) },
    { id: 2, ts: at(2026, 10, 26, 0, 5) },
    { id: 3, ts: at(2026, 10, 26, 9, 0) },
  ];
  it("groups consecutive items by local day", () => {
    const g = C.groupByDay(items);
    expect(g.map((x) => x.label)).toEqual(["October 25, 2026", "October 26, 2026"]);
    expect(g[1].items.map((i) => i.id)).toEqual([2, 3]);
  });
  it("empty input gives no groups", () => {
    expect(C.groupByDay([])).toEqual([]);
  });
  it("arrangeGroups(newestTop) reverses days and items without mutating", () => {
    const g = C.groupByDay(items);
    const r = C.arrangeGroups(g, true);
    expect(C.flattenOrder(r)).toEqual([3, 2, 1]);
    expect(C.flattenOrder(g)).toEqual([1, 2, 3]);
  });
  it("arrangeGroups(oldest first) keeps order", () => {
    expect(C.flattenOrder(C.arrangeGroups(C.groupByDay(items), false))).toEqual([1, 2, 3]);
  });
});

describe("timestamp rules", () => {
  const now = 1_000_000;
  it("on new line: the draft stays live while typing (never frozen by typing)", () => {
    expect(C.draftStampOnInput({ createdAt: null, text: "h", hasImages: false, freeze: "newline", now })).toBeNull();
    expect(C.draftStampOnInput({ createdAt: null, text: "hello", hasImages: false, freeze: "newline", now })).toBeNull();
  });
  it("on first keystroke: the first character stamps an unstamped draft", () => {
    expect(C.draftStampOnInput({ createdAt: null, text: "h", hasImages: false, freeze: "keystroke", now })).toBe(now);
  });
  it("on first keystroke: an already stamped draft keeps its stamp while typing", () => {
    expect(C.draftStampOnInput({ createdAt: 5, text: "hello", hasImages: false, freeze: "keystroke", now })).toBe(5);
  });
  it("on first keystroke: emptying the draft makes the clock live again", () => {
    expect(C.draftStampOnInput({ createdAt: 5, text: "", hasImages: false, freeze: "keystroke", now })).toBeNull();
  });
  it("on first keystroke: an attached image keeps the stamp", () => {
    expect(C.draftStampOnInput({ createdAt: 5, text: "", hasImages: true, freeze: "keystroke", now })).toBe(5);
  });
  it("nextStamp never goes backwards or repeats", () => {
    expect(C.nextStamp(100, 50)).toBe(100);
    expect(C.nextStamp(100, 100)).toBe(101);
    expect(C.nextStamp(100, 500)).toBe(501);
  });
  it("after Enter the next draft is always live", () => {
    expect(C.stampAfterCommit({ freeze: "newline", now: 200, committed: 100 })).toBeNull();
    expect(C.stampAfterCommit({ freeze: "keystroke", now: 200, committed: 100 })).toBeNull();
  });
});

describe("pasted text", () => {
  it("splits CRLF, LF and CR; drops blank lines; trims trailing space", () => {
    expect(C.splitPastedLines("a  \r\n\r\nb\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });
  it("only multi-line text should be intercepted", () => {
    expect(C.shouldSplitPaste("one line")).toBe(false);
    expect(C.shouldSplitPaste("one line\n")).toBe(false);
    expect(C.shouldSplitPaste("a\nb")).toBe(true);
    expect(C.shouldSplitPaste("")).toBe(false);
  });
  it("buildImportEntries gives increasing stamps starting after the last entry", () => {
    let n = 0;
    const es = C.buildImportEntries(["a", "b", "c"], { now: 1000, lastStamp: 5000, noteId: "N", idFn: () => "id" + n++ });
    expect(es.map((e) => e.createdAt)).toEqual([5001, 5002, 5003]);
    expect(es.map((e) => e.text)).toEqual(["a", "b", "c"]);
    expect(es.every((e) => e.noteId === "N" && Array.isArray(e.images))).toBe(true);
    expect(new Set(es.map((e) => e.id)).size).toBe(3);
  });
});

describe("filterEntries", () => {
  const es = [
    { id: 1, createdAt: 1, text: "Buy milk #todo" },
    { id: 2, createdAt: 2, text: "meeting notes #meeting" },
    { id: 3, createdAt: 3, text: "call mom #todo #family" },
  ];
  it("filters by tag", () => {
    expect(C.filterEntries({ entries: es, tag: "todo", query: "", newestTop: false }).map((e) => e.id)).toEqual([1, 3]);
  });
  it("query is case-insensitive", () => {
    expect(C.filterEntries({ entries: es, tag: "", query: "MILK", newestTop: false }).map((e) => e.id)).toEqual([1]);
  });
  it("tag and query combine with AND", () => {
    expect(C.filterEntries({ entries: es, tag: "todo", query: "mom", newestTop: false }).map((e) => e.id)).toEqual([3]);
  });
  it("whitespace-only query is ignored", () => {
    expect(C.filterEntries({ entries: es, tag: "", query: "   ", newestTop: false })).toHaveLength(3);
  });
  it("newestTop reverses and does not mutate input", () => {
    const r = C.filterEntries({ entries: es, tag: "todo", query: "", newestTop: true });
    expect(r.map((e) => e.id)).toEqual([3, 1]);
    expect(es.map((e) => e.id)).toEqual([1, 2, 3]);
  });
  it("a query with regex characters is treated literally", () => {
    const x = [{ id: 1, createdAt: 1, text: "cost (approx) $5 [done]" }];
    expect(C.filterEntries({ entries: x, tag: "", query: "(approx)", newestTop: false })).toHaveLength(1);
    expect(C.filterEntries({ entries: x, tag: "", query: ".*", newestTop: false })).toHaveLength(0);
  });
});

describe("noteToText", () => {
  const note = { title: "trip notes" };
  const es = [
    { createdAt: at(2026, 3, 3, 18, 40, 5), text: "dinner at the harbor", images: [] },
    { createdAt: at(2026, 3, 3, 9, 12, 40), text: "ferry tickets booked", images: [] },
    { createdAt: at(2026, 3, 4, 8, 55, 1), text: "photo", images: ["x"] },
  ];
  it("sorts chronologically, adds day headings and image markers", () => {
    expect(C.noteToText(note, es, false)).toBe(
      ["trip notes", "", "March 3, 2026", "09:12:40  ferry tickets booked", "18:40:05  dinner at the harbor", "", "March 4, 2026", "08:55:01  photo  [image x1]"].join("\n")
    );
  });
  it("falls back to Untitled Note and does not mutate input order", () => {
    expect(C.noteToText({ title: "" }, es, false).startsWith("Untitled Note")).toBe(true);
    expect(es[0].text).toBe("dinner at the harbor");
  });
});
