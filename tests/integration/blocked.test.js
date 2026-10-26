import { describe, it, expect } from "vitest";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { boot, until, sleep } from "./harness.js";

describe("upgrade blocked by another connection", () => {
  it("reproduces the blank screen", async () => {
    const idb = new IDBFactory();
    const old = new Dexie("notetime-prototype", { indexedDB: idb, IDBKeyRange });
    old.version(1).stores({ notes: "id,updatedAt", entries: "id,noteId,createdAt", settings: "key" });
    await old.table("notes").put({ id: "n", title: "T", createdAt: 1, updatedAt: 2 });
    old.close();
    // another tab/window that holds the database open and never answers "versionchange"
    const holder = await new Promise((res, rej) => { const r = idb.open("notetime-prototype"); r.onsuccess = () => res(r.result); r.onerror = rej; });
    holder.onversionchange = () => {};   // ignores the request, like a frozen background tab
    const A = await boot({ idb, ready: false });
    await sleep(3600);
    console.log("frame present:", !!A.$(".app"), "| sidebar present:", !!A.$(".sidebar"), "| errors:", A.errors.length);
    console.log("alert text:", A.$("[role=alert]") && A.$("[role=alert]").textContent);
    holder.close();
    await sleep(1500);
    console.log("after the other tab closes -> sidebar present:", !!A.$(".sidebar"));
    A.close();
  }, 20000);
});
