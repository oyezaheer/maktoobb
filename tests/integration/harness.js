import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BroadcastChannel as NodeBC } from "node:worker_threads";
import { makeClient } from "./fakeSupabase.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const html = fs.readFileSync(path.join(root, "dist/notetime.html"), "utf8");
const bodyHtml = html.replace(/<script src[^>]*><\/script>/g, "").replace(/<link[^>]*>/g, "");
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const LIBS = [lib("react/umd/react.production.min.js"), lib("react-dom/umd/react-dom.production.min.js"), lib("dexie/dist/dexie.min.js")];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const at = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

export const until = async (fn, timeout = 4000, step = 25) => {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting for: " + fn.toString().slice(0, 120));
    await sleep(step);
  }
};

export function makeClock(start) {
  return { t: start, set(x) { this.t = x; }, advance(ms) { this.t += ms; } };
}

export async function boot(opts = {}) {
  const { idb = new IDBFactory(), clock = makeClock(at(2026, 10, 26, 12, 0, 0)), noIdb = false, server = null, store = { session: null } } = opts;
  opts = { ...opts, idb, clock, store };
  const dom = new JSDOM(bodyHtml, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.test/" });
  const w = dom.window;
  const errors = [];
  w.addEventListener("error", (e) => errors.push(e.message));
  w.requestAnimationFrame = (f) => setTimeout(f, 0);

  const Real = w.Date;
  w.Date = class extends Real {
    constructor(...a) { if (a.length === 0) super(clock.t); else super(...a); }
    static now() { return clock.t; }
  };

  if (!noIdb) { w.indexedDB = idb; w.IDBKeyRange = IDBKeyRange; }
  else { Object.defineProperty(w, "indexedDB", { value: undefined, configurable: true }); }

  w.BroadcastChannel = class extends NodeBC { constructor(n) { super(n); this.unref(); } };
  let client = null;
  if (server) {
    client = makeClient(server, store);
    w.supabase = { createClient: () => client };
  }
  LIBS.forEach((src) => w.eval(src));
  w.console.error = (...a) => errors.push(a.join(" "));
  const cfgScript = server ? "window.NT_CONFIG = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_KEY: 'k', SYNC_DELAY_MS: 40 };" : inlineScripts[0];
  w.eval(cfgScript);
  inlineScripts.slice(1).forEach((src) => w.eval(src));
  await sleep(80);
  if (opts.ready !== false) await until(() => w.document.querySelector(".sidebar"), 10000).catch(() => {});

  const doc = w.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];
  const textareaSetter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value").set;
  const inputSetter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set;

  const A = {
    w, doc, $, $$, clock, idb, errors, store, client,
    settle: (ms = 30) => sleep(ms),
    fields: () => $$(".field textarea"),
    values: () => $$(".field textarea").map((t) => t.value),
    draft: () => $('.field textarea[aria-label="New entry"]'),
    stamps: () => $$(".log .row .ts").map((t) => t.textContent),
    heads: () => $$(".dayhead").map((t) => t.textContent),
    byText: (sel, text) => $$(sel).find((b) => b.textContent.trim() === text),
    async type(el, text) { textareaSetter.call(el, text); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(15); },
    async typeInto(el, text) { inputSetter.call(el, text); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(15); },
    async press(el, key, init = {}) {
      const ev = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      el.dispatchEvent(ev); await sleep(25); return ev;
    },
    async say(text) { // type into the draft and press Enter
      await A.type(A.draft(), text); await A.press(A.draft(), "Enter");
    },
    async click(el) { el.click(); await sleep(25); },
    async paste(el, { text = "", files = [] } = {}) {
      const ev = new w.Event("paste", { bubbles: true, cancelable: true });
      ev.clipboardData = {
        items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
        getData: () => text,
      };
      el.dispatchEvent(ev); await sleep(60); return ev;
    },
    async flush() { w.dispatchEvent(new w.Event("pagehide")); await sleep(80); },
    async reload() { await A.flush(); w.close(); return boot(opts); },
    async db() { const d = new w.Dexie("notetime-prototype"); await d.open(); return d; },
    close() { w.close(); },
  };
  return A;
}
