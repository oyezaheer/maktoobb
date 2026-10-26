import { describe, it, expect, afterEach } from "vitest";
import { boot, at, makeClock, until } from "./harness.js";

let app;
afterEach(() => { if (app) app.close(); app = null; });

const setSetting = async (A, label, value) => {
  await A.click(A.byText(".btn", "Settings"));
  if (label === "switch") await A.click(A.$$(".switch")[value]);
  else await A.click(A.byText(".seg button", value));
  await A.click(A.byText(".btn", "Done"));
};

describe("first run", () => {
  it("shows one empty note, a hint, and a live draft row", async () => {
    app = await boot();
    expect(app.$(".sidebar .count").textContent).toBe("1 note");
    expect(app.$(".hint")).not.toBeNull();
    expect(app.draft().placeholder).toBe("Start writing\u2026");
    expect(app.$(".ts.live")).not.toBeNull();
    expect(app.errors).toEqual([]);
  });
});

describe("committing entries", () => {
  it("Enter stamps the entry with the current time and opens a fresh draft", async () => {
    app = await boot();
    await app.say("hey");
    expect(app.values()).toEqual(["hey", ""]);
    expect(app.stamps()[0]).toBe("12:00:00");
    expect(app.$(".hint")).toBeNull();
  });

  it("trims trailing whitespace and ignores a blank draft", async () => {
    app = await boot();
    await app.say("hi   ");
    await app.press(app.draft(), "Enter");
    await app.type(app.draft(), "   ");
    await app.press(app.draft(), "Enter");
    expect(app.values()).toEqual(["hi", "   "]);
  });

  it("Shift+Enter does not commit; IME composition Enter does not commit", async () => {
    app = await boot();
    await app.type(app.draft(), "abc");
    await app.press(app.draft(), "Enter", { shiftKey: true });
    await app.press(app.draft(), "Enter", { isComposing: true });
    expect(app.values()).toEqual(["abc"]);
  });

  it("entries made within the same millisecond still get strictly increasing stamps", async () => {
    app = await boot();
    await setSetting(app, "switch", 1); // show milliseconds
    await app.say("a"); await app.say("b"); await app.say("c");
    const s = app.stamps().slice(0, 3);
    expect(s).toEqual(["12:00:00.000", "12:00:00.001", "12:00:00.002"]);
  });

  it("Enter inside an older row jumps to the draft", async () => {
    app = await boot();
    await app.say("one"); await app.say("two");
    app.fields()[0].focus();
    await app.press(app.fields()[0], "Enter");
    expect(app.doc.activeElement).toBe(app.draft());
    expect(app.values()).toEqual(["one", "two", ""]);
  });

  it("editing an older entry changes its text but not its time", async () => {
    app = await boot();
    await app.say("first");
    app.clock.advance(60_000);
    await app.type(app.fields()[0], "first (edited)");
    expect(app.values()[0]).toBe("first (edited)");
    expect(app.stamps()[0]).toBe("12:00:00");
  });
});

describe("freeze timestamp setting", () => {
  it("'On New Line': the clock keeps running while you type; Enter takes the time of that moment", async () => {
    app = await boot();
    await app.say("one"); // 12:00:00
    app.clock.advance(10_000);
    await app.type(app.draft(), "two");
    expect(app.$(".ts.live")).not.toBeNull();          // still live while typing
    app.clock.advance(5_000);                           // 12:00:15 when Enter is pressed
    await app.press(app.draft(), "Enter");
    expect(app.stamps()[1]).toBe("12:00:15");
    expect(app.$(".ts.live")).not.toBeNull();          // the next row is live again
  });

  it("'On First Keystroke': the next row shows a live clock until you type", async () => {
    app = await boot();
    await setSetting(app, "seg", "On first keystroke");
    await app.say("one");
    expect(app.$(".ts.live")).not.toBeNull();
    app.clock.advance(10_000);
    await app.type(app.draft(), "two");
    expect(app.$(".ts.live")).toBeNull();
    await app.press(app.draft(), "Enter");
    expect(app.stamps()[1]).toBe("12:00:10");
  });

  it("'On First Keystroke': clearing the draft makes the clock live again", async () => {
    app = await boot();
    await setSetting(app, "seg", "On first keystroke");
    await app.type(app.draft(), "x");
    expect(app.$(".ts.live")).toBeNull();
    await app.type(app.draft(), "");
    expect(app.$(".ts.live")).not.toBeNull();
  });
});

describe("deleting and navigating", () => {
  it("Backspace on an empty older row deletes it and focuses the previous row", async () => {
    app = await boot();
    await app.say("a"); await app.say("b");
    await app.type(app.fields()[1], "");
    await app.press(app.fields()[1], "Backspace");
    await app.settle();
    expect(app.values()).toEqual(["a", ""]);
    expect(app.doc.activeElement).toBe(app.fields()[0]);
  });

  it("Backspace on a non-empty row does not delete anything", async () => {
    app = await boot();
    await app.say("keep");
    const ev = await app.press(app.fields()[0], "Backspace");
    expect(ev.defaultPrevented).toBe(false);
    expect(app.values()).toEqual(["keep", ""]);
  });

  it("Backspace on an empty draft never deletes entries", async () => {
    app = await boot();
    await app.say("keep");
    await app.press(app.draft(), "Backspace");
    expect(app.values()).toEqual(["keep", ""]);
  });

  it("ArrowUp at the start / ArrowDown at the end move between rows", async () => {
    app = await boot();
    await app.say("one"); await app.say("two");
    const f = app.fields();
    f[1].focus(); f[1].setSelectionRange(0, 0);
    await app.press(f[1], "ArrowUp"); await app.settle();
    expect(app.doc.activeElement).toBe(app.fields()[0]);
    app.fields()[0].setSelectionRange(3, 3);
    await app.press(app.fields()[0], "ArrowDown"); await app.settle();
    expect(app.doc.activeElement).toBe(app.fields()[1]);
  });

  it("ArrowUp mid-text is left to the browser", async () => {
    app = await boot();
    await app.say("one"); await app.say("two");
    const f = app.fields()[1]; f.focus(); f.setSelectionRange(2, 2);
    const ev = await app.press(f, "ArrowUp");
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("tags, search and filtering", () => {
  it("highlights real tags, ignores C# and URL anchors, and lists chips", async () => {
    app = await boot();
    await app.say("plan #idea for C# and site.com/page#top");
    expect(app.$$(".mirror .tag").map((t) => t.textContent)).toEqual(["#idea"]);
    expect(app.$$(".chip").map((t) => t.textContent)).toEqual(["#idea"]);
  });

  it("supports unicode tags", async () => {
    app = await boot();
    await app.say("coffee #café");
    expect(app.$$(".chip").map((t) => t.textContent)).toEqual(["#café"]);
  });

  it("clicking a chip filters across notes, and Clear filter returns", async () => {
    app = await boot();
    await app.say("one #todo");
    await app.click(app.byText(".btn", "New note"));
    await app.say("two #todo"); await app.say("three");
    await app.click(app.$(".chip"));
    expect(app.$(".results-head").textContent).toContain("2 lines tagged #todo across all notes");
    expect(app.$$(".res-row")).toHaveLength(2);
    await app.click(app.byText(".btn", "Clear filter"));
    expect(app.$(".results-head")).toBeNull();
  });

  it("search is case-insensitive, spans notes, and a result opens its note", async () => {
    app = await boot();
    await app.say("apple pie");
    await app.click(app.byText(".btn", "New note"));
    await app.say("Apple juice"); await app.say("banana");
    await app.typeInto(app.$(".search"), "APPLE");
    expect(app.$$(".res-row")).toHaveLength(2);
    await app.click(app.$$(".res-note")[0]);
    expect(app.$(".results-head")).toBeNull();
    expect(app.$(".search").value).toBe("");
  });

  it("a search with no matches says so instead of showing the editor", async () => {
    app = await boot();
    await app.say("hello");
    await app.typeInto(app.$(".search"), "zzz");
    expect(app.$(".results-head").textContent).toContain("0 lines");
  });
});

describe("pasting", () => {
  it("multi-line text becomes separate entries (CRLF and blank lines handled)", async () => {
    app = await boot();
    const ev = await app.paste(app.draft(), { text: "a\r\nb\r\n\r\nc" });
    expect(ev.defaultPrevented).toBe(true);
    expect(app.values()).toEqual(["a", "b", "c", ""]);
    expect(app.$(".toast").textContent).toContain("3 lines");
  });

  it("single-line paste is left to the browser", async () => {
    app = await boot();
    const ev = await app.paste(app.draft(), { text: "just one line" });
    expect(ev.defaultPrevented).toBe(false);
    expect(app.values()).toEqual([""]);
  });

  it("a 500-line paste stays fast and keeps order", async () => {
    app = await boot();
    const text = Array.from({ length: 500 }, (_, i) => "line " + i).join("\n");
    const t0 = Date.now();
    await app.paste(app.draft(), { text });
    expect(app.values()).toHaveLength(501);
    expect(app.values()[0]).toBe("line 0");
    expect(app.values()[499]).toBe("line 499");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("images", () => {
  const stubImages = (A) => {
    const w = A.w;
    w.Image = function () {
      const o = {};
      Object.defineProperty(o, "src", { set() { setTimeout(() => { o.width = 2400; o.height = 1200; o.onload && o.onload(); }, 0); } });
      return o;
    };
    w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    w.HTMLCanvasElement.prototype.toDataURL = function (t) { w.__canvas = { w: this.width, h: this.height, type: t }; return "data:" + t + ";base64,AAAA"; };
  };
  const png = (A) => new A.w.File(["x"], "shot.png", { type: "image/png" });

  it("pasting an image attaches a resized copy to the row", async () => {
    app = await boot(); stubImages(app);
    const ev = await app.paste(app.draft(), { files: [png(app)] });
    await app.settle(60);
    expect(ev.defaultPrevented).toBe(true);
    expect(app.$$(".thumb img")).toHaveLength(1);
    expect(app.w.__canvas).toEqual({ w: 1200, h: 600, type: "image/webp" });
  });

  it("an image alone can be committed and is stored", async () => {
    app = await boot(); stubImages(app);
    await app.paste(app.draft(), { files: [png(app)] }); await app.settle(60);
    await app.press(app.draft(), "Enter");
    expect(app.$$(".thumb img")).toHaveLength(1);
    await app.flush();
    const db = await app.db();
    const es = await db.table("entries").toArray();
    expect(es).toHaveLength(1);
    expect(es[0].images).toHaveLength(1);
    db.close();
  });

  it("Backspace on an empty row removes its image first; the x button removes it too", async () => {
    app = await boot(); stubImages(app);
    await app.paste(app.draft(), { files: [png(app), png(app)] });
    await until(() => app.$$(".thumb img").length === 2);
    await app.press(app.draft(), "Backspace");
    expect(app.$$(".thumb img")).toHaveLength(1);
    await app.click(app.$(".thumb button"));
    expect(app.$$(".thumb img")).toHaveLength(0);
  });

  it("an unreadable image shows a message instead of failing silently", async () => {
    app = await boot();
    app.w.Image = function () { const o = {}; Object.defineProperty(o, "src", { set() { setTimeout(() => o.onerror && o.onerror(new Error("bad")), 0); } }); return o; };
    await app.paste(app.draft(), { files: [png(app)] }); await app.settle(80);
    expect(app.$(".toast").textContent).toContain("could not be read");
  });
});

describe("notes", () => {
  it("each note has its own entries and its own unsent draft", async () => {
    app = await boot();
    await app.say("in A");
    await app.type(app.draft(), "half typed in A");
    await app.click(app.byText(".btn", "New note"));
    expect(app.$(".sidebar .count").textContent).toBe("2 notes");
    expect(app.values()).toEqual([""]);
    await app.say("in B");
    const items = app.$$(".note-item");
    await app.click(items[items.length - 1]); // older note (A)
    expect(app.values()).toEqual(["in A", "half typed in A"]);
  });

  it("sidebar shows title (or first line) and the latest line; most recently edited note first", async () => {
    app = await boot();
    await app.say("alpha first"); await app.say("alpha last");
    app.clock.advance(60_000);
    await app.click(app.byText(".btn", "New note"));
    await app.say("beta only");
    app.clock.advance(60_000);
    const items = () => app.$$(".note-item");
    await app.click(items()[1]); // go to alpha
    await app.type(app.fields()[0], "alpha first!");
    expect(items()[0].querySelector(".nt").textContent).toBe("alpha first!");
    expect(items()[0].querySelector(".np").textContent).toBe("alpha last");
    expect(items()[1].querySelector(".nt").textContent).toBe("beta only");
  });

  it("deleting a note needs a second click; deleting the last note leaves a fresh empty one", async () => {
    app = await boot();
    await app.say("bye");
    await app.click(app.byText(".btn", "Delete note"));
    expect(app.values()).toEqual(["bye", ""]);
    await app.click(app.byText(".btn", "Confirm delete"));
    expect(app.$(".sidebar .count").textContent).toBe("1 note");
    expect(app.values()).toEqual([""]);
    await app.flush();
    const db = await app.db();
    expect((await db.table("entries").toArray()).filter((e) => !e.deleted)).toHaveLength(0);
    expect((await db.table("notes").toArray()).filter((n) => !n.deleted)).toHaveLength(1);
    db.close();
  });

  it("deleting a note also removes its entries and its unsent draft from storage", async () => {
    app = await boot();
    await app.say("one"); await app.say("two");
    await app.type(app.draft(), "unsent");
    await app.click(app.byText(".btn", "New note")); // keep a second note so the first can go
    const items = app.$$(".note-item");
    await app.click(items[items.length - 1]);
    await app.flush();
    await app.click(app.byText(".btn", "Delete note"));
    await app.click(app.byText(".btn", "Confirm delete"));
    await app.flush();
    const db = await app.db();
    expect((await db.table("entries").toArray()).filter((e) => !e.deleted)).toHaveLength(0);
    const keys = (await db.table("settings").toArray()).map((r) => r.key).filter((k) => k.startsWith("draft:"));
    expect(keys).toEqual([]);
    db.close();
  });

  it("the title can be edited and survives reload", async () => {
    app = await boot();
    await app.typeInto(app.$(".title"), "Trip notes");
    app = await app.reload();
    expect(app.$(".title").value).toBe("Trip notes");
  });
});

describe("persistence", () => {
  it("entries, drafts and notes survive a full reload", async () => {
    app = await boot();
    await app.say("kept #tag");
    await app.type(app.draft(), "unsent draft");
    app = await app.reload();
    expect(app.values()).toEqual(["kept #tag", "unsent draft"]);
    expect(app.stamps()[0]).toBe("12:00:00");
    expect(app.$$(".chip").map((c) => c.textContent)).toEqual(["#tag"]);
  });

  it("edits are saved even if the tab is closed right after typing", async () => {
    app = await boot();
    await app.say("v1");
    await app.type(app.fields()[0], "v2");
    app = await app.reload(); // reload() flushes via pagehide, like closing a tab
    expect(app.values()[0]).toBe("v2");
  });

  it("settings persist", async () => {
    app = await boot();
    await setSetting(app, "switch", 0); // newest on top
    await setSetting(app, "seg", "Dark");
    app = await app.reload();
    await app.say("x");
    expect(app.doc.documentElement.getAttribute("data-theme")).toBe("dark");
    await app.click(app.byText(".btn", "Settings"));
    expect(app.$$(".switch")[0].getAttribute("aria-checked")).toBe("true");
  });

  it("if browser storage is unavailable it warns but still works in memory", async () => {
    app = await boot({ noIdb: true });
    await app.settle(100);
    expect(app.$(".banner[role=alert]")).not.toBeNull();
    await app.say("still works");
    expect(app.values()).toEqual(["still works", ""]);
  });
});

describe("display settings and days", () => {
  it("newest on top puts the draft first and reverses days", async () => {
    app = await boot();
    await app.say("old");
    app.clock.advance(24 * 3600 * 1000);
    await app.say("new");
    await setSetting(app, "switch", 0);
    expect(app.values()).toEqual(["", "new", "old"]);
    expect(app.heads()).toEqual(["October 27, 2026", "October 26, 2026"]);
  });

  it("a new day gets its own heading, split at local midnight", async () => {
    app = await boot({ clock: makeClock(at(2026, 10, 26, 23, 59, 58)) });
    await app.say("late");
    app.clock.set(at(2026, 10, 27, 0, 0, 2));
    await app.say("early");
    expect(app.heads()).toEqual(["October 26, 2026", "October 27, 2026"]);
  });

  it("milliseconds can be shown and the layout class follows", async () => {
    app = await boot();
    await app.say("x");
    await setSetting(app, "switch", 1);
    expect(app.stamps()[0]).toMatch(/^12:00:00\.\d{3}$/);
    expect(app.$(".log.ms")).not.toBeNull();
  });
});

describe("export", () => {
  it("exports the note as text and everything as JSON", async () => {
    app = await boot();
    await app.typeInto(app.$(".title"), "trip notes");
    await app.say("ferry tickets booked");
    await app.click(app.byText(".btn", "Export"));
    const txt = app.$(".export-area").value;
    expect(txt).toBe("trip notes\n\nOctober 26, 2026\n12:00:00  ferry tickets booked");
    await app.click(app.byText(".seg button", "Everything as JSON"));
    const json = JSON.parse(app.$(".export-area").value);
    expect(json.notes).toHaveLength(1);
    expect(json.entries[0].text).toBe("ferry tickets booked");
  });

  it("Escape closes a dialog", async () => {
    app = await boot();
    await app.click(app.byText(".btn", "Settings"));
    expect(app.$(".modal")).not.toBeNull();
    app.doc.dispatchEvent(new app.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await app.settle();
    expect(app.$(".modal")).toBeNull();
  });
});

describe("safety", () => {
  it("HTML in a note is shown as text and never executed", async () => {
    app = await boot();
    await app.say("<img src=x onerror=window.__pwned=1> <script>window.__pwned=2</script>");
    await app.settle(50);
    expect(app.$$(".log img")).toHaveLength(0);
    expect(app.w.__pwned).toBeUndefined();
    expect(app.$(".mirror").textContent).toContain("<img src=x");
  });

  it("very long unbroken text does not crash", async () => {
    app = await boot();
    await app.say("x".repeat(20000));
    expect(app.values()[0]).toHaveLength(20000);
  });

  it("no console errors during a normal session", async () => {
    app = await boot();
    await app.say("a #x"); await app.say("b");
    await app.click(app.$(".chip"));
    await app.click(app.byText(".btn", "Clear filter"));
    expect(app.errors).toEqual([]);
  });
});
