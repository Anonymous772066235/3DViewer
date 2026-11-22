/* [L1·缓存] lod_cache.js — LOD 几何的 IndexedDB 缓存
 * 依赖：无（只用浏览器 IndexedDB）
 * 导出：MV.lodCache.get(key) / put(key, lods) / clear()
 */
(function (global)
{
    'use strict';
    global.MV = global.MV || {};

    var DB_NAME = 'viewer3d-lod';
    var STORE = 'lods';
    var VER = 1;
    var dbPromise = null;

    function open()
    {
        if (dbPromise) { return dbPromise; }
        dbPromise = new Promise(function (resolve, reject)
        {
            if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            var req = global.indexedDB.open(DB_NAME, VER);
            req.onupgradeneeded = function ()
            {
                var db = req.result;
                if (!db.objectStoreNames.contains(STORE))
                {
                    db.createObjectStore(STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
        });
        return dbPromise;
    }

    function get(key)
    {
        return open().then(function (db)
        {
            return new Promise(function (resolve)
            {
                try
                {
                    var tx = db.transaction(STORE, 'readonly');
                    var req = tx.objectStore(STORE).get(key);
                    req.onsuccess = function ()
                    {
                        var rec = req.result;
                        resolve(rec && rec.lods && rec.lods.length ? rec.lods : null);
                    };
                    req.onerror = function () { resolve(null); };
                }
                catch (e) { resolve(null); }
            });
        }).catch(function () { return null; });
    }

    function put(key, lods)
    {
        if (!lods || !lods.length) { return Promise.resolve(false); }
        return open().then(function (db)
        {
            return new Promise(function (resolve)
            {
                try
                {
                    var tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).put({ key: key, lods: lods, ts: Date.now() });
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror = function () { resolve(false); };
                }
                catch (e) { resolve(false); }
            });
        }).catch(function () { return false; });
    }

    function clear()
    {
        return open().then(function (db)
        {
            return new Promise(function (resolve)
            {
                try
                {
                    var tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).clear();
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror = function () { resolve(false); };
                }
                catch (e) { resolve(false); }
            });
        }).catch(function () { return false; });
    }

    global.MV.lodCache = { get: get, put: put, clear: clear };
})(window);
