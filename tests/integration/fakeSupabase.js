/* A small in-memory stand-in for Supabase: auth, the two tables with the same
   "keep the newer edit" rule as the SQL trigger, per-user row security, realtime pings,
   and failure injection. Shared by every simulated device. */
export function makeServer() {
  const s = {
    users: new Map(),
    tables: { notes: new Map(), entries: new Map() },
    clock: 0,
    clients: new Set(),
    fail: null,
    upserts: [],
    requireConfirm: false,
    subscribeCount: 0,
    pushHook: null,
    pullHook: null,
    stamp() { s.clock++; return new Date(Date.UTC(2026, 0, 1) + s.clock * 1000).toISOString(); },
    rows(table) { return [...s.tables[table].values()]; },
    /* a change made by something other than this client, e.g. another device */
    externalWrite(table, row, userId) {
      s.tables[table].set(row.id, { ...row, user_id: userId, server_updated_at: s.stamp() });
      s.clients.forEach((c) => c._notify(userId, table));
    },
  };
  return s;
}

export function makeClient(server, store = { session: null }) {
  const listeners = new Set();
  const handlers = [];
  const emit = (evt) => listeners.forEach((cb) => cb(evt, store.session));
  const uid = () => (store.session ? store.session.user.id : null);

  const client = {
    auth: {
      async signUp({ email, password }) {
        if (server.users.has(email)) return { data: { session: null }, error: { message: "User already registered" } };
        server.users.set(email, { id: "user-" + (server.users.size + 1), email, password });
        if (server.requireConfirm) return { data: { session: null }, error: null };
        return client.auth.signInWithPassword({ email, password });
      },
      async signInWithPassword({ email, password }) {
        const u = server.users.get(email);
        if (!u || u.password !== password) return { data: { session: null }, error: { message: "Invalid login credentials" } };
        store.session = { user: { id: u.id, email } };
        emit("SIGNED_IN");
        return { data: { session: store.session }, error: null };
      },
      async signOut() { store.session = null; emit("SIGNED_OUT"); return { error: null }; },
      onAuthStateChange(cb) {
        listeners.add(cb);
        setTimeout(() => cb("INITIAL_SESSION", store.session), 0);
        return { data: { subscription: { unsubscribe() { listeners.delete(cb); } } } };
      },
    },
    from(table) {
      return {
        async upsert(rows) {
          server.upserts.push({ table, n: rows.length });
          if (server.fail) return { error: { message: server.fail } };
          if (!uid()) return { error: { message: "not authenticated" } };
          for (const r of rows) {
            const cur = server.tables[table].get(r.id);
            if (cur && cur.user_id !== uid()) return { error: { message: "new row violates row-level security policy" } };
            if (cur && cur.updated_at > r.updated_at) continue; // keep_newer trigger
            server.tables[table].set(r.id, { ...r, user_id: uid(), server_updated_at: server.stamp() });
          }
          const who = uid();
          if (server.pushHook) { const h = server.pushHook; server.pushHook = null; await h(table, rows); }
          setTimeout(() => server.clients.forEach((c) => c._notify(who, table)), 0);
          return { error: null };
        },
        select() {
          const q = { v: "", n: 1000 };
          const b = {
            gt(_c, v) { q.v = v; return b; },
            order() { return b; },
            limit(n) { q.n = n; return b; },
            then(res, rej) {
              let out;
              if (server.fail) out = { data: null, error: { message: server.fail } };
              else if (!uid()) out = { data: [], error: null };
              else {
                const data = server.rows(table)
                  .filter((r) => r.user_id === uid() && r.server_updated_at > q.v)
                  .sort((a, c) => (a.server_updated_at < c.server_updated_at ? -1 : 1))
                  .slice(0, q.n).map((r) => ({ ...r }));
                out = { data, error: null };
              }
              const run = async () => {
                if (server.pullHook && out.data) { const h = server.pullHook; server.pullHook = null; await h(table); }
                return out;
              };
              return run().then(res, rej);
            },
          };
          return b;
        },
      };
    },
    channel() {
      const ch = { on(_t, f, cb) { handlers.push({ table: f && f.table, cb }); return ch; }, subscribe() { server.subscribeCount++; server.clients.add(client); return ch; } };
      return ch;
    },
    removeChannel() { server.clients.delete(client); handlers.length = 0; },
    _notify(user, table) { if (uid() === user) handlers.filter((h) => !table || h.table === table).forEach((h) => h.cb({})); },
    _emit: (evt) => emit(evt),
  };
  return client;
}
