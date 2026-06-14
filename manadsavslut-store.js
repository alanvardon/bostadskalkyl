/* manadsavslut-store.js — persistence for Månadsavslut (the month-end close).

   Two linked collections, mirroring the old Airtable base:
     • items    — individual shared purchases (the children)
     • payments — the net month-end settlements that close a batch of items
   plus a small settings blob (the two names, currency, default split).

   Today everything lives in one localStorage envelope; the rows are shaped 1:1
   with future Supabase tables (`recon_items`, `recon_payments`, snake_case) and
   every method returns a Promise, so swapping to the Supabase client later is a
   one-file change here — no edits at the call sites in manadsavslut.js.

   This is a browser IIFE (attaches to window.App.monthEndStore); the tests run
   the source in a vm sandbox with a fake localStorage, like salary-store.js. */
(function () {
  'use strict';

  var STORAGE_KEY = 'bostadskalkyl_monthend_v1';
  var VERSION = 1;

  function _defaultSettings() {
    return { person_a_name: 'Alex', person_b_name: 'Sam', currency: 'SEK', default_split: true };
  }

  // Read the whole envelope. Tolerates a missing/corrupt key by returning an
  // empty store so the UI never throws.
  function _read() {
    var empty = { version: VERSION, items: [], payments: [], settings: _defaultSettings() };
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return empty;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return empty;
      return {
        version: VERSION,
        items: Array.isArray(data.items) ? data.items : [],
        payments: Array.isArray(data.payments) ? data.payments : [],
        settings: Object.assign(_defaultSettings(), data.settings || {})
      };
    } catch (_) {
      return empty;
    }
  }

  function _write(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: VERSION, items: data.items, payments: data.payments, settings: data.settings
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Client-side id; Supabase would supply this via gen_random_uuid().
  function _id(prefix) {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (_) {}
    return (prefix || 'row') + '-' + new Date().getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // Newest first by created_at — shared by every list surface.
  function _sortedDesc(rows) {
    return rows.slice().sort(function (a, b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }

  function _stamp(record, prefix) {
    return Object.assign({}, record, {
      id: record.id || _id(prefix),
      created_at: record.created_at || new Date().toISOString()
    });
  }

  // ── Items ──────────────────────────────────────────────────────────────
  function listItems() { return Promise.resolve(_sortedDesc(_read().items)); }

  function addItem(record) {
    var saved = _stamp(record, 'item');
    var data = _read();
    data.items.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  // Add many in one write (used by CSV import) — resolves the saved rows.
  function addItems(records) {
    var data = _read();
    var saved = (records || []).map(function (r) { return _stamp(r, 'item'); });
    data.items = data.items.concat(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  // Patch one item; resolves the updated row (or null if no match).
  function updateItem(id, patch) {
    var data = _read();
    var found = null;
    data.items = data.items.map(function (it) {
      if (it && it.id === id) { found = Object.assign({}, it, patch); return found; }
      return it;
    });
    _write(data);
    return Promise.resolve(found);
  }

  function removeItem(id) {
    var data = _read();
    data.items = data.items.filter(function (it) { return it && it.id !== id; });
    _write(data);
    return Promise.resolve(data.items.length);
  }

  // Bulk-delete by id in one write (used by "delete all open"). Resolves the
  // number of rows actually removed.
  function removeItems(ids) {
    var drop = {};
    (ids || []).forEach(function (id) { drop[id] = true; });
    var data = _read();
    var before = data.items.length;
    data.items = data.items.filter(function (it) { return !(it && drop[it.id]); });
    _write(data);
    return Promise.resolve(before - data.items.length);
  }

  // ── Payments (settlements) ───────────────────────────────────────────────
  function listPayments() { return Promise.resolve(_sortedDesc(_read().payments)); }

  // Close a settlement: save the payment AND flip its linked items to paid,
  // stamping them with the payment id. This is the month-end "net to one
  // transfer + group the items" action. Resolves the saved payment.
  function settle(draft) {
    var data = _read();
    var payment = _stamp(draft || {}, 'pay');
    var ids = {};
    (payment.item_ids || []).forEach(function (id) { ids[id] = true; });
    data.items = data.items.map(function (it) {
      return (it && ids[it.id]) ? Object.assign({}, it, { paid: true, payment_id: payment.id }) : it;
    });
    data.payments.push(payment);
    _write(data);
    return Promise.resolve(payment);
  }

  // Delete a payment and reopen its items (paid → false, unlink). Resolves the
  // remaining payment count.
  function removePayment(id) {
    var data = _read();
    data.payments = data.payments.filter(function (p) { return p && p.id !== id; });
    data.items = data.items.map(function (it) {
      return (it && it.payment_id === id) ? Object.assign({}, it, { paid: false, payment_id: null }) : it;
    });
    _write(data);
    return Promise.resolve(data.payments.length);
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  function getSettings() { return Promise.resolve(_read().settings); }

  function saveSettings(patch) {
    var data = _read();
    data.settings = Object.assign(_defaultSettings(), data.settings, patch || {});
    _write(data);
    return Promise.resolve(data.settings);
  }

  // ── Backup ───────────────────────────────────────────────────────────────
  function exportJSON() {
    var data = _read();
    return Promise.resolve(JSON.stringify({
      version: VERSION,
      items: _sortedDesc(data.items),
      payments: _sortedDesc(data.payments),
      settings: data.settings
    }, null, 2));
  }

  // Merge a previously-exported backup. Items and payments are deduped by id so
  // re-importing the same file is idempotent (a restore, not a wipe). Settings
  // are adopted only if present. Resolves { items, payments } = new rows added;
  // rejects on unparseable input.
  function importJSON(text) {
    return new Promise(function (resolve, reject) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (_) { reject(new Error('That file isn’t valid JSON.')); return; }
      if (!parsed || typeof parsed !== 'object') { reject(new Error('No Månadsavslut data found in that file.')); return; }
      var inItems = Array.isArray(parsed.items) ? parsed.items : [];
      var inPays = Array.isArray(parsed.payments) ? parsed.payments : [];
      if (!parsed.items && !parsed.payments) { reject(new Error('No Månadsavslut data found in that file.')); return; }

      var data = _read();
      var added = { items: 0, payments: 0 };

      function merge(collection, incoming, prefix) {
        var seen = {};
        collection.forEach(function (r) { if (r && r.id) seen[r.id] = true; });
        var n = 0;
        incoming.forEach(function (raw) {
          if (!raw || typeof raw !== 'object') return;
          var row = Object.assign({}, raw);
          if (!row.id) row.id = _id(prefix);
          if (seen[row.id]) return;
          if (!row.created_at) row.created_at = new Date().toISOString();
          seen[row.id] = true;
          collection.push(row);
          n++;
        });
        return n;
      }

      added.items = merge(data.items, inItems, 'item');
      added.payments = merge(data.payments, inPays, 'pay');
      if (parsed.settings && typeof parsed.settings === 'object') {
        data.settings = Object.assign(_defaultSettings(), data.settings, parsed.settings);
      }
      _write(data);
      resolve(added);
    });
  }

  window.App = window.App || {};
  window.App.monthEndStore = {
    STORAGE_KEY: STORAGE_KEY,
    listItems: listItems,
    addItem: addItem,
    addItems: addItems,
    updateItem: updateItem,
    removeItem: removeItem,
    removeItems: removeItems,
    listPayments: listPayments,
    settle: settle,
    removePayment: removePayment,
    getSettings: getSettings,
    saveSettings: saveSettings,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
}());
