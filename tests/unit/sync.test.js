import { describe, it, expect } from "vitest";
import S from "../../src/sync.js";

/* ---------- in-memory fakes ---------- */
function makeLocal(initial = {}) {
  const t = { notes: new Map(), entries: new Map() };
  for (const k of ["notes", "entries"]) (initial[k] || []).forEach((r) => t[k].set(r.id, { ...r }));
  const cursors = {};
  const log = [];
  return {
    t, cursors, log,
    async flush() { log.push("flush"); },
    async getDirty(table) { return [...t[table].values()].filter((r) => r.dirty === 1).map((r) => ({ ...r })); },
    async markClean(table, rows) {
      log.push("markClean:" + table);
      for (const r of rows) {
        const cur = t[table].get(r.id);
        if (cur && cur.updatedAt === r.updatedAt) cur.dirty = 0;
      }
    },
    async applyRemote(table, row) {
      const cur = t[table].get(row.id);
      if (cur && cur.updatedAt >= row.updatedAt) return false;
      t[table].set(row.id, { ...row });
      return true;
    },
    async getCursor(k) { return cursors[k] || null; },
    async setCursor(k, v) { cursors[k] = v; },
  };
}

function makeRemote({ rows = { notes: [], entries: [] }, failUpsert = false } = {}) {
  const calls = [];
  return {
    calls, rows,
    async upsert(table, batch) {
      calls.push({ op: "upsert", table, n: batch.length, ids: batch.map((b) => b.id) });
      if (failUpsert) return { error: { message: "network down" } };
      return { error: null };
    },
    async pull(table, cursor, limit) {
      calls.push({ op: "pull", table, cursor, limit });
      const data = rows[table].filter((r) => r.server_updated_at > cursor).sort((a, b) => (a.server_updated_at < b.server_updated_at ? -1 : 1)).slice(0, limit);
      return { data, error: null };
    },
  };
}

const note = (id, over = {}) => ({ id, title: "", createdAt: 1, updatedAt: 1, deleted: 0, dirty: 1, ...over });
const entry = (id, over = {}) => ({ id, noteId: "n1", createdAt: 1, updatedAt: 1, text: "t", images: [], deleted: 0, dirty: 1, ...over });
const rnote = (id, ts, over = {}) => ({ id, title: "", created_at: 1, updated_at: 5, deleted: false, server_updated_at: ts, ...over });
const rentry = (id, ts, over = {}) => ({ id, note_id: "n1", created_at: 1, updated_at: 5, text: "r", images: [], deleted: false, server_updated_at: ts, ...over });

describe("row mapping", () => {
  it("maps an entry to the server shape", () => {
    expect(S.toRemote("entries", entry("e1", { text: "hi", images: ["x"], deleted: 1, createdAt: 10, updatedAt: 20 }))).toEqual({
      id: "e1", note_id: "n1", created_at: 10, updated_at: 20, text: "hi", images: ["x"], deleted: true,
    });
  });
  it("maps a note to the server shape and never sends local-only fields", () => {
    const r = S.toRemote("notes", note("n1", { title: "T" }));
    expect(r).toEqual({ id: "n1", title: "T", created_at: 1, updated_at: 1, deleted: false });
    expect("dirty" in r).toBe(false);
  });
  it("maps server rows back to clean local rows", () => {
    expect(S.fromRemote("entries", rentry("e1", "2026-01-01T00:00:00Z", { deleted: true }))).toEqual({
      id: "e1", noteId: "n1", createdAt: 1, updatedAt: 5, text: "r", images: [], deleted: 1, dirty: 0,
    });
    expect(S.fromRemote("notes", rnote("n1", "x")).dirty).toBe(0);
  });
  it("tolerates null images / text from the server", () => {
    const e = S.fromRemote("entries", rentry("e1", "x", { images: null, text: null }));
    expect(e.images).toEqual([]);
    expect(e.text).toBe("");
  });
});

describe("chunk", () => {
  it("splits by row count and keeps order", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => ({ id: i }));
    expect(S.chunk(rows, 2, 1e9).map((c) => c.map((r) => r.id))).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("splits by size, and an oversized row travels alone", () => {
    const big = { id: "big", text: "x".repeat(500) };
    const small = (i) => ({ id: i, text: "y" });
    const out = S.chunk([small(1), big, small(2)], 100, 300);
    expect(out.map((c) => c.map((r) => r.id))).toEqual([[1], ["big"], [2]]);
  });
  it("empty input gives no chunks", () => { expect(S.chunk([], 10, 100)).toEqual([]); });
});

describe("engine.run: pushing", () => {
  it("flushes first, pushes notes before entries, then marks them clean", async () => {
    const local = makeLocal({ notes: [note("n1")], entries: [entry("e1"), entry("e2")] });
    const remote = makeRemote();
    const eng = S.createEngine({ local, remote });
    const r = await eng.run("u1");
    expect(local.log[0]).toBe("flush");
    const ups = remote.calls.filter((c) => c.op === "upsert");
    expect(ups.map((u) => u.table)).toEqual(["notes", "entries"]);
    expect(ups[1].ids).toEqual(["e1", "e2"]);
    expect([...local.t.entries.values()].every((e) => e.dirty === 0)).toBe(true);
    expect(local.t.notes.get("n1").dirty).toBe(0);
    expect(r.pushed).toBe(3);
  });

  it("does not push clean rows", async () => {
    const local = makeLocal({ notes: [note("n1", { dirty: 0 })], entries: [] });
    const remote = makeRemote();
    await S.createEngine({ local, remote }).run("u1");
    expect(remote.calls.filter((c) => c.op === "upsert")).toHaveLength(0);
  });

  it("a failed push leaves rows dirty, throws, and does not pull", async () => {
    const local = makeLocal({ notes: [note("n1")], entries: [entry("e1")] });
    const remote = makeRemote({ failUpsert: true });
    await expect(S.createEngine({ local, remote }).run("u1")).rejects.toThrow("network down");
    expect(local.t.notes.get("n1").dirty).toBe(1);
    expect(local.t.entries.get("e1").dirty).toBe(1);
    expect(remote.calls.some((c) => c.op === "pull")).toBe(false);
  });

  it("an edit made while the push was in flight stays dirty", async () => {
    const local = makeLocal({ notes: [], entries: [entry("e1", { updatedAt: 10 })] });
    const remote = makeRemote();
    const origUpsert = remote.upsert;
    remote.upsert = async (table, batch) => {
      const res = await origUpsert(table, batch);
      if (table === "entries") { const cur = local.t.entries.get("e1"); cur.updatedAt = 11; cur.text = "newer"; cur.dirty = 1; }
      return res;
    };
    await S.createEngine({ local, remote }).run("u1");
    expect(local.t.entries.get("e1").dirty).toBe(1);
    expect(local.t.entries.get("e1").text).toBe("newer");
  });

  it("large pushes are split into several requests", async () => {
    const es = Array.from({ length: 250 }, (_, i) => entry("e" + i));
    const local = makeLocal({ notes: [], entries: es });
    const remote = makeRemote();
    await S.createEngine({ local, remote, chunkRows: 100 }).run("u1");
    expect(remote.calls.filter((c) => c.op === "upsert").map((c) => c.n)).toEqual([100, 100, 50]);
  });
});

describe("engine.run: pulling", () => {
  it("starts from the beginning of time and stores a cursor per user and table", async () => {
    const local = makeLocal();
    const remote = makeRemote({ rows: { notes: [rnote("n1", "2026-01-01T00:00:01Z")], entries: [rentry("e1", "2026-01-01T00:00:02Z"), rentry("e2", "2026-01-01T00:00:03Z")] } });
    await S.createEngine({ local, remote }).run("u1");
    const pulls = remote.calls.filter((c) => c.op === "pull");
    expect(pulls[0].cursor).toBe("1970-01-01T00:00:00Z");
    expect(local.cursors["u1:notes"]).toBe("2026-01-01T00:00:01Z");
    expect(local.cursors["u1:entries"]).toBe("2026-01-01T00:00:03Z");
    expect(local.t.entries.size).toBe(2);
  });

  it("only asks for rows after the stored cursor", async () => {
    const local = makeLocal();
    local.cursors["u1:entries"] = "2026-01-01T00:00:02Z";
    const remote = makeRemote({ rows: { notes: [], entries: [rentry("old", "2026-01-01T00:00:02Z"), rentry("new", "2026-01-01T00:00:09Z")] } });
    await S.createEngine({ local, remote }).run("u1");
    expect([...local.t.entries.keys()]).toEqual(["new"]);
  });

  it("keeps pulling until a short page, advancing the cursor each time", async () => {
    const entries = [1, 2, 3, 4, 5].map((i) => rentry("e" + i, "2026-01-01T00:00:0" + i + "Z"));
    const local = makeLocal();
    const remote = makeRemote({ rows: { notes: [], entries } });
    await S.createEngine({ local, remote, pageSize: 2 }).run("u1");
    expect(local.t.entries.size).toBe(5);
    expect(remote.calls.filter((c) => c.op === "pull" && c.table === "entries")).toHaveLength(3);
  });

  it("never overwrites a newer local edit with an older server copy", async () => {
    const local = makeLocal({ entries: [entry("e1", { text: "mine", updatedAt: 100, dirty: 0 })] });
    const remote = makeRemote({ rows: { notes: [], entries: [rentry("e1", "2026-01-01T00:00:01Z", { updated_at: 50, text: "theirs" })] } });
    await S.createEngine({ local, remote }).run("u1");
    expect(local.t.entries.get("e1").text).toBe("mine");
  });

  it("a newer server copy replaces the local one", async () => {
    const local = makeLocal({ entries: [entry("e1", { text: "mine", updatedAt: 50, dirty: 0 })] });
    const remote = makeRemote({ rows: { notes: [], entries: [rentry("e1", "2026-01-01T00:00:01Z", { updated_at: 100, text: "theirs" })] } });
    await S.createEngine({ local, remote }).run("u1");
    expect(local.t.entries.get("e1").text).toBe("theirs");
  });

  it("deletions arrive as tombstones, not as missing rows", async () => {
    const local = makeLocal({ entries: [entry("e1", { updatedAt: 1, dirty: 0 })] });
    const remote = makeRemote({ rows: { notes: [], entries: [rentry("e1", "2026-01-01T00:00:01Z", { updated_at: 9, deleted: true })] } });
    await S.createEngine({ local, remote }).run("u1");
    expect(local.t.entries.get("e1").deleted).toBe(1);
  });

  it("calls onApplied only when something changed locally", async () => {
    let n = 0;
    const quiet = S.createEngine({ local: makeLocal(), remote: makeRemote(), onApplied: () => n++ });
    await quiet.run("u1");
    expect(n).toBe(0);
    const remote = makeRemote({ rows: { notes: [], entries: [rentry("e1", "2026-01-01T00:00:01Z")] } });
    await S.createEngine({ local: makeLocal(), remote, onApplied: () => n++ }).run("u1");
    expect(n).toBe(1);
  });

  it("a failed pull throws and does not advance the cursor", async () => {
    const local = makeLocal();
    const remote = makeRemote();
    remote.pull = async () => ({ data: null, error: { message: "boom" } });
    await expect(S.createEngine({ local, remote }).run("u1")).rejects.toThrow("boom");
    expect(local.cursors["u1:notes"]).toBeUndefined();
  });

  it("different users keep separate cursors", async () => {
    const local = makeLocal();
    const remote = makeRemote({ rows: { notes: [rnote("n1", "2026-01-01T00:00:01Z")], entries: [] } });
    await S.createEngine({ local, remote }).run("u1");
    await S.createEngine({ local, remote }).run("u2");
    const firstPullOfU2 = remote.calls.filter((c) => c.op === "pull" && c.table === "notes")[1];
    expect(firstPullOfU2.cursor).toBe("1970-01-01T00:00:00Z");
  });
});

describe("pushing then pulling the same data", () => {
  it("our own echoed rows do not count as new changes", async () => {
    const local = makeLocal({ notes: [], entries: [entry("e1", { updatedAt: 7 })] });
    const remote = makeRemote();
    // the server echoes back the row we just pushed
    remote.rows.entries.push(rentry("e1", "2026-01-01T00:00:01Z", { updated_at: 7, text: "t" }));
    let applied = 0;
    await S.createEngine({ local, remote, onApplied: () => applied++ }).run("u1");
    expect(applied).toBe(0);
  });
});
