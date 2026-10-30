/*
 Website stand-in for the Claude artifact runtime (window.claude).
 Gallup's page asks window.claude.use("db" | "user" | "sample"). On the website there is no Claude, so this
 script answers instead:
   - "db"     a small document store kept in this browser's localStorage, started from the snapshot that
              build_site.js bundles into the page (window.__GALLUP_SNAPSHOT). Same calls the page uses:
              collection(name).onSnapshot / doc() / add(), and doc("collection/id").get / set / update /
              delete / onSnapshot.
   - "user"   one local person ("You"); every record is editable.
   - "sample" not available (Ask Gallup needs Claude), so the page hides it.
 Nothing here talks to a server.
*/
(function () {
  'use strict';
  var KEY = 'gallup-plm:records:v1';
  var SNAP = window.__GALLUP_SNAPSHOT || { collections: {}, settings: null };
  var persistent = true, store, listeners = [];
  var clone = function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
  var isObj = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
  function merge(a, b) { var o = Object.assign({}, a); Object.keys(b).forEach(function (k) { o[k] = isObj(b[k]) && isObj(a[k]) ? merge(a[k], b[k]) : b[k]; }); return o; }
  function fromSnapshot() {
    var s = { collections: { config: {} }, snapshot: SNAP.exported || null };
    Object.keys(SNAP.collections || {}).forEach(function (c) {
      s.collections[c] = {};
      (SNAP.collections[c] || []).forEach(function (r) { var b = clone(r); var id = String(b.id); delete b.id; s.collections[c][id] = b; });
    });
    if (SNAP.settings) s.collections.config.settings = clone(SNAP.settings);
    return s;
  }
  function load() {
    try { var t = localStorage.getItem(KEY); if (t) { var j = JSON.parse(t); if (j && isObj(j.collections)) return j; } }
    catch (e) { persistent = false; }
    return fromSnapshot();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { persistent = false; } }
  function notify() { setTimeout(function () { listeners.slice().forEach(function (l) { l.fire(); }); }, 0); }
  function commit() { store.updated = new Date().toISOString(); save(); notify(); }
  function newId() { var a = 'abcdefghijklmnopqrstuvwxyz0123456789', s = '', r = new Uint8Array(20); crypto.getRandomValues(r); for (var i = 0; i < 20; i++) s += a[r[i] % 36]; return s; }
  function coll(c) { return store.collections[c] || (store.collections[c] = {}); }
  function snapDoc(c, id) { var v = (store.collections[c] || {})[id]; return { id: id, exists: !!v, data: function () { return clone(v); }, metadata: { fromCache: false, hasPendingWrites: false } }; }
  function listen(fire) { var l = { fire: fire }; listeners.push(l); setTimeout(fire, 0); return function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; }
  var SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  function docRef(c, id) {
    if (!SEG.test(c) || !SEG.test(id)) throw new TypeError('Invalid document path: ' + c + '/' + id);
    return {
      id: id, path: c + '/' + id,
      get: function () { return Promise.resolve(snapDoc(c, id)); },
      set: function (d) { if (!isObj(d)) return Promise.reject({ code: 'invalid_argument', message: 'Body must be an object' }); coll(c)[id] = clone(d); commit(); return Promise.resolve(); },
      update: function (d) { var cur = coll(c)[id]; if (!cur) return Promise.reject({ code: 'invalid_argument', message: 'Document does not exist' }); coll(c)[id] = merge(cur, clone(d)); commit(); return Promise.resolve(); },
      delete: function () { delete coll(c)[id]; commit(); return Promise.resolve(); },
      onSnapshot: function (next) { return listen(function () { next(snapDoc(c, id)); }); },
    };
  }
  function collRef(c) {
    if (!SEG.test(c)) throw new TypeError('Invalid collection path: ' + c);
    return {
      path: c,
      doc: function (id) { return docRef(c, id || newId()); },
      add: function (d) { var r = docRef(c, newId()); return r.set(d).then(function () { return r; }); },
      onSnapshot: function (next) {
        return listen(function () {
          var docs = Object.keys(store.collections[c] || {}).sort().map(function (id) { return snapDoc(c, id); });
          next({ docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } });
        });
      },
    };
  }
  var db = Object.freeze({
    doc: function (path) { var p = String(path).split('/'); if (p.length !== 2) throw new TypeError('Document paths have two segments here'); return docRef(p[0], p[1]); },
    collection: function (path) { var p = String(path).split('/'); if (p.length !== 1) throw new TypeError('Collection paths have one segment here'); return collRef(p[0]); },
  });
  var ME = 'local';
  var user = Object.freeze({
    id: function () { return Promise.resolve(ME); },
    can: function () { return Promise.resolve(true); },
    isOwner: function () { return Promise.resolve(true); },
    canEdit: function () { return Promise.resolve(true); },
    me: function () { return Promise.resolve({ id: ME, name: 'You', avatarUrl: '', color: '#2D3C9B', email: null, isOwner: true, canEdit: true }); },
    profiles: function (ids) { var o = {}; [].concat(ids).forEach(function (i) { o[i] = { id: i, name: i === ME ? 'You' : '', avatarUrl: '', color: '#7E849A', email: null, isMe: i === ME, guest: false }; }); return Promise.resolve(o); },
  });
  store = load();
  window.addEventListener('storage', function (e) { if (e.key === KEY) { store = load(); notify(); } });
  window.claude = Object.freeze({ use: function (name) { return Promise.resolve(name === 'db' ? db : name === 'user' ? user : null); } });
  window.__gallupLocal = Object.freeze({
    get persistent() { return persistent; },
    snapshotDate: SNAP.exported || null,
    reset: function () { try { localStorage.removeItem(KEY); } catch (e) { } store = fromSnapshot(); save(); notify(); },
  });
})();
