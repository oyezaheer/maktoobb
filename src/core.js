(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NTCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function pad(n, l) { return String(n).padStart(l || 2, "0"); }

  function fmtTime(ms, showMs) {
    var d = new Date(ms);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + (showMs ? "." + pad(d.getMilliseconds(), 3) : "");
  }
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function dayLabel(ms) {
    return new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  /* A tag starts at the beginning of the text or after a character that is not a
     letter, digit, underscore, # or / (so C#, a#b and URL anchors are not tags),
     and must end on a letter, digit or underscore (no trailing hyphen or full stop). */
  var TAG_SRC = "(?<![\\p{L}\\p{N}_#/&])#[\\p{L}\\p{N}_-]*[\\p{L}\\p{N}_]";
  var TAG_SPLIT = new RegExp("(" + TAG_SRC + ")", "u");
  var TAG_ALL = new RegExp(TAG_SRC, "gu");

  function splitTags(text) { return String(text).split(TAG_SPLIT); }

  function extractTags(text) {
    var found = String(text).match(TAG_ALL) || [], seen = {}, out = [];
    found.forEach(function (t) {
      var k = t.slice(1).toLowerCase();
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out;
  }
  function hue(tag) {
    var s = String(tag).replace(/^#/, "").toLowerCase(), x = 7;
    for (var i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 360;
    return x;
  }
  function tagCounts(entries, limit) {
    var m = {};
    entries.forEach(function (e) { extractTags(e.text).forEach(function (t) { m[t] = (m[t] || 0) + 1; }); });
    var arr = Object.keys(m).map(function (t) { return [t, m[t]]; });
    arr.sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); });
    return limit ? arr.slice(0, limit) : arr;
  }

  function groupByDay(items) {
    var groups = [];
    items.forEach(function (it) {
      var k = dayKey(it.ts), g = groups[groups.length - 1];
      if (!g || g.key !== k) { g = { key: k, label: dayLabel(it.ts), items: [] }; groups.push(g); }
      g.items.push(it);
    });
    return groups;
  }
  function arrangeGroups(groups, newestTop) {
    if (!newestTop) return groups;
    return groups.slice().reverse().map(function (g) {
      return { key: g.key, label: g.label, items: g.items.slice().reverse() };
    });
  }
  function flattenOrder(groups) {
    var out = [];
    groups.forEach(function (g) { g.items.forEach(function (it) { out.push(it.id); }); });
    return out;
  }

  /* timestamp rules */
  /* "On first keystroke": freeze the time when the first character is typed.
   "On new line": stay live while typing; the time is taken when Enter is pressed. */
  function draftStampOnInput(o) {
    if (o.freeze !== "keystroke") return null;
    var c = o.createdAt;
    if (c == null && o.text.length) c = o.now;
    if (o.text === "" && !o.hasImages) c = null;
    return c;
  }
  function nextStamp(candidate, lastStamp) { return Math.max(candidate, lastStamp + 1); }
  function stampAfterCommit() { return null; }

  /* pasted text */
  function splitPastedLines(txt) {
    return String(txt).split(/\r\n|\r|\n/).map(function (l) { return l.replace(/\s+$/, ""); }).filter(function (l) { return l.trim(); });
  }
  function shouldSplitPaste(txt) { return splitPastedLines(txt).length > 1; }
  function buildImportEntries(lines, o) {
    var base = Math.max(o.now, o.lastStamp + 1);
    return lines.map(function (l, i) {
      return { id: o.idFn(), noteId: o.noteId, createdAt: base + i, text: l, images: [] };
    });
  }

  function filterEntries(o) {
    var q = (o.query || "").trim().toLowerCase();
    var r = o.entries.filter(function (e) {
      return (!o.tag || extractTags(e.text).indexOf(o.tag) !== -1) && (!q || e.text.toLowerCase().indexOf(q) !== -1);
    });
    r.sort(function (a, b) { return o.newestTop ? b.createdAt - a.createdAt : a.createdAt - b.createdAt; });
    return r;
  }

  function noteToText(note, entries, showMs) {
    var out = [note.title || "Untitled Note", ""], last = "";
    entries.slice().sort(function (a, b) { return a.createdAt - b.createdAt; }).forEach(function (e) {
      var k = dayKey(e.createdAt);
      if (k !== last) { if (last) out.push(""); out.push(dayLabel(e.createdAt)); last = k; }
      out.push(fmtTime(e.createdAt, showMs) + "  " + e.text + (e.images && e.images.length ? "  [image x" + e.images.length + "]" : ""));
    });
    return out.join("\n");
  }

  return {
    fmtTime: fmtTime, dayKey: dayKey, dayLabel: dayLabel,
    splitTags: splitTags, extractTags: extractTags, hue: hue, tagCounts: tagCounts,
    groupByDay: groupByDay, arrangeGroups: arrangeGroups, flattenOrder: flattenOrder,
    draftStampOnInput: draftStampOnInput, nextStamp: nextStamp, stampAfterCommit: stampAfterCommit,
    splitPastedLines: splitPastedLines, shouldSplitPaste: shouldSplitPaste, buildImportEntries: buildImportEntries,
    filterEntries: filterEntries, noteToText: noteToText
  };
});
