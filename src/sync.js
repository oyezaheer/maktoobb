(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NTSync = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TABLES = ["notes", "entries"];
  var EPOCH = "1970-01-01T00:00:00Z";

  /* local row (camelCase, 0/1 flags) -> server row (snake_case, booleans) */
  function toRemote(table, r) {
    if (table === "notes") {
      return { id: r.id, title: r.title || "", created_at: r.createdAt, updated_at: r.updatedAt, deleted: !!r.deleted };
    }
    return {
      id: r.id, note_id: r.noteId, created_at: r.createdAt, updated_at: r.updatedAt,
      text: r.text || "", images: r.images || [], deleted: !!r.deleted
    };
  }

  /* server row -> clean local row */
  function fromRemote(table, r) {
    if (table === "notes") {
      return { id: r.id, title: r.title || "", createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), deleted: r.deleted ? 1 : 0, dirty: 0 };
    }
    return {
      id: r.id, noteId: r.note_id, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      text: r.text || "", images: r.images || [], deleted: r.deleted ? 1 : 0, dirty: 0
    };
  }

  /* split rows into requests of at most maxRows rows and roughly maxBytes of JSON */
  function chunk(rows, maxRows, maxBytes) {
    var out = [], cur = [], size = 0;
    rows.forEach(function (r) {
      var s = JSON.stringify(r).length;
      if (cur.length && (cur.length >= maxRows || size + s > maxBytes)) { out.push(cur); cur = []; size = 0; }
      cur.push(r); size += s;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  function createEngine(deps) {
    var local = deps.local, remote = deps.remote;
    var pageSize = deps.pageSize || 1000, chunkRows = deps.chunkRows || 100, chunkBytes = deps.chunkBytes || 800000;

    async function push() {
      var pushed = 0;
      for (var i = 0; i < TABLES.length; i++) {
        var table = TABLES[i];
        var dirty = await local.getDirty(table);
        var batches = chunk(dirty, chunkRows, chunkBytes);
        for (var b = 0; b < batches.length; b++) {
          var batch = batches[b];
          var res = await remote.upsert(table, batch.map(function (r) { return toRemote(table, r); }));
          if (res && res.error) throw new Error(res.error.message || "push failed");
          await local.markClean(table, batch);
          pushed += batch.length;
        }
      }
      return pushed;
    }

    async function pull(userId) {
      var applied = 0;
      for (var i = 0; i < TABLES.length; i++) {
        var table = TABLES[i], key = userId + ":" + table;
        var cursor = (await local.getCursor(key)) || EPOCH;
        for (;;) {
          var res = await remote.pull(table, cursor, pageSize);
          if (res.error) throw new Error(res.error.message || "pull failed");
          var rows = res.data || [];
          for (var k = 0; k < rows.length; k++) {
            if (await local.applyRemote(table, fromRemote(table, rows[k]))) applied++;
          }
          if (rows.length) {
            cursor = rows[rows.length - 1].server_updated_at;
            await local.setCursor(key, cursor);
          }
          if (rows.length < pageSize) break;
        }
      }
      return applied;
    }

    async function run(userId) {
      await local.flush();
      var pushed = await push();
      var pulled = await pull(userId);
      if (pulled && deps.onApplied) deps.onApplied();
      return { pushed: pushed, pulled: pulled };
    }

    return { run: run };
  }

  return { toRemote: toRemote, fromRemote: fromRemote, chunk: chunk, createEngine: createEngine, EPOCH: EPOCH };
});