// app-loader.js
// r170: GLTFLoader / DRACOLoader 通过 ESM 导入后挂载到 window 全局（THREE namespace 被冻结）
var _isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
var GLTFLoaderCtor = window.GLTFLoader || THREE.GLTFLoader;
if (typeof GLTFLoaderCtor === 'undefined') {
    updateStatus('❌ 网络加载失败：未找到 GLTFLoader');
    throw new Error("GLTFLoader is not defined. Check CDN loading order.");
}
loader = new GLTFLoaderCtor();

var DRACOLoaderCtor = window.DRACOLoader || THREE.DRACOLoader;
if (typeof DRACOLoaderCtor !== 'undefined') {
    var dracoLoader = new DRACOLoaderCtor();
    dracoLoader.setDecoderPath('./draco/');
    loader.setDRACOLoader(dracoLoader);
    console.log('✅ DRACO 压缩解码器已启用 (依赖本地 /draco/ 文件夹)');
} else {
    console.warn('⚠️ 未检测到 DRACOLoader，压缩模型可能无法加载，请检查 HTML 引入');
}

// ==========================================================
// 【核心修复】：补充缺失的 initCameras 定义
// ==========================================================
function initCameras() {
    if (!model) return;
    thirdPersonCam = new cameraModule.ThirdPersonCamera(camera, renderer, model, {
        moveSpeed: 1.8,
        rotateSpeed: 0.006,
        offsetY: 3.2,
        offsetZ: 3.2,
        lerpFactor: 0.15,
        runShakeAmplitude: 0.005,
        runShakeFrequency: 1.2
    });
    firstPersonCam = new cameraModule.FirstPersonCamera(camera, renderer, model, {
        moveSpeed: 1.8,
        rotateSpeed: 0.006,
        runShakeAmplitude: 0.005,
        runShakeFrequency: 1.2
    });
    isThirdPerson = true;
    activeCamera = thirdPersonCam;
    console.log('✅ 独立相机系统已初始化 (当前模式: 第三人称)');
}

// ==========================================================
// 流式场景物体加载：统一走 worker 下载，分阶段渲染
// ==========================================================
var sceneObjectMap = {};
var sceneObjectCounter = 0;

function loadSceneObject(url, position, scale, opts) {
    opts = opts || {};
    var token = 'scene_' + (++sceneObjectCounter);
    // 将相对 URL 转为绝对 URL（Worker 会相对于自身路径解析 fetch URL）
    if (url.indexOf('http') !== 0) {
        url = new URL(url, location.href).href;
    }
    sceneObjectMap[token] = { url: url, position: position, scale: scale, opts: opts };
    modelLoaderWorker.postMessage({ type: 'loadURL', url: url, token: token });
}

function handleSceneObjectBuffer(info, arrayBuffer, fileName) {
    var position = info.position;
    var scale = info.scale;
    var opts = info.opts;
    updateStatus('⏳ 正在解析场景物体: ' + fileName);
    loader.parse(arrayBuffer, '', function(gltf) {
        var objModel = gltf.scene;
        objModel.position.copy(position);
        objModel.scale.set(scale, scale, scale);
        objModel.updateMatrixWorld(true);

        // Auto placement: compute bounding box and adjust Y so model sits on ground
        if (opts.autoPlace !== false) {
            var box = new THREE.Box3().setFromObject(objModel);
            var minY = box.min.y;
            var groundClearance = opts.groundClearance !== undefined ? opts.groundClearance : 0.02;
            objModel.position.y += -minY + groundClearance;
            objModel.updateMatrixWorld(true);
        } else if (opts.positionYOffset) {
            objModel.position.y += opts.positionYOffset;
        }

        // Enable shadows
        objModel.traverse(function(child) {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                child.frustumCulled = false;
            }
        });

        scene.add(objModel);

        // 性能优化：PC 模型禁用原始子 mesh 的 raycast，避免 IK 射线检测遍历高面数网格
        var isPC = (typeof fileName === 'string' && fileName.indexOf('pc.glb') !== -1) || (info && info.url && info.url.indexOf('pc.glb') !== -1);
        if (isPC) {
            objModel.traverse(function(child) {
                if (child.isMesh && child.name !== 'Ultrawide_Monitor_Screen_0') {
                    child.userData.isPCChild = true;
                    child.raycast = function() {};
                }
            });
        }

        // Cache screen mesh for video texture if this is the pc model
        if (isPC) {
            objModel.traverse(function(child) {
                if (child.isMesh && child.name === 'Ultrawide_Monitor_Screen_0') {
                    window.pcScreenMesh = child;
                    console.log('✅ 已定位屏幕部件: Ultrawide_Monitor_Screen_0');
                }
            });
        }

        // 为该场景物体创建 3D 空间音源（以绿色碰撞体为参考）
        if (window.AudioSystem && AudioSystem.setListener) {
            var _sceneRef = null;
            objModel.traverse(function(child) {
                if (child.isMesh && !_sceneRef) {
                    var box = new THREE.Box3().setFromObject(child);
                    var center = new THREE.Vector3();
                    box.getCenter(center);
                    _sceneRef = {
                        position: center,
                        objModel: objModel
                    };
                }
            });
            if (!_sceneRef) {
                var pos = objModel.position;
                _sceneRef = {
                    position: new THREE.Vector3(pos.x, pos.y, pos.z),
                    objModel: objModel
                };
            }
            if (_sceneRef) {
                objModel.userData.audioRef = _sceneRef;
            }
        }

        // Defer heavy collider work to avoid main-thread stall
        setTimeout(function() {
            var colliderVerts = [];
            var colliderIndices = [];
            var indexOffset = 0;
            var meshCount = 0;
            objModel.traverse(function(child) {
                if (child.isMesh && child.geometry) {
                    meshCount++;
                    var geo = child.geometry;
                    child.updateMatrixWorld(true);
                    var mat4 = child.matrixWorld;

                    var posAttr = geo.attributes.position;
                    var idxArr = geo.index ? geo.index.array : null;
                    var vertexCount = posAttr ? posAttr.count : 0;

                    if (vertexCount > 2000 && opts.simplify) {
                        var triCount = idxArr ? Math.floor(idxArr.length / 3) : Math.floor(vertexCount / 3);
                        var step = Math.max(1, Math.floor(triCount / 1200));

                        if (idxArr) {
                            for (var t = 0; t < triCount; t += step) {
                                var i3 = t * 3;
                                var a = idxArr[i3];
                                var b = idxArr[i3 + 1];
                                var c = idxArr[i3 + 2];
                                if (a === undefined || b === undefined || c === undefined) continue;
                                var vax = posAttr.getX(a), vay = posAttr.getY(a), vaz = posAttr.getZ(a);
                                var vbx = posAttr.getX(b), vby = posAttr.getY(b), vbz = posAttr.getZ(b);
                                var vcx = posAttr.getX(c), vcy = posAttr.getY(c), vcz = posAttr.getZ(c);
                                var va = new THREE.Vector3(vax, vay, vaz).applyMatrix4(mat4);
                                var vb = new THREE.Vector3(vbx, vby, vbz).applyMatrix4(mat4);
                                var vc = new THREE.Vector3(vcx, vcy, vcz).applyMatrix4(mat4);
                                colliderVerts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
                                colliderIndices.push(indexOffset, indexOffset + 1, indexOffset + 2);
                                indexOffset += 3;
                            }
                        } else if (posAttr) {
                            var arr = posAttr.array;
                            for (var t = 0; t < triCount; t += step) {
                                var i3 = t * 3;
                                var v0 = new THREE.Vector3(arr[i3 * 3], arr[i3 * 3 + 1], arr[i3 * 3 + 2]).applyMatrix4(mat4);
                                var v1 = new THREE.Vector3(arr[(i3+1) * 3], arr[(i3+1) * 3 + 1], arr[(i3+1) * 3 + 2]).applyMatrix4(mat4);
                                var v2 = new THREE.Vector3(arr[(i3+2) * 3], arr[(i3+2) * 3 + 1], arr[(i3+2) * 3 + 2]).applyMatrix4(mat4);
                                colliderVerts.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
                                colliderIndices.push(indexOffset, indexOffset + 1, indexOffset + 2);
                                indexOffset += 3;
                            }
                        }
                    } else if (posAttr) {
                        var posArr = posAttr.array;
                        for (var v = 0; v < posArr.length; v += 3) {
                            var v3 = new THREE.Vector3(posArr[v], posArr[v+1], posArr[v+2]);
                            v3.applyMatrix4(mat4);
                            colliderVerts.push(v3.x, v3.y, v3.z);
                        }
                        if (idxArr) {
                            for (var i = 0; i < idxArr.length; i++) {
                                colliderIndices.push(idxArr[i] + indexOffset);
                            }
                            indexOffset += vertexCount;
                        } else {
                            var count = vertexCount;
                            for (var i = 0; i < count; i += 3) {
                                colliderIndices.push(i + indexOffset, i+1 + indexOffset, i+2 + indexOffset);
                            }
                            indexOffset += count;
                        }
                    }
                }
            });

            // 创建物理碰撞体（不再创建绿色线框可视化）
            if (colliderVerts.length >= 9) {
                if (physicsModule.createConvexHullCollider) {
                    var collider = physicsModule.createConvexHullCollider(colliderVerts, colliderIndices);
                    if (collider) {
                        console.log('✅ 场景物体 "' + fileName + '" 物理碰撞体已创建 (' + (colliderVerts.length / 3) + ' 顶点, ' + (colliderIndices.length / 3) + ' 三角面)');
                    }
                }
            }
        }, opts.wireframeDelay || 0);
        console.log('✅ 场景物体已加载: ' + fileName);

        // 性能优化：为 PC 模型创建简化盒子碰撞体，替代高面数原始 mesh 参与 IK 射线检测
        if (isPC) {
            var pcBox = new THREE.Box3().setFromObject(objModel);
            var pcSize = new THREE.Vector3();
            pcBox.getSize(pcSize);
            var pcCenter = new THREE.Vector3();
            pcBox.getCenter(pcCenter);
            var pcColliderGeo = new THREE.BoxGeometry(pcSize.x, pcSize.y, pcSize.z);
            var pcColliderMat = new THREE.MeshBasicMaterial({ visible: false, depthWrite: false, depthTest: false });
            var pcCollider = new THREE.Mesh(pcColliderGeo, pcColliderMat);
            pcCollider.position.copy(pcCenter);
            pcCollider.userData.isPCIKCollider = true;
            scene.add(pcCollider);
            window.pcIKCollider = pcCollider;
            console.log('✅ PC 简化碰撞体已创建 (' + pcSize.x.toFixed(2) + ' x ' + pcSize.y.toFixed(2) + ' x ' + pcSize.z.toFixed(2) + ')');
        }

        // 刷新 IK 碰撞体列表
        if (window.legIKModule) legIKModule.refreshColliders();

        // Sync screen video mesh after pc model is ready
        if (fileName === 'pc.glb' || (info && info.url && info.url.indexOf('pc.glb') !== -1)) {
            setTimeout(syncScreenVideoMesh, 0);
        }
    }, undefined, function(err) {
        console.warn('⚠️ 场景物体加载失败:', fileName, err);
    });
}

// ==========================================================
// 场景物体加载已统一改为 worker 流式加载，见上方 loadSceneObject() + handleSceneObjectBuffer()

// ==========================================================

modelLoaderWorker.onmessage = function(e) {
    var data = e.data;
    if (data.type === 'error') {
        if (data.token && sceneObjectMap[data.token]) {
            var sceneInfo = sceneObjectMap[data.token];
            delete sceneObjectMap[data.token];
            console.warn('⚠️ 场景物体加载失败:', sceneInfo.url, data.message);
            return;
        }
        updateStatus('❌ ' + data.message);
        isLoading = false;
        isBuildingCollider = false;
        DOM.overlay.classList.add('loading-hidden');
        return;
    }
    if (data.type === 'arrayBuffer') {
        if (data.token && sceneObjectMap[data.token]) {
            var sceneInfo = sceneObjectMap[data.token];
            delete sceneObjectMap[data.token];
            handleSceneObjectBuffer(sceneInfo, data.buffer, data.fileName);
            return;
        }
        var arrayBuffer = data.buffer;
        DOM.fileLabel.textContent = data.fileName;
        updateStatus('⏳ 正在解析 GLTF 场景...');

        var cacheUrl = data.url || data.fileName || 'unknown';

        // 后台异步缓存到 IndexedDB（不阻塞当前加载）
        if (window.ModelCache && arrayBuffer.byteLength > 0) {
            window.ModelCache.saveModel(cacheUrl, arrayBuffer.slice(0), { name: data.fileName }).catch(function() {});
        }

        // 直接解析 GLTF（原 Worker 池+OPFS 中间层反而增加了串行等待，已移除）
        // OPFS/Worker 池模块仍保留加载，供未来深度集成使用
        loader.parse(arrayBuffer, '', onModelLoaded, function(err) {
            console.error(err);
            updateStatus('❌ 加载失败: ' + (err.message || '解析错误'));
            isLoading = false;
            isBuildingCollider = false;
            DOM.overlay.classList.add('loading-hidden');
        });
    }
};

var _wireSimplifier = null;

function createWireSimplifier(worldVerts, indices, maxVerts) {
    var triCount = Math.floor(indices.length / 3);
    var step = Math.max(1, Math.floor(triCount / maxVerts));
    var vertMap = {};
    var keptVerts = [];
    var keptIndices = [];
    var orderedKeys = [];

    for (var t = 0; t < triCount; t += step) {
        var i3 = t * 3;
        var a = indices[i3];
        var b = indices[i3 + 1];
        var c = indices[i3 + 2];
        if (a === undefined || b === undefined || c === undefined) continue;
        var origs = [a, b, c];
        var newIdxs = [];
        for (var i = 0; i < 3; i++) {
            var origIdx = origs[i];
            if (vertMap[origIdx] === undefined) {
                vertMap[origIdx] = keptVerts.length / 3;
                orderedKeys.push(origIdx);
                keptVerts.push(
                    worldVerts[origIdx * 3],
                    worldVerts[origIdx * 3 + 1],
                    worldVerts[origIdx * 3 + 2]
                );
            }
            newIdxs.push(vertMap[origIdx]);
        }
        keptIndices.push(newIdxs[0], newIdxs[1], newIdxs[2]);
    }
    return {
        vertMap: vertMap,
        orderedKeys: orderedKeys,
        keptIndices: keptIndices,
        simplify: function(srcVerts) {
            var out = [];
            for (var k = 0; k < orderedKeys.length; k++) {
                var origIdx = orderedKeys[k];
                out.push(srcVerts[origIdx * 3], srcVerts[origIdx * 3 + 1], srcVerts[origIdx * 3 + 2]);
            }
            return out;
        }
    };
}

core.onModelLoadedCallback(function(worldVerts, indices) {
    if (_loadFrameId) { cancelAnimationFrame(_loadFrameId); _loadFrameId = null; }
    if (isBuildingCollider) {
        if (colliderVisual) scene.remove(colliderVisual);
        _wireSimplifier = createWireSimplifier(worldVerts, indices, 300);
        var simpleVerts = _wireSimplifier.simplify(worldVerts);
        var visGeo = new THREE.BufferGeometry();
        visGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(simpleVerts), 3));
        visGeo.setIndex(_wireSimplifier.keptIndices);
        var visMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5, depthWrite: false, depthTest: true });
        _loadFrameId = requestAnimationFrame(function() {
            colliderVisual = new THREE.Mesh(visGeo, visMat);
            colliderVisual.visible = showCollider;
            colliderVisual.raycast = function() {};
            colliderVisual.frustumCulled = false;
            colliderVisual.renderOrder = 999;
            scene.add(colliderVisual);
            _loadFrameId = requestAnimationFrame(function() {
                syncColliderShape();
                isLoading = false; isBuildingCollider = false;
                DOM.overlay.classList.add('loading-hidden');
                if (!physicsMode && DOM.togglePhysicsBtn) { DOM.togglePhysicsBtn.click(); }
                // 恢复渲染循环（文件上传时暂停的）
                window._isPaused = false;
                if (clock.getDelta) clock.getDelta();
                window._lastFrameTime = 0;
                updateStatus('✅ 已就绪');
                _loadFrameId = null;
            });
        });
    } else {
        if (_wireSimplifier && colliderVisual) {
            var simpleVerts = _wireSimplifier.simplify(worldVerts);
            var posAttr = colliderVisual.geometry.attributes.position;
            if (posAttr && posAttr.count * 3 === simpleVerts.length) {
                posAttr.copyArray(new Float32Array(simpleVerts));
                posAttr.needsUpdate = true;
            }
        }
    }
});

function loadLocalFile(file) {
    if (!file) return;
    core.setDefaultModel(false);
    DOM.fileLabel.textContent = file.name + ' (加载中...)';
    isLoading = true; isBuildingCollider = true;
    DOM.overlay.classList.remove('loading-hidden');
    updateStatus('⏳ Worker 后台读取文件...');
    // 暂停渲染循环，避免文件读取期间 GPU 空转
    window._isPaused = true;
    // 使用 TaskScheduler 的高优先级调度文件读取（不阻塞 UI 响应）
    if (window.TaskScheduler) {
        TaskScheduler.postTask(function() {
            modelLoaderWorker.postMessage({ type: 'loadLocalFile', file: file });
        }, TaskScheduler.PRIORITY.BLOCKING);
    } else {
        setTimeout(function() {
            modelLoaderWorker.postMessage({ type: 'loadLocalFile', file: file });
        }, 50);
    }
}

function loadDefaultModel() {
    var path = 'model/hongmao.glb';
    var absPath = new URL(path, location.href).href;
    if (model !== null || isLoading) return;
    core.setDefaultModel(true);
    isLoading = true; isBuildingCollider = true;
    DOM.overlay.classList.remove('loading-hidden');

    // ===== 预加载场景物体：与主模型并行下载（不等待主模型完成）=====
    loadSceneObject('model/door_arch.glb', new THREE.Vector3(0, 0, -8), 1.5, {
        autoPlace: true, groundClearance: 0.02
    });
    loadSceneObject('model/pc.glb', new THREE.Vector3(5, 0, -6), 0.4, {
        autoPlace: true, groundClearance: 0.02, simplify: true, wireframeDelay: 120
    });

    // 主模型下载：IndexedDB 缓存命中则跳过 Worker
    if (window.ModelCache) {
        window.ModelCache.loadModel(path).then(function(cached) {
            if (cached && cached.data) {
                updateStatus('⏳ 从缓存加载模型...');
                loader.parse(cached.data, '', onModelLoaded, function(err) {
                    console.warn('[Cache] 缓存解析失败，回退到网络下载:', err);
                    updateStatus('⏳ Worker 后台下载模型...');
                    modelLoaderWorker.postMessage({ type: 'loadURL', url: absPath });
                });
                return;
            }
            updateStatus('⏳ Worker 后台下载模型...');
            modelLoaderWorker.postMessage({ type: 'loadURL', url: absPath });
        }).catch(function() {
            updateStatus('⏳ Worker 后台下载模型...');
            modelLoaderWorker.postMessage({ type: 'loadURL', url: absPath });
        });
    } else {
        updateStatus('⏳ Worker 后台下载模型...');
        modelLoaderWorker.postMessage({ type: 'loadURL', url: absPath });
    }
}

function onModelLoaded(gltf) {
    // 销毁旧 IK 实例，避免骨骼状态残留
    if (window.legIKModule) legIKModule.destroy();
    // 【修复】重新加载模型时保留当前世界位置，避免位置被重置
    var prevWorldPos = (model && model.position) ? model.position.clone() : new THREE.Vector3(0, 0.6, 3);
    if (model) {
        // Dispose 协议：使用 IdleTaskManager 在空闲时递归释放，避免阻塞首帧
        var _oldModel = model;
        var _oldCollider = colliderVisual;
        if (window.ThermalSystem && ThermalSystem.idle) {
            // 异步释放：不阻塞当前帧
            ThermalSystem.idle.schedule(function() {
                _oldModel.traverse(function(child) {
                    if (child.isMesh) {
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) {
                            var mats = Array.isArray(child.material) ? child.material : [child.material];
                            mats.forEach(function(m) {
                                for (var key in m) {
                                    if (m[key] && m[key].isTexture) m[key].dispose();
                                }
                                m.dispose();
                            });
                        }
                    }
                });
                if (_oldCollider && _oldCollider.geometry) _oldCollider.geometry.dispose();
                console.log('[IdleTask] 旧模型资源已释放');
            }, 'low');
        } else {
            // 降级：同步释放
            _oldModel.traverse(function(child) {
                if (child.isMesh) {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) {
                        var mats = Array.isArray(child.material) ? child.material : [child.material];
                        mats.forEach(function(m) {
                            for (var key in m) {
                                if (m[key] && m[key].isTexture) m[key].dispose();
                            }
                            m.dispose();
                        });
                    }
                }
            });
            if (_oldCollider && _oldCollider.geometry) _oldCollider.geometry.dispose();
        }
        scene.remove(_oldModel);
        if (_oldCollider) scene.remove(_oldCollider);
        modelMaterials = [];
        if (mixer) mixer.stopAllAction();
    }
    
    // 【Ammo 清理】：清除场景中所有旧的动态刚体
    if (physicsModule.clearDynamicBodies) { physicsModule.clearDynamicBodies(); }

    // 【核心修改】: 遍历清理旧物理物体时，只删除默认创建的方块，保留用户生成的物体！
    for (var old = physicsObjects.length - 1; old >= 0; old--) {
        var obj = physicsObjects[old];
        if (obj.userGenerated) {
            continue;
        }
        // 清理对应 Ammo 刚体
        if (physicsModule.removeRigidBody) { physicsModule.removeRigidBody(obj); }
        scene.remove(obj.mesh);
        physicsObjects.splice(old, 1);
    }

    model = gltf.scene;
    var box = new THREE.Box3().setFromObject(model);
    var size = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());
    var halfHeight = size.y / 2;
    var bottomY = center.y - halfHeight;
    model.position.set(-center.x, -bottomY, -center.z);
    // 【修复】恢复之前的世界位置，避免重新加载模型时位置被重置
    model.position.copy(prevWorldPos);
    model.rotation.y = Math.PI;
    model.updateMatrixWorld(true);
    model.traverse(function(child) {
        if (child.isMesh) {
            child.castShadow = true; child.receiveShadow = true; child.frustumCulled = false;
            // 保留 MeshStandardMaterial（降级到 Phong 会导致画面扁平/模糊）
            // 为模型纹理启用各向异性过滤
            if (child.material) {
                var mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach(function(mat) {
                    for (var key in mat) {
                        if (mat[key] && mat[key].isTexture) {
                            mat[key].anisotropy = renderer.capabilities.getMaxAnisotropy();
                        }
                    }
                });
            }
            if (Array.isArray(child.material)) { for (var m = 0; m < child.material.length; m++) { modelMaterials.push(child.material[m]); } } else { modelMaterials.push(child.material); }
        }
    });
    scene.add(model);
    var collider = initPlayerCollider(0.35);
    body = collider.body; sphereShape = collider.shape;
    // Set initial player position (works for both placeholder and Ammo body)
    if (physicsModule.setPlayerPosition) {
        physicsModule.setPlayerPosition(model.position.x, model.position.y, model.position.z);
    } else if (body.position) {
        body.position.x = model.position.x;
        body.position.y = model.position.y;
        body.position.z = model.position.z;
    }

    // 初始化 Ammo 物理世界并创建/替换玩家碰撞体
    if (physicsModule.init) {
        physicsModule.init(function() {
            // Ammo 就绪后创建玩家碰撞体（替换占位 body）
            var pc = physicsModule.initPlayerCollider(0.35);
            if (pc.body && pc.body.getMotionState) {
                // 用真正的 Ammo 刚体替换占位 body
                // 先移除旧的玩家碰撞体（如果有）
                if (body && body !== pc.body && physicsModule.removePlayerBody) {
                    physicsModule.removePlayerBody(body);
                }
                body = pc.body;
                sphereShape = pc.shape;
                // 确保玩家刚体在正确初始位置
                physicsModule.setPlayerPosition(model.position.x, model.position.y, model.position.z);
                body.setActivationState(4); // 唤醒
            }
            console.log('✅ Ammo 玩家碰撞体已就绪');
        });
    }

    var colors = [0xff6b6b, 0x4ecdc4, 0x45b7d1, 0xf9ca24, 0xa29bfe, 0xfd79a8];

    // ==================== 场景布局 ====================
    // 延迟到下一帧构建场景物理物体，避免阻塞首帧渲染
    // 玩家初始位置 (0, 0.6, 3)，面朝 -Z 方向
    setTimeout(function buildSceneLayout() {
        var COL = {
            stair: 0x8E8E93,    // 灰色楼梯
            plat:  0x636366,    // 深灰平台
            wall:  0x48484A,    // 深灰墙
            step:  0xD4A574,    // 木色台阶
            stone: 0x8E8E93,   // 石块
            pillar:0x3A3A3C,   // 柱子
            ramp:  0x8E8E93   // 斜坡
        };

        // ----- 右侧斜坡（玩家初始位置右边的斜坡）-----
        // 从地面 (y=0) 平滑过渡到平台 (y=0.8)
        // 斜坡宽 2.4m，厚 0.2m，长 3.0m
        // 旋转角度：使斜面从 y=0 升到 y=0.8
        var rampHeight = 0.8;
        var rampLen = 3.0;
        var rampAngle = Math.atan2(rampHeight, rampLen); // 斜角
        var rampThick = 0.15;
        // 斜坡中心位置：右侧 x=3.5，z=1（玩家右前方）
        // 斜坡底端在 z=2.5（靠近玩家），顶端在 z=-0.5（连接平台）
        var rampCenterZ = (2.5 + (-0.5)) / 2; // = 1.0
        var rampCenterY = rampHeight / 2;     // 斜坡中心高度
        if (physicsModule.createRamp) {
            var ramp = physicsModule.createRamp(2.4, rampThick, rampLen, -rampAngle,
                new THREE.Vector3(3.5, rampCenterY, rampCenterZ), COL.ramp);
            scene.add(ramp.mesh);
            physicsObjects.push(ramp);
            console.log('✅ 右侧斜坡已创建 (角度:' + (rampAngle * 180 / Math.PI).toFixed(1) + '°)');
        }

        // 斜坡顶端连接的平台
        var rampTopPlat = createPhysicsObject(
            new THREE.BoxGeometry(3.0, 0.15, 2.0),
            new THREE.Vector3(3.5, rampHeight - 0.075, -1.5),
            1, COL.plat, 0, true
        );
        scene.add(rampTopPlat.mesh); physicsObjects.push(rampTopPlat);

        // 平台护栏
        var railF = createPhysicsObject(new THREE.BoxGeometry(3.0, 0.5, 0.1), new THREE.Vector3(3.5, rampHeight + 0.3, -2.5), 1, COL.wall, 0, false);
        scene.add(railF.mesh); physicsObjects.push(railF);
        var railR = createPhysicsObject(new THREE.BoxGeometry(0.1, 0.5, 2.0), new THREE.Vector3(5.0, rampHeight + 0.3, -1.5), 1, COL.wall, 0, false);
        scene.add(railR.mesh); physicsObjects.push(railR);

        // ----- 左侧楼梯（12级，更高更陡）-----
        var stairCount = 12;
        var stairW = 1.8, stairD = 0.32, stairH = 0.22;
        var sX = -5, sZ = 0;
        for (var i = 0; i < stairCount; i++) {
            var sGeo = new THREE.BoxGeometry(stairW, stairH, stairD);
            var sPos = new THREE.Vector3(sX, i * stairH + stairH * 0.5, sZ - i * stairD);
            var sObj = createPhysicsObject(sGeo, sPos, 1, COL.stair, 0, true);
            scene.add(sObj.mesh); physicsObjects.push(sObj);
        }
        // 楼梯顶部平台
        var sTopY = stairCount * stairH;
        var sTopPlat = createPhysicsObject(
            new THREE.BoxGeometry(3.5, 0.15, 2.5),
            new THREE.Vector3(sX, sTopY - 0.075, sZ - stairCount * stairD - 1.0),
            1, COL.plat, 0, true
        );
        scene.add(sTopPlat.mesh); physicsObjects.push(sTopPlat);
        // 平台护栏
        var sRail = createPhysicsObject(new THREE.BoxGeometry(3.5, 0.5, 0.1), new THREE.Vector3(sX, sTopY + 0.3, sZ - stairCount * stairD - 2.2), 1, COL.wall, 0, false);
        scene.add(sRail.mesh); physicsObjects.push(sRail);
        var sRail2 = createPhysicsObject(new THREE.BoxGeometry(0.1, 0.5, 2.5), new THREE.Vector3(sX - 1.8, sTopY + 0.3, sZ - stairCount * stairD - 1.0), 1, COL.wall, 0, false);
        scene.add(sRail2.mesh); physicsObjects.push(sRail2);
        var sRail3 = createPhysicsObject(new THREE.BoxGeometry(0.1, 0.5, 2.5), new THREE.Vector3(sX + 1.8, sTopY + 0.3, sZ - stairCount * stairD - 1.0), 1, COL.wall, 0, false);
        scene.add(sRail3.mesh); physicsObjects.push(sRail3);

        // ----- 正前方台阶小径（4级，从低到高）-----
        var steps = [
            { x: 0.0, z: -6.0, h: 0.15 },
            { x: 0.0, z: -5.2, h: 0.25 },
            { x: 0.0, z: -4.4, h: 0.35 },
            { x: 0.0, z: -3.6, h: 0.45 }
        ];
        for (var s = 0; s < steps.length; s++) {
            var st = steps[s];
            var stObj = createPhysicsObject(new THREE.BoxGeometry(1.4, st.h, 0.55), new THREE.Vector3(st.x, st.h * 0.5, st.z), 1, COL.step, 0, true);
            scene.add(stObj.mesh); physicsObjects.push(stObj);
        }

        // ----- 装饰柱子（4根）-----
        var pillars = [
            { x: -3, z: 3 }, { x: 3, z: 3 },
            { x: -3, z: -5 }, { x: 3, z: -5 }
        ];
        for (var p = 0; p < pillars.length; p++) {
            var pl = pillars[p];
            var pGeo = new THREE.BoxGeometry(0.35, 1.8, 0.35);
            var pObj = createPhysicsObject(pGeo, new THREE.Vector3(pl.x, 0.9, pl.z), 1, COL.pillar, 0, false);
            scene.add(pObj.mesh); physicsObjects.push(pObj);
        }

        // ----- 边界墙 -----
        var backWall = createPhysicsObject(new THREE.BoxGeometry(14, 1.5, 0.25), new THREE.Vector3(0, 0.75, -8), 1, COL.wall, 0, false);
        scene.add(backWall.mesh); physicsObjects.push(backWall);
        var leftWall = createPhysicsObject(new THREE.BoxGeometry(0.25, 1.0, 10), new THREE.Vector3(-7.5, 0.5, -1), 1, COL.wall, 0, false);
        scene.add(leftWall.mesh); physicsObjects.push(leftWall);
        var rightWall = createPhysicsObject(new THREE.BoxGeometry(0.25, 1.0, 12), new THREE.Vector3(7.5, 0.5, -2), 1, COL.wall, 0, false);
        scene.add(rightWall.mesh); physicsObjects.push(rightWall);

        // ----- 散落石块（自然分布，不遮挡主路径）-----
        var stones = [
            { x: -1.5, z: 2.0, w: 0.5, h: 0.3, d: 0.5 },
            { x: 1.5, z: 2.0, w: 0.4, h: 0.35, d: 0.4 },
            { x: -4, z: -3, w: 0.6, h: 0.25, d: 0.5 },
            { x: -5.5, z: 3, w: 0.45, h: 0.4, d: 0.45 },
            { x: 2.0, z: -2.5, w: 0.5, h: 0.2, d: 0.4 }
        ];
        for (var st2 = 0; st2 < stones.length; st2++) {
            var sn = stones[st2];
            var snObj = createPhysicsObject(new THREE.BoxGeometry(sn.w, sn.h, sn.d), new THREE.Vector3(sn.x, sn.h * 0.5, sn.z), 1, COL.stone, 0, false);
            scene.add(snObj.mesh); physicsObjects.push(snObj);
        }

        // ----- 出生点附近的测试台阶 -----
        var testSteps = [
            { x: -0.8, z: 1.5, h: 0.15 },
            { x: 0.8, z: 1.5, h: 0.15 }
        ];
        for (var ts = 0; ts < testSteps.length; ts++) {
            var tsp = testSteps[ts];
            var tsObj = createPhysicsObject(new THREE.BoxGeometry(0.9, tsp.h, 0.45), new THREE.Vector3(tsp.x, tsp.h * 0.5, tsp.z), 1, COL.step, 0, true);
            scene.add(tsObj.mesh); physicsObjects.push(tsObj);
        }

        console.log('✅ 场景布局构建完成（含斜坡+楼梯+台阶+柱子+石块）');

        // 通知 IK 系统刷新碰撞体列表，让脚部射线能命中新创建的楼梯/台阶/石块
        if (window.legIKModule && legIKModule.refreshColliders) {
            legIKModule.refreshColliders();
            console.log('[IK] 碰撞体列表已刷新（含场景布局物体）');
        }
    }, 0);

    var actionsTemp = [];
    if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        for (var an = 0; an < gltf.animations.length; an++) { actionsTemp.push(mixer.clipAction(gltf.animations[an])); }
        var names = [];
        for (var n = 0; n < actionsTemp.length; n++) { names.push(actionsTemp[n]._clip.name || '动画 ' + (n + 1)); }
        updateAnimPicker(names, 0);
        DOM.pickerWrapper.style.display = 'block';
        var idleIdx = 0;
        for (var id = 0; id < actionsTemp.length; id++) {
            if ((actionsTemp[id]._clip.name || '').toLowerCase().includes('idle')) { idleIdx = id; }
        }
        core.setIdleAnimIndex(idleIdx);
        core.setModelAndMixer(model, mixer, actionsTemp);
        core.setupMixerLoopListener();
        actions = actionsTemp;
        // Set callback for animation picker clicks
        window.__playAnimCallback = function(index) {
            if (index >= 0 && index < actions.length) {
                core.playAnimation(index);
                core.setIsJoystickControlled(false);
            }
        };
        core.loadSettings();
        uiConfigModule.initConfigUI(core, actions, actionKeys);
        positionCorrectModule.initCorrectSystem(core, actions, model, actionKeys);
        core.playAnimation(idleIdx);
        // 初始化脚部 IK 系统
        if (window.legIKModule) {
            legIKModule.init();
            legIKModule.createIKControls();
        }
    } else {
        actions = actionsTemp; mixer = null;
        DOM.selectedName.textContent = '无动画';
        DOM.listContainer.innerHTML = '';
        DOM.pickerWrapper.style.display = 'none';
        updateStatus('⚠️ 无动画');
        DOM.playIcon.style.display = 'none';
        DOM.pauseIcon.style.display = 'none';
    }
    isBuildingCollider = true;
    updateStatus('⏳ Worker 后台构建碰撞体...');
    core.prepareColliderData(model);
    initCameras();
    // Apply kuchiki-specific FP yaw offset for default model
    if (core.isDefaultModel() && firstPersonCam) {
        firstPersonCam.yaw = 0.15;
    }

    // 场景物体已在 loadDefaultModel 中并行预加载，此处不再重复调用
}

// ===== Screen Video Wiring =====
function initScreenVideoSystem() {
    if (!window.uiModule || !uiModule.screenVideoState) return;
    var state = uiModule.screenVideoState;
    var ui = uiModule.DOM;

    // 初始化视频 Worker，将文件读取移到后台线程
    if (uiModule.initVideoWorker) {
        uiModule.initVideoWorker();
    }

    if (ui.toggleScreenBtn) {
        ui.toggleScreenBtn.addEventListener('click', function() {
            uiModule.openScreenVideoPicker();
        });
    }

    // 滤镜按钮 → 打开滤镜面板
    var filterBtn = document.getElementById('toggle-filter');
    if (filterBtn) {
        filterBtn.addEventListener('click', function() {
            uiModule.toggleFilterOverlay(true);
        });
    }

    // 映射按钮 → 打开映射面板（与摇杆齿轮按钮功能相同）
    var mappingBtn = document.getElementById('toggle-mapping');
    if (mappingBtn) {
        mappingBtn.addEventListener('click', function() {
            uiModule.toggleSettingsOverlay(true);
        });
    }

    // 初始化滤镜面板交互
    if (uiModule.initFilterPanel) {
        uiModule.initFilterPanel();
    }

    // screenVideoInput 已改为惰性创建，无需在此绑定 change 事件
    // change 事件在 getOrCreateVideoInput() 中动态绑定时已处理
}

function syncScreenVideoMesh() {
    if (!window.uiModule || !uiModule.screenVideoState) return;
    if (window.pcScreenMesh) {
        uiModule.screenVideoState.mesh = window.pcScreenMesh;
        if (uiModule.screenVideoState.active && uiModule.screenVideoState.texture) {
            uiModule.applyScreenVideoTexture();
        }
    }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initScreenVideoSystem();
} else {
    document.addEventListener('DOMContentLoaded', initScreenVideoSystem);
}