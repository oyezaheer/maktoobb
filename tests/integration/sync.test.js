import { describe, it, expect, afterEach } from "vitest";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { boot, until, sleep, makeClock, at } from "./harness.js";
import { makeServer } from "./fakeSupabase.js";

const devices = [];
const device = async (opts = {}) => {
  const d = await boot({ store: { session: null }, ...opts });
  devices.push(d);
  return d;
};
afterEach(() => { devices.splice(0).forEach((d) => { try { d.close(); } catch (e) {} }); });

const signIn = async (A, email, password, mode = "signin") => {
  await A.click(A.byText(".btn", "Sign in to sync"));
  await A.typeInto(A.$$(".input")[0], email);
  await A.typeInto(A.$$(".input")[1], password);
  await A.click(A.byText(".btn", mode === "signup" ? "Create account" : "Sign in"));
};
const syncLine = (A) => A.$(".sync-line").textContent;
const serverTexts = (s) => s.rows("entries").filter((r) => !r.deleted).map((r) => r.text).sort();

describe("not configured", () => {
  it("works fully offline and explains that sync is not set up", async () => {
    const A = await device();
    await A.say("local only");
    expect(A.values()).toEqual(["local only", ""]);
    expect(syncLine(A)).toBe("Cloud sync is not set up.");
    await A.click(A.byText(".btn", "Sign in to sync"));
    expect(A.$(".modal").textContent).toContain("src/config.js");
  });
});

describe("signing in", () => {
  it("shows a clear error for a wrong password and stays signed out", async () => {
    const server = makeServer();
    server.users.set("a@x.com", { id: "user-1", email: "a@x.com", password: "right-pass" });
    const A = await device({ server });
    await signIn(A, "a@x.com", "wrong-pass");
    await until(() => A.$(".err"));
    expect(A.$(".err").textContent).toContain("Invalid login credentials");
    expect(syncLine(A)).toContain("Not syncing");
  });

  it("when email confirmation is required it tells the user to check their email", async () => {
    const server = makeServer(); server.requireConfirm = true;
    const A = await device({ server });
    await signIn(A, "new@x.com", "secret1", "signup");
    await until(() => A.$(".modal") && A.$(".modal").textContent.includes("Check your email"));
  });
});

describe("pushing from one device", () => {
  it("uploads existing local notes on first sign-in, in the server's column format", async () => {
    const server = makeServer();
    const A = await device({ server });
    await A.say("written before signing in #idea");
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => server.rows("entries").length === 1 && server.rows("notes").length === 1);
    const e = server.rows("entries")[0], n = server.rows("notes")[0];
    expect(e.text).toBe("written before signing in #idea");
    expect(e.note_id).toBe(n.id);
    expect(typeof e.created_at).toBe("number");
    expect(e.images).toEqual([]);
    expect(e.deleted).toBe(false);
    expect(e.user_id).toBe(n.user_id);
    await until(() => syncLine(A).startsWith("Synced"));
    expect(syncLine(A)).toContain("a@x.com");
  });

  it("new lines typed after sign-in reach the server by themselves", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => syncLine(A).startsWith("Synced"));
    await A.say("typed while signed in");
    await until(() => serverTexts(server).includes("typed while signed in"));
  });

  it("edits to an existing line update the same server row (no duplicates)", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "a@x.com", "secret1", "signup");
    await A.say("v1");
    await until(() => serverTexts(server).includes("v1"));
    A.clock.advance(5000);
    await A.type(A.fields()[0], "v2");
    await until(() => serverTexts(server).includes("v2"));
    expect(server.rows("entries")).toHaveLength(1);
  });
});

describe("two devices", () => {
  it("a second device signs in and receives everything", async () => {
    const server = makeServer();
    const A = await device({ server });
    await A.say("one"); await A.say("two #tag");
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => server.rows("entries").length === 2);

    const B = await device({ server, idb: new IDBFactory() });
    await signIn(B, "a@x.com", "secret1");
    await until(() => B.values().includes("two #tag"));
    expect(B.values().slice(0, 2)).toEqual(["one", "two #tag"]);
    expect(B.$$(".chip").map((c) => c.textContent)).toEqual(["#tag"]);
    expect(B.$(".sidebar .count").textContent).toBe("1 note");
  });

  it("a line typed on one device appears on the other without any action", async () => {
    const server = makeServer();
    const A = await device({ server }); const B = await device({ server, idb: new IDBFactory() });
    await signIn(A, "a@x.com", "secret1", "signup");
    await signIn(B, "a@x.com", "secret1");
    await until(() => syncLine(A).startsWith("Synced") && syncLine(B).startsWith("Synced"));
    // B opens the same note as A
    await until(() => B.$$(".note-item").length >= 1);
    await A.say("hello from A");
    await until(() => B.values().includes("hello from A"));
    await B.say("hello from B");
    await until(() => A.values().includes("hello from B"));
  });

  it("deleting a line on one device removes it on the other", async () => {
    const server = makeServer();
    const A = await device({ server });
    await A.say("keep"); await A.say("remove me");
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => server.rows("entries").length === 2);
    const B = await device({ server, idb: new IDBFactory() });
    await signIn(B, "a@x.com", "secret1");
    await until(() => B.values().includes("remove me"));

    B.clock.advance(60_000);
    const idx = B.values().indexOf("remove me");
    await B.type(B.fields()[idx], "");
    await B.press(B.fields()[idx], "Backspace");
    await until(() => !A.values().includes("remove me"));
    expect(A.values()).toEqual(["keep", ""]);
    expect(server.rows("entries").filter((r) => r.deleted)).toHaveLength(1);
    expect(serverTexts(server)).toEqual(["keep"]);
  });

  it("deleting a whole note on one device removes it on the other", async () => {
    const server = makeServer();
    const A = await device({ server });
    await A.say("first note line");
    await A.click(A.byText(".btn", "New note"));
    await A.say("second note line");
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => server.rows("notes").length === 2 && server.rows("entries").length === 2);
    const B = await device({ server, idb: new IDBFactory() });
    await signIn(B, "a@x.com", "secret1");
    await until(() => B.$$(".note-item").length === 2);

    A.clock.advance(60_000);
    await A.click(A.byText(".btn", "Delete note"));
    await A.click(A.byText(".btn", "Confirm delete"));
    await until(() => B.$$(".note-item").length === 1);
    expect(B.$$(".note-item .nt").map((n) => n.textContent)).toEqual(["first note line"]);
  });

  it("a different account never sees someone else's notes", async () => {
    const server = makeServer();
    const A = await device({ server });
    await A.say("private to user 1");
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => server.rows("entries").length === 1);
    const C = await device({ server, idb: new IDBFactory() });
    await signIn(C, "c@x.com", "secret2", "signup");
    await until(() => syncLine(C).startsWith("Synced"));
    expect(C.values()).toEqual([""]);
    expect(C.$$(".note-item .np").map((n) => n.textContent)).toEqual(["No entries yet"]);
  });
});

describe("conflicts and failures", () => {
  it("when two devices edit the same line while apart, the later edit wins on both", async () => {
    const server = makeServer();
    const clockA = makeClock(at(2026, 10, 26, 12, 0, 0));
    const clockB = makeClock(at(2026, 10, 26, 12, 0, 0));
    const A = await device({ server, clock: clockA });
    await A.say("base");
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => serverTexts(server).includes("base"));
    const B = await device({ server, idb: new IDBFactory(), clock: clockB });
    await signIn(B, "a@x.com", "secret1");
    await until(() => B.values().includes("base"));

    server.fail = "network down";            // both devices go offline
    clockA.advance(10_000); await A.type(A.fields()[0], "A edit");
    clockB.advance(20_000); await B.type(B.fields()[0], "B edit");   // the later edit
    await A.flush(); await B.flush();
    server.fail = null;                       // network is back
    A.w.dispatchEvent(new A.w.Event("online")); B.w.dispatchEvent(new B.w.Event("online"));
    await until(() => A.values()[0] === "B edit" && B.values()[0] === "B edit", 6000);
    expect(serverTexts(server)).toEqual(["B edit"]);
  });

  it("while the server is unreachable nothing is lost, the app says so, and it catches up later", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => syncLine(A).startsWith("Synced"));
    server.fail = "network down";
    await A.say("written offline");
    await until(() => syncLine(A).includes("Sync problem"));
    expect(syncLine(A)).toContain("network down");
    expect(A.values()).toEqual(["written offline", ""]);
    expect(serverTexts(server)).toEqual([]);
    server.fail = null;
    A.w.dispatchEvent(new A.w.Event("online"));
    await until(() => serverTexts(server).includes("written offline"));
    await until(() => syncLine(A).startsWith("Synced"));
  });

  it("signing out keeps local notes and stops uploading", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "a@x.com", "secret1", "signup");
    await A.say("before sign out");
    await until(() => serverTexts(server).includes("before sign out"));
    await A.click(A.byText(".btn", "Account"));
    await A.click(A.byText(".btn", "Sign out"));
    await until(() => syncLine(A).includes("Not syncing"));
    await A.say("after sign out");
    await sleep(400);
    expect(serverTexts(server)).toEqual(["before sign out"]);
    expect(A.values()).toEqual(["before sign out", "after sign out", ""]);
  });
});

describe("races the real app must survive", () => {
  it("an edit made while an upload is in flight is not lost", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => syncLine(A).startsWith("Synced"));
    let fired = false;
    const hook = async (table) => {
      if (table === "entries" && !fired) {
        fired = true;
        A.clock.advance(5000);
        await A.type(A.fields()[0], "v2 typed mid-upload");
        await A.flush();
      } else server.pushHook = hook;
    };
    server.pushHook = hook;
    await A.say("v1");
    await until(() => serverTexts(server).includes("v2 typed mid-upload"), 6000);
    expect(A.values()[0]).toBe("v2 typed mid-upload");
  });

  it("a stale server copy arriving mid-sync does not overwrite a newer local edit", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "a@x.com", "secret1", "signup");
    await A.say("v1");
    await until(() => serverTexts(server).includes("v1"));
    let fired = false;
    const hook = async (table) => {
      if (table === "entries" && !fired) {
        fired = true;
        A.clock.advance(5000);
        await A.type(A.fields()[0], "v2 newer local");
        await A.flush();
      } else server.pullHook = hook;
    };
    server.pullHook = hook;
    A.w.dispatchEvent(new A.w.Event("online"));
    await until(() => fired, 4000);
    await until(() => serverTexts(server).includes("v2 newer local"), 6000);
    expect(A.values()[0]).toBe("v2 newer local");
  });

  it("a live change that only touches a line (not its note) still arrives", async () => {
    const server = makeServer();
    const A = await device({ server });
    await A.say("original");
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => serverTexts(server).includes("original"));
    await until(() => syncLine(A).startsWith("Synced"));
    await sleep(900); // let the echo of our own upload settle, so only the live ping can cause the next sync
    const row = server.rows("entries")[0];
    server.externalWrite("entries", { ...row, text: "edited elsewhere", updated_at: row.updated_at + 100000 }, row.user_id);
    await until(() => A.values()[0] === "edited elsewhere");
  });

  it("a token refresh (same user) does not restart syncing", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => syncLine(A).startsWith("Synced"));
    expect(server.subscribeCount).toBe(1);
    A.client._emit("TOKEN_REFRESHED");
    A.client._emit("SIGNED_IN");
    await sleep(200);
    expect(server.subscribeCount).toBe(1);
    expect(syncLine(A).startsWith("Synced")).toBe(true);
  });

  it("an empty untitled note is never uploaded", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => syncLine(A).startsWith("Synced"));
    expect(server.rows("notes")).toHaveLength(0);
    expect(server.rows("entries")).toHaveLength(0);
  });
});

describe("switching accounts on one device", () => {
  it("a different account sees only its own notes, and signing back in restores the first account's", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "one@x.com", "secret1", "signup");
    await A.say("account one note #private");
    await until(() => serverTexts(server).includes("account one note #private"));
    await A.click(A.byText(".btn", "Account"));
    await A.click(A.byText(".btn", "Sign out"));
    await until(() => syncLine(A).includes("Not syncing"));

    await signIn(A, "two@x.com", "secret2", "signup");
    await until(() => syncLine(A).startsWith("Synced") && syncLine(A).includes("two@x.com"));
    expect(A.values()).toEqual([""]);                              // nothing of account one is visible
    expect(A.$$(".chip")).toHaveLength(0);
    expect(serverTexts(server)).toEqual(["account one note #private"]);   // and nothing was copied into account two
    expect(new Set(server.rows("entries").map((r) => r.user_id)).size).toBe(1);

    await A.click(A.byText(".btn", "Account"));
    await A.click(A.byText(".btn", "Sign out"));
    await until(() => syncLine(A).includes("Not syncing"));
    await signIn(A, "one@x.com", "secret1");
    await until(() => A.values().includes("account one note #private"));
  });

  it("signing out first uploads anything still waiting", async () => {
    const server = makeServer();
    const A = await device({ server });
    await signIn(A, "one@x.com", "secret1", "signup");
    await until(() => syncLine(A).startsWith("Synced"));
    await A.say("typed just before signing out");
    await A.click(A.byText(".btn", "Account"));
    await A.click(A.byText(".btn", "Sign out"));
    await until(() => serverTexts(server).includes("typed just before signing out"));
  });
});

describe("tabs in the same browser", () => {
  it("a line typed in one tab shows up in the other tab", async () => {
    const idb = new IDBFactory();
    const T1 = await device({ idb }); const T2 = await device({ idb });
    await T1.say("from tab one");
    await until(() => T2.values().includes("from tab one"));
  });

  it("a deletion in one tab shows up in the other", async () => {
    const idb = new IDBFactory();
    const T1 = await device({ idb }); const T2 = await device({ idb });
    await T1.say("gone soon");
    await until(() => T2.values().includes("gone soon"));
    await T1.type(T1.fields()[0], ""); await T1.press(T1.fields()[0], "Backspace");
    await until(() => !T2.values().includes("gone soon"));
  });
});

describe("upgrading an existing database", () => {
  it("notes written before sync existed are kept, and are uploaded on first sign-in", async () => {
    const idb = new IDBFactory();
    const old = new Dexie("notetime-prototype", { indexedDB: idb, IDBKeyRange });
    old.version(1).stores({ notes: "id,updatedAt", entries: "id,noteId,createdAt", settings: "key" });
    await old.table("notes").put({ id: "n-old", title: "Old note", createdAt: 1000, updatedAt: 2000 });
    await old.table("entries").put({ id: "e-old", noteId: "n-old", createdAt: 1500, text: "from the old version #legacy", images: [] });
    old.close();

    const server = makeServer();
    const A = await device({ server, idb });
    expect(A.values()).toContain("from the old version #legacy");
    expect(A.$(".title").value).toBe("Old note");
    await signIn(A, "a@x.com", "secret1", "signup");
    await until(() => serverTexts(server).includes("from the old version #legacy"));
    expect(server.rows("notes").map((n) => n.title)).toContain("Old note");
  });
});
