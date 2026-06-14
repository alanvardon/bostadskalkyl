/* mortgagetracker-store.js — persistence for Bolånekoll (the mortgage tracker).

   Three collections plus a small settings blob, mirroring how the household
   actually thinks about its mortgage:
     • loan_parts  — the lånedelar (each its own start balance, rate, number).
                     The anchor for every part's running balance.
     • payments    — imported (or manual) payment rows: ränta + amortering per
                     draw. Each links to a loan part by id.
     • valuations  — manual property-value snapshots over time; equity is the
                     property value minus the outstanding debt.

   Today everything lives in one localStorage envelope; the rows are shaped 1:1
   with future Supabase tables (`mortgage_loan_parts`, `mortgage_payments`,
   `mortgage_valuations`, snake_case) and every method returns a Promise, so
   swapping to the Supabase client later is a one-file change here — no edits at
   the call sites in mortgagetracker.js.

   This is a browser IIFE (attaches to window.App.mortgageStore); the tests run
   the source in a vm sandbox with a fake localStorage, like manadsavslut-store.js. */
(function () {
  'use strict';

  var STORAGE_KEY = 'bostadskalkyl_mortgage_v1';
  var VERSION = 1;

  function _defaultSettings() {
    return {
      property_name: '',
      owner_a_name: 'Alex',
      owner_b_name: 'Sam',
      my_ownership_pct: 50,
      i_am: 'a',
      currency: 'SEK',
      ranteavdrag: true
    };
  }

  // Read the whole envelope. Tolerates a missing/corrupt key by returning an
  // empty store so the UI never throws.
  function _read() {
    var empty = { version: VERSION, loan_parts: [], payments: [], valuations: [], settings: _defaultSettings() };
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return empty;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return empty;
      return {
        version: VERSION,
        loan_parts: Array.isArray(data.loan_parts) ? data.loan_parts : [],
        payments: Array.isArray(data.payments) ? data.payments : [],
        valuations: Array.isArray(data.valuations) ? data.valuations : [],
        settings: Object.assign(_defaultSettings(), data.settings || {})
      };
    } catch (_) {
      return empty;
    }
  }

  function _write(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: VERSION,
        loan_parts: data.loan_parts,
        payments: data.payments,
        valuations: data.valuations,
        settings: data.settings
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

  function _stamp(record, prefix) {
    return Object.assign({}, record, {
      id: record.id || _id(prefix),
      created_at: record.created_at || new Date().toISOString()
    });
  }

  // Newest first by created_at.
  function _byCreatedDesc(rows) {
    return rows.slice().sort(function (a, b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }
  // Most recent transaction/valuation date first; created_at breaks ties. Used
  // for the list surfaces, where the date that matters is the row's own date,
  // not when it happened to be imported.
  function _byDateDesc(rows) {
    return rows.slice().sort(function (a, b) {
      var d = String(b.date || '').localeCompare(String(a.date || ''));
      return d !== 0 ? d : String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }

  // ── Loan parts ───────────────────────────────────────────────────────────
  // Kept in insertion order (Lånedel 1 stays first) — a stable, predictable list.
  function listLoanParts() { return Promise.resolve(_read().loan_parts.slice()); }

  function addLoanPart(record) {
    var saved = _stamp(record, 'part');
    var data = _read();
    data.loan_parts.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  function updateLoanPart(id, patch) {
    var data = _read();
    var found = null;
    data.loan_parts = data.loan_parts.map(function (p) {
      if (p && p.id === id) { found = Object.assign({}, p, patch); return found; }
      return p;
    });
    _write(data);
    return Promise.resolve(found);
  }

  // Delete a loan part AND its payments (an orphaned payment would silently stop
  // moving any balance). Resolves the remaining loan-part count.
  function removeLoanPart(id) {
    var data = _read();
    data.loan_parts = data.loan_parts.filter(function (p) { return p && p.id !== id; });
    data.payments = data.payments.filter(function (pay) { return !(pay && pay.loan_part_id === id); });
    _write(data);
    return Promise.resolve(data.loan_parts.length);
  }

  // ── Payments ───────────────────────────────────────────────────────────────
  function listPayments() { return Promise.resolve(_byDateDesc(_read().payments)); }

  function addPayment(record) {
    var saved = _stamp(record, 'pay');
    var data = _read();
    data.payments.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  // Add many in one write (used by CSV import) — resolves the saved rows.
  function addPayments(records) {
    var data = _read();
    var saved = (records || []).map(function (r) { return _stamp(r, 'pay'); });
    data.payments = data.payments.concat(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  function updatePayment(id, patch) {
    var data = _read();
    var found = null;
    data.payments = data.payments.map(function (p) {
      if (p && p.id === id) { found = Object.assign({}, p, patch); return found; }
      return p;
    });
    _write(data);
    return Promise.resolve(found);
  }

  function removePayment(id) {
    var data = _read();
    data.payments = data.payments.filter(function (p) { return p && p.id !== id; });
    _write(data);
    return Promise.resolve(data.payments.length);
  }

  // Bulk-delete by id in one write. Resolves the number actually removed.
  function removePayments(ids) {
    var drop = {};
    (ids || []).forEach(function (id) { drop[id] = true; });
    var data = _read();
    var before = data.payments.length;
    data.payments = data.payments.filter(function (p) { return !(p && drop[p.id]); });
    _write(data);
    return Promise.resolve(before - data.payments.length);
  }

  // ── Valuations ─────────────────────────────────────────────────────────────
  function listValuations() { return Promise.resolve(_byDateDesc(_read().valuations)); }

  function addValuation(record) {
    var saved = _stamp(record, 'val');
    var data = _read();
    data.valuations.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  function updateValuation(id, patch) {
    var data = _read();
    var found = null;
    data.valuations = data.valuations.map(function (v) {
      if (v && v.id === id) { found = Object.assign({}, v, patch); return found; }
      return v;
    });
    _write(data);
    return Promise.resolve(found);
  }

  function removeValuation(id) {
    var data = _read();
    data.valuations = data.valuations.filter(function (v) { return v && v.id !== id; });
    _write(data);
    return Promise.resolve(data.valuations.length);
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
      loan_parts: data.loan_parts,
      payments: _byDateDesc(data.payments),
      valuations: _byDateDesc(data.valuations),
      settings: data.settings
    }, null, 2));
  }

  // Merge a previously-exported backup. Every collection is deduped by id so
  // re-importing the same file is idempotent (a restore, not a wipe). Settings
  // are adopted only if present. Resolves { loan_parts, payments, valuations } =
  // new rows added; rejects on unparseable / unrecognised input.
  function importJSON(text) {
    return new Promise(function (resolve, reject) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (_) { reject(new Error('That file isn’t valid JSON.')); return; }
      if (!parsed || typeof parsed !== 'object') { reject(new Error('No Bolånekoll data found in that file.')); return; }
      if (!parsed.loan_parts && !parsed.payments && !parsed.valuations) {
        reject(new Error('No Bolånekoll data found in that file.')); return;
      }

      var data = _read();
      var added = { loan_parts: 0, payments: 0, valuations: 0 };

      function merge(collection, incoming, prefix) {
        var seen = {};
        collection.forEach(function (r) { if (r && r.id) seen[r.id] = true; });
        var n = 0;
        (Array.isArray(incoming) ? incoming : []).forEach(function (raw) {
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

      added.loan_parts = merge(data.loan_parts, parsed.loan_parts, 'part');
      added.payments = merge(data.payments, parsed.payments, 'pay');
      added.valuations = merge(data.valuations, parsed.valuations, 'val');
      if (parsed.settings && typeof parsed.settings === 'object') {
        data.settings = Object.assign(_defaultSettings(), data.settings, parsed.settings);
      }
      _write(data);
      resolve(added);
    });
  }

  window.App = window.App || {};
  window.App.mortgageStore = {
    STORAGE_KEY: STORAGE_KEY,
    listLoanParts: listLoanParts,
    addLoanPart: addLoanPart,
    updateLoanPart: updateLoanPart,
    removeLoanPart: removeLoanPart,
    listPayments: listPayments,
    addPayment: addPayment,
    addPayments: addPayments,
    updatePayment: updatePayment,
    removePayment: removePayment,
    removePayments: removePayments,
    listValuations: listValuations,
    addValuation: addValuation,
    updateValuation: updateValuation,
    removeValuation: removeValuation,
    getSettings: getSettings,
    saveSettings: saveSettings,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
}());
