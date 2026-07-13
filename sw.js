// sw.js — Service Worker 缓存管理
// 修复循环刷新问题：不再使用查询参数版本号，版本通过 CACHE_NAME 控制

var CACHE_NAME = 'snapdragon-3d-v2';

// GitHub Pages 子路径自适应：自动检测部署路径前缀
// 例如 username.github.io/repo-name/ → 前缀为 /repo-name/
var BASE_PATH = self.registration ? self.registration.scope : '/';

// 将相对路径转换为基于 scope 的绝对路径
function resolveUrl(path) {
    if (path.startsWith('http')) return path;
    var scope = BASE_PATH.replace(/\/$/, '');
    return scope + path;
}

// 核心资源列表（使用相对路径，运行时转换为绝对路径）
var CORE_ASSETS_RELATIVE = [
    './',
    './index.html',
    './css/ui-base.css',
    './css/ui-actions.css',
    './css/ui-settings.css',
    './css/ui-responsive.css',
    './css/ui-backdrop.css',
    './css/ui-footer.css',
    './css/ui-header.css',
    './css/ui-joystick.css',
    './assets/libs/three.module.js',
    './assets/libs/jsm/loaders/GLTFLoader.js',
    './assets/libs/jsm/loaders/DRACOLoader.js',
    './assets/libs/jsm/utils/BufferGeometryUtils.js',
    './assets/libs/nipplejs.min.js',
    './assets/textures/skybox/skybox_px.jpg',
    './assets/textures/skybox/skybox_nx.jpg',
    './assets/textures/skybox/skybox_py.jpg',
    './assets/textures/skybox/skybox_ny.jpg',
    './assets/textures/skybox/skybox_pz.jpg',
    './assets/textures/skybox/skybox_nz.jpg',
    './assets/textures/hardwood2_diffuse.jpg',
    './app/app-loop.js',
    './app/app-loader.js',
    './app/app-state.js',
    './app/app-interact.js',
    './app/app-env.js',
    './app/app-utils.js',
    './engine/scene-camera.js',
    './engine/ik-controller.js',
    './engine/ik-adapter.js',
    './engine/ik-ccd.js',
    './engine/ik-debug.js',
    './engine/ik-foot-phase.js',
    './engine/ik-skeleton.js',
    './engine/physics-world.js',
    './engine/audio-system.js',
    './engine/movement-joystick.js',
    './engine/position-smooth.js',
    './core/character-module.js',
    './core/character-anim.js',
    './core/character-collider.js',
    './core/character-settings.js',
    './core/character-state.js',
    './ui/ui-dom.js',
    './ui/ui-config-panel.js',
    './ui/video-screen-shader.js',
    './utils/model-cache.js',
    './utils/task-scheduler.js',
    './utils/thermal-system.js',
    './utils/video-decode-bridge.js',
    './utils/opfs-cache.js',
    './utils/asset-parse-pool.js',
    './utils/gpu-upload-queue.js',
    './workers/model-parser.worker.js',
    './workers/collider-mesh.worker.js',
    './workers/video-reader.worker.js',
    './workers/video-decode-worker.js',
    './draco/draco_decoder.js',
    './draco/draco_decoder.wasm',
    './draco/draco_wasm_wrapper.js',
    './model/hongmao.glb',
    './model/pc.glb'
];

// 安装：预缓存核心资源（单个失败不影响整体）
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return Promise.allSettled(
                CORE_ASSETS_RELATIVE.map(function(relUrl) {
                    var url = resolveUrl(relUrl);
                    return cache.add(url).catch(function(e) {
                        console.warn('[SW] 缓存失败:', relUrl, e.message);
                    });
                })
            ).then(function() {
                console.log('[SW] 核心资源预缓存完成');
                // 立即激活，不等旧 SW 释放
                return self.skipWaiting();
            });
        })
    );
});

// 激活：清理旧版本缓存，立即接管页面
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(names) {
            return Promise.all(
                names.map(function(name) {
                    if (name !== CACHE_NAME) {
                        console.log('[SW] 清理旧缓存:', name);
                        return caches.delete(name);
                    }
                })
            );
        }).then(function() {
            console.log('[SW] 已激活，缓存版本:', CACHE_NAME);
            // 通知所有客户端 SW 已更新
            return self.clients.matchAll().then(function(clients) {
                clients.forEach(function(client) {
                    client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME });
                });
            }).then(function() {
                return self.clients.claim();
            });
        })
    );
});

// fetch 拦截：网络优先策略（避免缓存陈旧导致问题），网络失败时回退缓存
// 这比缓存优先策略更稳定，不会因为缓存未更新而导致循环刷新
self.addEventListener('fetch', function(event) {
    // 仅处理 GET 请求
    if (event.request.method !== 'GET') return;

    // 跳过跨域请求
    var url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    // 跳过 Range 请求（视频流等）
    if (event.request.headers.get('range')) return;

    // HTML 导航请求：网络优先（确保获取最新页面），失败时回退缓存
    var isNavigation = event.request.mode === 'navigate' ||
                       (event.request.headers.get('accept') || '').includes('text/html');

    if (isNavigation) {
        event.respondWith(
            fetch(event.request).then(function(networkResponse) {
                if (networkResponse && networkResponse.status === 200) {
                    var clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(function(cache) {
                        cache.put(event.request, clone);
                    });
                }
                return networkResponse;
            }).catch(function() {
                return caches.match(event.request).then(function(cached) {
                    return cached || caches.match(resolveUrl('./index.html'));
                });
            })
        );
        return;
    }

    // 静态资源：缓存优先（快速返回），缓存未命中时走网络并缓存
    event.respondWith(
        caches.match(event.request).then(function(cachedResponse) {
            if (cachedResponse) {
                // 后台静默更新缓存（不阻塞响应）
                fetch(event.request).then(function(networkResponse) {
                    if (networkResponse && networkResponse.status === 200) {
                        var clone = networkResponse.clone();
                        caches.open(CACHE_NAME).then(function(cache) {
                            cache.put(event.request, clone);
                        });
                    }
                }).catch(function() {});
                return cachedResponse;
            }

            // 缓存未命中：从网络获取
            return fetch(event.request).then(function(networkResponse) {
                if (!networkResponse || networkResponse.status !== 200) {
                    return networkResponse;
                }
                var responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(event.request, responseClone);
                });
                return networkResponse;
            }).catch(function() {
                // 网络失败且无缓存：返回空响应
                return new Response('', { status: 503, statusText: 'Offline' });
            });
        })
    );
});

// 接收主线程消息
self.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    if (event.data && event.data.type === 'CACHE_URL') {
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.add(event.data.url);
        }).then(function() {
            if (event.source) {
                event.source.postMessage({ type: 'CACHED', url: event.data.url });
            }
        });
    }
    // 手动清理全部缓存
    if (event.data && event.data.type === 'CLEAR_CACHE') {
        caches.keys().then(function(names) {
            return Promise.all(names.map(function(name) {
                return caches.delete(name);
            }));
        }).then(function() {
            if (event.source) {
                event.source.postMessage({ type: 'CACHE_CLEARED' });
            }
        });
    }
});
