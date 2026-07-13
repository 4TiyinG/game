// model-cache.js — IndexedDB cache for GLB/GLTF model files
// 带版本校验和 TTL 机制，避免模型更新后仍返回旧缓存
(function() {
    var DB_NAME = '3d-model-cache';
    var DB_VERSION = 2; // 升级 DB 版本以添加新字段
    var STORE_NAME = 'models';
    var db = null;

    // 缓存有效期：7天（毫秒）
    var CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    // 缓存版本号：模型文件更新时递增此值
    var CACHE_VERSION = 2;

    function openDB() {
        return new Promise(function(resolve, reject) {
            if (db) { resolve(db); return; }
            var request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function(e) {
                var database = e.target.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: 'url' });
                }
                // 如果从旧版本升级，清除旧数据
                if (e.oldVersion < 2) {
                    var store = e.target.transaction.objectStore(STORE_NAME);
                    store.clear();
                    console.log('[ModelCache] DB 升级到 v2，已清除旧缓存');
                }
            };
            request.onsuccess = function(e) {
                db = e.target.result;
                resolve(db);
            };
            request.onerror = function(e) { reject(e.target.error); };
        });
    }

    // 生成缓存 key（包含版本号，版本变化时缓存自动失效）
    function cacheKey(url) {
        return url + '#v' + CACHE_VERSION;
    }

    // 保存模型数据到 IndexedDB
    function saveModel(url, arrayBuffer, metadata) {
        return openDB().then(function(database) {
            return new Promise(function(resolve, reject) {
                var tx = database.transaction(STORE_NAME, 'readwrite');
                var store = tx.objectStore(STORE_NAME);
                var record = {
                    url: cacheKey(url),
                    originalUrl: url,
                    data: arrayBuffer,
                    timestamp: Date.now(),
                    version: CACHE_VERSION,
                    metadata: metadata || {}
                };
                var req = store.put(record);
                req.onsuccess = function() { resolve(true); };
                req.onerror = function(e) { reject(e.target.error); };
            });
        }).catch(function(err) {
            console.warn('[ModelCache] 保存失败:', err.message);
            return false;
        });
    }

    // 从 IndexedDB 加载模型数据（含 TTL 校验）
    function loadModel(url) {
        return openDB().then(function(database) {
            return new Promise(function(resolve, reject) {
                var tx = database.transaction(STORE_NAME, 'readonly');
                var store = tx.objectStore(STORE_NAME);
                var req = store.get(cacheKey(url));
                req.onsuccess = function(e) {
                    var result = e.target.result;
                    if (result && result.data) {
                        // TTL 校验：超过有效期则视为过期
                        var age = Date.now() - result.timestamp;
                        if (age > CACHE_TTL) {
                            console.log('[ModelCache] 缓存已过期:', url, '(', Math.round(age / 86400000), '天)');
                            // 异步删除过期记录
                            removeModel(url);
                            resolve(null);
                            return;
                        }
                        // 版本校验
                        if (result.version !== CACHE_VERSION) {
                            console.log('[ModelCache] 缓存版本不匹配:', url);
                            removeModel(url);
                            resolve(null);
                            return;
                        }
                        resolve({ data: result.data, metadata: result.metadata, cached: true });
                    } else {
                        resolve(null);
                    }
                };
                req.onerror = function(e) { reject(e.target.error); };
            });
        }).catch(function(err) {
            console.warn('[ModelCache] 加载失败:', err.message);
            resolve(null);
        });
    }

    // 检查模型是否存在于缓存
    function hasModel(url) {
        return openDB().then(function(database) {
            return new Promise(function(resolve) {
                var tx = database.transaction(STORE_NAME, 'readonly');
                var store = tx.objectStore(STORE_NAME);
                var req = store.getKey(cacheKey(url));
                req.onsuccess = function(e) { resolve(!!e.target.result); };
                req.onerror = function() { resolve(false); };
            });
        });
    }

    // 从缓存中删除模型
    function removeModel(url) {
        return openDB().then(function(database) {
            return new Promise(function(resolve, reject) {
                var tx = database.transaction(STORE_NAME, 'readwrite');
                var store = tx.objectStore(STORE_NAME);
                var req = store.delete(cacheKey(url));
                req.onsuccess = function() { resolve(true); };
                req.onerror = function(e) { reject(e.target.error); };
            });
        }).catch(function() { return false; });
    }

    // 获取缓存信息（含大小统计）
    function getCacheInfo() {
        return openDB().then(function(database) {
            return new Promise(function(resolve) {
                var tx = database.transaction(STORE_NAME, 'readonly');
                var store = tx.objectStore(STORE_NAME);
                var req = store.getAll();
                var records = [];
                req.onsuccess = function(e) { records = e.target.result || []; };
                req.onerror = function() { resolve({ count: 0, size: '0 MB', version: CACHE_VERSION }); };
                tx.oncomplete = function() {
                    var totalSize = 0;
                    for (var i = 0; i < records.length; i++) {
                        if (records[i].data && records[i].data.byteLength) {
                            totalSize += records[i].data.byteLength;
                        }
                    }
                    var sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
                    resolve({
                        count: records.length,
                        size: sizeMB + ' MB',
                        sizeBytes: totalSize,
                        version: CACHE_VERSION
                    });
                };
            });
        }).catch(function() {
            resolve({ count: 0, size: '0 MB', version: CACHE_VERSION });
        });
    }

    // 清除所有缓存模型
    function clearAll() {
        return openDB().then(function(database) {
            return new Promise(function(resolve, reject) {
                var tx = database.transaction(STORE_NAME, 'readwrite');
                var store = tx.objectStore(STORE_NAME);
                var req = store.clear();
                req.onsuccess = function() { resolve(true); };
                req.onerror = function(e) { reject(e.target.error); };
            });
        });
    }

    // 内存缓存：Map of url -> parsed gltf result（避免重复解析）
    var memoryCache = new Map();
    var MEMORY_CACHE_MAX = 3; // 最多保留 3 个模型在内存中

    function setMemoryCache(url, parsedResult) {
        // 容量满时淘汰最旧条目
        if (memoryCache.size >= MEMORY_CACHE_MAX) {
            var firstKey = memoryCache.keys().next().value;
            memoryCache.delete(firstKey);
        }
        memoryCache.set(url, parsedResult);
    }

    function getMemoryCache(url) {
        return memoryCache.get(url) || null;
    }

    function clearMemoryCache() {
        memoryCache.clear();
    }

    window.ModelCache = {
        saveModel: saveModel,
        loadModel: loadModel,
        hasModel: hasModel,
        removeModel: removeModel,
        getCacheInfo: getCacheInfo,
        clearAll: clearAll,
        setMemoryCache: setMemoryCache,
        getMemoryCache: getMemoryCache,
        clearMemoryCache: clearMemoryCache,
        CACHE_VERSION: CACHE_VERSION,
        CACHE_TTL: CACHE_TTL
    };
})();
