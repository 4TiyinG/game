// physics-world.js — Ammo.js 物理引擎封装
(function() {
    // ===== Ammo 物理世界 =====
    var world = null;
    var btTransform = null;
    var ready = false;
    var readyCallbacks = [];
    var rigidBodies = []; // { mesh, body } 所有动态刚体
    var pendingStatics = []; // Ammo 就绪前缓存的静态物体 [{ geometry, pos, scale, mesh, isWalkable }]
    var pendingWalkables = []; // Ammo 就绪前缓存的行走面 [mesh]
    var pendingColliders = []; // Ammo 就绪前缓存的三角网格碰撞体 [{ verts, indices }]
    var playerBody = null;
    var playerRadius = 0.4;
    var playerHeight = 1.6;
    var onHitCallback = null;
    var gravity = -15.0;

    // ===== 初始化 Ammo 物理世界 =====
    var _sharedContactResult = null; // 重复使用的 ManifoldResult
    var _rayFrom = null; // 重复使用的 ray test 起点
    var _rayTo = null;   // 重复使用的 ray test 终点
    var _rayCB = null;   // 重复使用的 ray callback

    function init(callback) {
        if (ready) { callback && callback(); return; }
        readyCallbacks.push(callback);
        if (readyCallbacks.length > 1) return; // 已经在初始化中

        function doInit() {
            var cfg = new Ammo.btDefaultCollisionConfiguration();
            var disp = new Ammo.btCollisionDispatcher(cfg);
            // 增加碰撞分派池大小，提高碰撞精度
            var broad = new Ammo.btDbvtBroadphase();
            var solver = new Ammo.btSequentialImpulseConstraintSolver();
            world = new Ammo.btDiscreteDynamicsWorld(disp, broad, solver, cfg);
            // 提高 solver 迭代次数，让斜坡上的接触约束更稳定
            var solverInfo = world.getSolverInfo();
            if (solverInfo) {
                // 手机端降低迭代次数，减少物理计算开销
                var _isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
                var _iterations = _isMobile ? 10 : 20;
                if (solverInfo.set_m_numIterations) {
                    solverInfo.set_m_numIterations(_iterations);
                } else if ('m_numIterations' in solverInfo) {
                    solverInfo.m_numIterations = _iterations;
                }
                // 增强斜坡接触稳定性参数
                if (solverInfo.set_m_splitImpulsePenetrationThreshold) {
                    solverInfo.set_m_splitImpulsePenetrationThreshold(-0.01); // 更小穿透阈值=更精确接触
                }
            }
            world.setGravity(new Ammo.btVector3(0, gravity, 0));
            btTransform = new Ammo.btTransform();
            // 预分配 ray test 复用对象
            _rayFrom = new Ammo.btVector3(0, 0, 0);
            _rayTo = new Ammo.btVector3(0, 0, 0);
            _rayCB = new Ammo.AllHitsRayResultCallback(_rayFrom, _rayTo);
            ready = true;

            // 创建静态地面无限平面刚体（防无限坠落）
            var groundShape = new Ammo.btBoxShape(new Ammo.btVector3(500, 0.5, 500));
            groundShape.setMargin(0.04);
            var groundTransform = new Ammo.btTransform();
            groundTransform.setIdentity();
            groundTransform.setOrigin(new Ammo.btVector3(0, -0.5, 0)); // 地面顶面在 y=0
            var groundMotionState = new Ammo.btDefaultMotionState(groundTransform);
            var groundInertia = new Ammo.btVector3(0, 0, 0);
            var groundInfo = new Ammo.btRigidBodyConstructionInfo(0, groundMotionState, groundShape, groundInertia);
            var groundBody = new Ammo.btRigidBody(groundInfo);
            groundBody.setFriction(0.8);
            groundBody.setRestitution(0.0);
            groundBody.setCollisionFlags(1); // CF_STATIC_OBJECT
            world.addRigidBody(groundBody);
            console.log('✅ Ammo.js 静态地面已创建 (y=0)');

            // 补注册 Ammo 就绪前缓存的所有静态物体
            for (var i = 0; i < pendingStatics.length; i++) {
                var ps = pendingStatics[i];
                _registerStaticBox(ps.geometry, ps.pos, ps.scale, ps.mesh);
            }
            pendingStatics = [];
            // 补注册缓存的行走面
            for (var j = 0; j < pendingWalkables.length; j++) {
                _registerWalkableMesh(pendingWalkables[j]);
            }
            pendingWalkables = [];

            // 补注册缓存的三角网格碰撞体（场景物体）
            for (var k = 0; k < pendingColliders.length; k++) {
                var pc = pendingColliders[k];
                createTriangleMeshCollider(pc.verts, pc.indices);
            }
            pendingColliders = [];
            if (k > 0) console.log('✅ 补注册 ' + k + ' 个缓存的三脚网格碰撞体');

            console.log('✅ Ammo.js 物理世界已初始化');
            var cbs = readyCallbacks;
            readyCallbacks = [];
            for (var i = 0; i < cbs.length; i++) { cbs[i] && cbs[i](); }
        }

        if (typeof Ammo === 'function') {
            Ammo().then(doInit);
        } else if (typeof Ammo === 'object' && Ammo.btVector3) {
            doInit();
        } else {
            // Ammo 脚本还未加载完，轮询等待
            var attempts = 0;
            var poll = setInterval(function() {
                attempts++;
                if (typeof Ammo === 'function') {
                    clearInterval(poll);
                    Ammo().then(doInit);
                } else if (typeof Ammo === 'object' && Ammo.btVector3) {
                    clearInterval(poll);
                    doInit();
                } else if (attempts > 100) {
                    clearInterval(poll);
                    console.error('❌ Ammo.js 加载超时');
                }
            }, 50);
        }
    }

    function isReady() { return ready; }
    function getWorld() { return world; }

    // ===== 玩家碰撞体（基于模型线框的凸包软体）=====
    var playerConvexHull = null; // btConvexHullShape from collider visual
    var playerHullDirty = false;

    // ===== 跳跃 Y 速度保护机制 =====
    // 参考 Vue 项目的跳跃系统：时间基保护期 + 土狼时间 + 跳跃缓冲
    var _jumpProtectionFrames = 0;
    var _jumpTargetVy = 0;
    var _jumpInputLocked = false;       // 输入锁定标记
    
    // 【Vue 项目参考】时间基状态
    var _lastOnFloorTime = 0;           // 最后着地时间戳
    var _jumpBufferEndTime = 0;         // 跳跃缓冲截止时间
    var _jumpProtectionEndTime = 0;     // 跳跃保护截止时间
    var _jumpVelocity = 5.5;            // 跳跃初速度
    var _coyoteTime = 120;              // 土狼时间（离地后仍可跳跃，ms）
    var _jumpBufferTime = 120;          // 跳跃缓冲时间（着地前预输入跳跃，ms）
    var _jumpProtectionDuration = 120;  // 跳跃保护期（输入锁定，ms，短保护避免滞空）

    function initPlayerCollider(radius) {
        playerRadius = radius || 0.4;
        playerHeight = 1.6;
        if (!world) {
            // Ammo 还没就绪，返回占位 body
            return { body: { position: { x: 0, y: 0, z: 0 }, setWorldTransform: function(){} }, shape: { radius: playerRadius } };
        }
        // 使用凸包软体替代胶囊体
        return createPlayerBody(null);
    }

    function createPlayerBody(convexShape) {
        // 移除旧的玩家刚体
        if (playerBody) {
            world.removeRigidBody(playerBody);
            playerBody = null;
        }
        var shape = convexShape || new Ammo.btCapsuleShape(playerRadius, playerHeight - playerRadius * 2);
        shape.setMargin(0.02);
        var startTransform = new Ammo.btTransform();
        startTransform.setIdentity();
        startTransform.setOrigin(new Ammo.btVector3(0, playerHeight * 0.5, 0));
        var motionState = new Ammo.btDefaultMotionState(startTransform);
        var inertia = new Ammo.btVector3(0, 0, 0);
        shape.calculateLocalInertia(1, inertia);
        var info = new Ammo.btRigidBodyConstructionInfo(1, motionState, shape, inertia);
        var body = new Ammo.btRigidBody(info);
        body.setRestitution(0.35);       // 提高回弹，防止贴着物体跳跃时碰撞吃掉Y速度
        body.setFriction(0.4);
        body.setAngularFactor(new Ammo.btVector3(0, 0, 0));
        // 【修复】启用连续碰撞检测(CCD)，防止贴着物体时穿透导致的暴力Y向推出
        body.setCcdMotionThreshold(0.0005);  // 更灵敏的CCD触发阈值
        body.setCcdSweptSphereRadius(playerRadius * 0.9);  // 增大CCD swept sphere，提高穿透检测精度
        body.setActivationState(4);
        world.addRigidBody(body);
        playerBody = body;
        playerConvexHull = convexShape;
        // 重置跳跃保护状态
        _jumpProtectionFrames = 0;
        _jumpTargetVy = 0;
        _jumpInputLocked = false;
        _lastOnFloorTime = 0;
        _jumpBufferEndTime = 0;
        _jumpProtectionEndTime = 0;
        return { body: body, shape: shape };
    }

    // 从绿色线框顶点构建凸包碰撞体（降采样控制性能）
    function buildPlayerConvexHull(worldVerts, maxVerts) {
        if (!world || !worldVerts || worldVerts.length < 9) return;
        maxVerts = maxVerts || 120; // 限制顶点数，保持性能
        var totalVerts = worldVerts.length / 3;
        var step = Math.max(1, Math.floor(totalVerts / maxVerts));

        var shape = new Ammo.btConvexHullShape();
        shape.setMargin(0.05);
        var maxYIdx = 0;
        var minYIdx = 0;
        var headCandidates = [];
        var headCandidateLimit = 18;
        for (var i = 0; i < totalVerts; i += step) {
            var i3 = i * 3;
            shape.addPoint(new Ammo.btVector3(worldVerts[i3], worldVerts[i3 + 1], worldVerts[i3 + 2]), false);
            if (worldVerts[i3 + 1] > worldVerts[maxYIdx * 3 + 1]) maxYIdx = i;
            if (worldVerts[i3 + 1] < worldVerts[minYIdx * 3 + 1]) minYIdx = i;
            if (headCandidates.length < headCandidateLimit) {
                headCandidates.push({ idx: i, y: worldVerts[i3 + 1] });
            } else if (worldVerts[i3 + 1] > headCandidates[headCandidates.length - 1].y) {
                headCandidates[headCandidates.length - 1] = { idx: i, y: worldVerts[i3 + 1] };
                headCandidates.sort(function(a, b) { return b.y - a.y; });
            }
        }
        // 确保最后一个顶点被包含
        if (totalVerts > 0) {
            var last = (totalVerts - 1) * 3;
            shape.addPoint(new Ammo.btVector3(worldVerts[last], worldVerts[last + 1], worldVerts[last + 2]), false);
        }
        // 强制包裹最高点与最低点，避免头部/脚步穿模
        if (maxYIdx !== undefined && maxYIdx !== last) {
            var maxI3 = maxYIdx * 3;
            shape.addPoint(new Ammo.btVector3(worldVerts[maxI3], worldVerts[maxI3 + 1], worldVerts[maxI3 + 2]), false);
        }
        if (minYIdx !== undefined && minYIdx !== last && minYIdx !== maxYIdx) {
            var minI3 = minYIdx * 3;
            shape.addPoint(new Ammo.btVector3(worldVerts[minI3], worldVerts[minI3 + 1], worldVerts[minI3 + 2]), false);
        }
        for (var h = 0; h < headCandidates.length; h++) {
            var hIdx = headCandidates[h].idx;
            if (hIdx === last || hIdx === maxYIdx || hIdx === minYIdx) continue;
            var hI3 = hIdx * 3;
            shape.addPoint(new Ammo.btVector3(worldVerts[hI3], worldVerts[hI3 + 1], worldVerts[hI3 + 2]), false);
        }
        shape.recalcLocalAabb();

        // 替换玩家碰撞体
        if (playerBody) {
            var oldPos = new Ammo.btVector3();
            var oldQuat = new Ammo.btQuaternion();
            var ms = playerBody.getMotionState();
            if (ms) {
                ms.getWorldTransform(btTransform);
                oldPos = btTransform.getOrigin();
                oldQuat = btTransform.getRotation();
            }
            var pc = createPlayerBody(shape);
            // 恢复位置和速度
            if (ms) {
                var newTransform = new Ammo.btTransform();
                newTransform.setIdentity();
                newTransform.setOrigin(oldPos);
                newTransform.setRotation(oldQuat);
                pc.body.setWorldTransform(newTransform);
                ms.setWorldTransform(newTransform);
                // 保留速度
                var oldVel = playerBody ? null : null; // oldBody already removed, zero velocity
                pc.body.setLinearVelocity(new Ammo.btVector3(0, 0, 0));
                pc.body.setActivationState(4);
            }
        } else {
            createPlayerBody(shape);
        }
        playerHullDirty = false;
    }

    function isPlayerHullDirty() { return playerHullDirty; }
    function markPlayerHullDirty() { playerHullDirty = true; }

    function setPlayerHitCallback(cb) { onHitCallback = cb; }

    function wakeUpBody(body) {
        if (body && body.wakeUp) body.wakeUp();
        else if (body && body.setActivationState) body.setActivationState(4);
    }

    // ===== 重力 & 地面约束（兼容旧接口，也通过 Ammo 模拟）=====
    function applyGravity(posX, posY, posZ, delta) {
        if (!playerBody) return posY;
        // 从物理体获取最新位置
        var ms = playerBody.getMotionState();
        if (ms) {
            ms.getWorldTransform(btTransform);
            var origin = btTransform.getOrigin();
            return origin.y() - playerHeight * 0.5;
        }
        return posY;
    }

    function resolveCollisions(posX, posY, posZ) {
        // Ammo 物理世界自动处理碰撞，无需手动 resolve
        if (!playerBody) return { x: posX, y: posY, z: posZ };
        var ms = playerBody.getMotionState();
        if (ms) {
            ms.getWorldTransform(btTransform);
            var origin = btTransform.getOrigin();
            return { x: origin.x(), y: origin.y() - playerHeight * 0.5, z: origin.z() };
        }
        return { x: posX, y: posY, z: posZ };
    }

    function constrainToGround(posY) {
        return Math.max(posY, 0);
    }

    // ===== 内部：注册静态方块到 Ammo =====
    function _registerStaticBox(geometry, pos, scale, mesh) {
        if (!world) return null;
        var shape = new Ammo.btBoxShape(new Ammo.btVector3(
            (geometry.parameters.width || 1) * 0.5 * (scale || 1),
            (geometry.parameters.height || 1) * 0.5 * (scale || 1),
            (geometry.parameters.depth || 1) * 0.5 * (scale || 1)
        ));
        shape.setMargin(0.04);
        var t = new Ammo.btTransform();
        t.setIdentity();
        t.setOrigin(new Ammo.btVector3(pos.x, pos.y, pos.z));
        var motionState = new Ammo.btDefaultMotionState(t);
        var inertia = new Ammo.btVector3(0, 0, 0);
        var info = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, inertia);
        var body = new Ammo.btRigidBody(info);
        body.setFriction(0.8);
        body.setRestitution(0.1);
        body.setCollisionFlags(1); // CF_STATIC_OBJECT
        world.addRigidBody(body);
        return body;
    }

    // ===== 内部：注册行走面网格到 Ammo =====
    // 使用 btConvexHullShape 精确表示斜坡的倾斜表面（含旋转），
    // 替代之前的 btBoxShape（只能表示 AABB 包围盒，无法匹配斜面法线）
    function _registerWalkableMesh(meshObj) {
        if (!world) return;
        meshObj.updateMatrixWorld(true);
        // 提取 mesh 的世界坐标顶点，构建凸包碰撞体
        var geom = meshObj.geometry;
        var posAttr = geom.getAttribute('position');
        var worldMat = meshObj.matrixWorld;
        var v = new THREE.Vector3();
        var shape = new Ammo.btConvexHullShape();
        shape.setMargin(0.02); // 减小碰撞余量，提高斜坡接触精度
        for (var i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i);
            v.applyMatrix4(worldMat);
            shape.addPoint(new Ammo.btVector3(v.x, v.y, v.z), false); // false=不重算AABB
        }
        shape.recalcLocalAabb(); // 所有点加完后统一重算 AABB
        // 使用 mesh 世界变换的原点作为刚体位置
        var center = new THREE.Vector3();
        meshObj.getWorldPosition(center);
        var t = new Ammo.btTransform();
        t.setIdentity();
        t.setOrigin(new Ammo.btVector3(0, 0, 0)); // 顶点已是世界坐标，刚体放置在原点
        var motionState = new Ammo.btDefaultMotionState(t);
        var inertia = new Ammo.btVector3(0, 0, 0);
        var info = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, inertia);
        var body = new Ammo.btRigidBody(info);
        body.setFriction(0.95);        // 斜坡表面高摩擦，确保角色稳定行走不滑动
        body.setRestitution(0.0);
        body.setCollisionFlags(1);     // CF_STATIC_OBJECT
        world.addRigidBody(body);
    }

    // ===== 创建斜坡物体（旋转的 BoxGeometry + 精确凸包碰撞）=====
    // 斜坡的倾斜面通过 rotateX 实现，碰撞体使用 ConvexHullShape 精确匹配倾斜面
    function createRamp(width, height, depth, angleRad, pos, color) {
        var geo = new THREE.BoxGeometry(width, height, depth);
        var mat = new THREE.MeshStandardMaterial({
            color: color || 0x636366,
            roughness: 0.8,
            metalness: 0.05
        });
        var mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(pos);
        mesh.rotation.x = angleRad; // 绕 X 轴旋转形成斜面
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.updateMatrixWorld(true);

        var obj = { mesh: mesh, isWalkable: true, isDynamic: false, body: null, _pos: { x: pos.x, y: pos.y, z: pos.z } };

        if (world) {
            // 使用 ConvexHullShape 精确匹配斜面（含旋转）
            var posAttr = geo.getAttribute('position');
            var worldMat = mesh.matrixWorld;
            var v = new THREE.Vector3();
            var shape = new Ammo.btConvexHullShape();
            shape.setMargin(0.02);
            for (var i = 0; i < posAttr.count; i++) {
                v.fromBufferAttribute(posAttr, i);
                v.applyMatrix4(worldMat);
                shape.addPoint(new Ammo.btVector3(v.x, v.y, v.z), false);
            }
            shape.recalcLocalAabb();

            var t = new Ammo.btTransform();
            t.setIdentity();
            t.setOrigin(new Ammo.btVector3(0, 0, 0)); // 顶点已是世界坐标
            var motionState = new Ammo.btDefaultMotionState(t);
            var inertia = new Ammo.btVector3(0, 0, 0);
            var info = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, inertia);
            var body = new Ammo.btRigidBody(info);
            body.setFriction(0.95); // 斜坡高摩擦
            body.setRestitution(0.0);
            body.setCollisionFlags(1); // STATIC
            world.addRigidBody(body);
            obj.body = body;

            // 同时注册为行走面，让 IK 脚部射线能命中斜面
            _registerWalkableMesh(mesh);
        } else {
            pendingWalkables.push(mesh);
            pendingStatics.push({ geometry: geo, pos: pos, scale: 1, mesh: mesh, isWalkable: true });
        }

        return obj;
    }

    // ===== 创建物理物体（Ammo 刚体 + Three.js 网格同步）=====
    function createPhysicsObject(geometry, pos, scale, color, mass, isWalkable) {
        var meshMat = new THREE.MeshStandardMaterial({
            color: color || 0x88ccff,
            roughness: 0.7,
            metalness: 0.1
        });
        var mesh = new THREE.Mesh(geometry, meshMat);
        mesh.position.copy(pos);
        mesh.scale.set(scale || 1, scale || 1, scale || 1);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        var obj = {
            mesh: mesh, isWalkable: !!isWalkable, isDynamic: mass > 0,
            body: null,
            userGenerated: false,
            _pos: { x: pos.x, y: pos.y, z: pos.z }
        };

        if (world) {
            if (mass > 0) {
                // 动态刚体
                var shape = new Ammo.btBoxShape(new Ammo.btVector3(
                    (geometry.parameters.width || 1) * 0.5 * (scale || 1),
                    (geometry.parameters.height || 1) * 0.5 * (scale || 1),
                    (geometry.parameters.depth || 1) * 0.5 * (scale || 1)
                ));
                shape.setMargin(0.04);
                var t = new Ammo.btTransform();
                t.setIdentity();
                t.setOrigin(new Ammo.btVector3(pos.x, pos.y, pos.z));
                var motionState = new Ammo.btDefaultMotionState(t);
                var inertia = new Ammo.btVector3(0, 0, 0);
                shape.calculateLocalInertia(mass, inertia);
                var info = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, inertia);
                var body = new Ammo.btRigidBody(info);
                body.setFriction(0.8);
                body.setRestitution(0.1);
                world.addRigidBody(body);
                obj.body = body;
                rigidBodies.push(obj);
                body.setActivationState(4);
            } else {
                // 静态刚体
                obj.body = _registerStaticBox(geometry, pos, scale, mesh);
            }
        } else {
            // Ammo 未就绪 — 缓存静态物体，等待物理世界初始化后补注册
            if (mass === 0) {
                pendingStatics.push({ geometry: geometry, pos: pos, scale: scale, mesh: mesh, isWalkable: isWalkable });
            }
            obj.body = { position: { x: pos.x, y: pos.y, z: pos.z }, velocity: { x: 0, y: 0, z: 0 }, quaternion: mesh.quaternion };
        }
        return obj;
    }

    // ===== 从世界坐标顶点+索引创建静态三角网格碰撞体（保留凹面结构）=====
    function createTriangleMeshCollider(worldVerts, worldIndices) {
        if (!worldVerts || worldVerts.length < 9) return null;
        if (!worldIndices || worldIndices.length < 3) return null;

        // Ammo 未就绪：缓存到队列，等物理世界初始化后补注册
        if (!world) {
            pendingColliders.push({ verts: worldVerts, indices: worldIndices });
            console.log('[Physics] Ammo 未就绪，三角网格碰撞体已缓存 (' + (worldVerts.length / 3) + ' 顶点)');
            return null;
        }

        var totalTriangles = worldIndices.length / 3;
        var triangleMesh = new Ammo.btTriangleMesh(true, false);

        for (var t = 0; t < totalTriangles; t++) {
            var i0 = worldIndices[t * 3];
            var i1 = worldIndices[t * 3 + 1];
            var i2 = worldIndices[t * 3 + 2];
            var v0 = new Ammo.btVector3(worldVerts[i0 * 3], worldVerts[i0 * 3 + 1], worldVerts[i0 * 3 + 2]);
            var v1 = new Ammo.btVector3(worldVerts[i1 * 3], worldVerts[i1 * 3 + 1], worldVerts[i1 * 3 + 2]);
            var v2 = new Ammo.btVector3(worldVerts[i2 * 3], worldVerts[i2 * 3 + 1], worldVerts[i2 * 3 + 2]);
            triangleMesh.addTriangle(v0, v1, v2, false);
        }

        var useQuantizedAabbCompression = true;
        var shape = new Ammo.btBvhTriangleMeshShape(triangleMesh, useQuantizedAabbCompression, true);
        shape.setMargin(0.05);

        // Static body at origin (vertices are already in world space)
        var t = new Ammo.btTransform();
        t.setIdentity();
        t.setOrigin(new Ammo.btVector3(0, 0, 0));
        var motionState = new Ammo.btDefaultMotionState(t);
        var inertia = new Ammo.btVector3(0, 0, 0);
        shape.calculateLocalInertia(0, inertia);
        var info = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, inertia);
        var body = new Ammo.btRigidBody(info);
        body.setFriction(0.8);
        body.setRestitution(0.1);
        body.setCollisionFlags(2); // STATIC
        world.addRigidBody(body);

        return { body: body, shape: shape };
    }

    // ===== 注册静态行走面 =====
    function registerWalkable(meshObj, isWalkable) {
        if (!world) {
            // Ammo 未就绪 — 缓存，等待物理世界初始化后补注册
            pendingWalkables.push(meshObj);
            return;
        }
        _registerWalkableMesh(meshObj);
    }

    // 推进物理世界步进 + 同步 Three.js 网格 =====
    function stepSimulation(delta) {
        if (!world) return;
        // 手机端降低子步数和步长精度，减少物理计算量
        var _mobi = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
        var _maxSub = _mobi ? 3 : 20;
        var _fixedStep = _mobi ? 1/30 : 1/120;
        world.stepSimulation(delta, _maxSub, _fixedStep);

        // 【修复】空中水平速度空气阻力衰减：减少滞空滑翔感，让下落更自然
        if (!getIsGrounded() && playerBody) {
            var vel = playerBody.getLinearVelocity();
            var vx = vel.x();
            var vz = vel.z();
            var hSpeed = Math.sqrt(vx * vx + vz * vz);
            if (hSpeed > 0.05) {
                // 空中水平阻力：每帧衰减约 6%，保留足够控制力但减少滑翔
                var drag = 0.94;
                vel.setX(vx * drag);
                vel.setZ(vz * drag);
                playerBody.setLinearVelocity(vel);
                playerBody.setActivationState(4);
            }
        }

        // 【Vue 项目参考】时间基跳跃保护：物理步进后保护 Y 速度不被碰撞求解器吃掉
        if (_jumpInputLocked && playerBody) {
            var now = performance.now();
            if (now < _jumpProtectionEndTime) {
                var currentVel = playerBody.getLinearVelocity();
                var currentVy = currentVel.y();
                // 【修复】只在上升阶段保护Y速度，避免下落时强制拉回导致滞空
                if (currentVy > 0 && currentVy < _jumpTargetVy * 0.4) {
                    currentVel.setY(_jumpTargetVy);
                    playerBody.setLinearVelocity(currentVel);
                    playerBody.setActivationState(4);
                }
                // 如果着地且速度低，提前结束保护
                if (getIsGrounded() && currentVy <= 0.1) {
                    _jumpInputLocked = false;
                    _jumpProtectionFrames = 0;
                    _jumpTargetVy = 0;
                }
            } else {
                // 保护到期自动解锁
                _jumpInputLocked = false;
                _jumpProtectionFrames = 0;
                _jumpTargetVy = 0;
            }
        }

        // 同步动态刚体到 Three.js 网格
        for (var i = 0; i < rigidBodies.length; i++) {
            var obj = rigidBodies[i];
            var ms = obj.body.getMotionState();
            if (ms) {
                ms.getWorldTransform(btTransform);
                var p = btTransform.getOrigin();
                var q = btTransform.getRotation();
                obj.mesh.position.set(p.x(), p.y(), p.z());
                obj.mesh.quaternion.set(q.x(), q.y(), q.z(), q.w());
            }
        }
    }

    // ===== 直接设置玩家位置（用于模型切换重置）=====
    function setPlayerPosition(x, y, z) {
        if (!playerBody) return;
        var t = new Ammo.btTransform();
        t.setIdentity();
        t.setOrigin(new Ammo.btVector3(x, y + playerHeight * 0.5, z));
        playerBody.setWorldTransform(t);
        var ms = playerBody.getMotionState();
        if (ms) ms.setWorldTransform(t);
        playerBody.setLinearVelocity(new Ammo.btVector3(0, 0, 0));
        playerBody.setAngularVelocity(new Ammo.btVector3(0, 0, 0));
        playerBody.setActivationState(4); // 唤醒
    }

    function setPlayerVelocity(vx, vz) {
        if (!playerBody) return;
        // 【Vue 项目参考】时间基输入锁定：保护期内允许水平速度更新，保留Y轴实现斜向跳跃
        if (_jumpInputLocked) {
            var now = performance.now();
            if (now < _jumpProtectionEndTime) {
                // 保护期内只更新水平速度，保留当前Y轴
                var currentVel = playerBody.getLinearVelocity();
                playerBody.setLinearVelocity(new Ammo.btVector3(vx, currentVel.y(), vz));
                playerBody.setActivationState(4);
                return;
            }
            // 保护已过期，清除残留锁
            _jumpInputLocked = false;
            _jumpProtectionFrames = 0;
            _jumpTargetVy = 0;
        }
        playerBody.setLinearVelocity(new Ammo.btVector3(vx, playerBody.getLinearVelocity().y(), vz));
        playerBody.setActivationState(4);
    }

    // ===== 跳跃：给玩家 Y 轴速度 + 激活时间基跳跃保护 =====
    function setVerticalVelocity(v) {
        if (!playerBody) return;
        // 【修复】保留当前水平速度，实现斜向跳跃（跑动跳跃效果）
        var currentVel = playerBody.getLinearVelocity();
        var vx = currentVel.x();
        var vz = currentVel.z();
        playerBody.setLinearVelocity(new Ammo.btVector3(vx, v, vz));
        playerBody.applyCentralImpulse(new Ammo.btVector3(0, v * 0.35, 0));
        // 微抬位置强制脱离表面
        var ms = playerBody.getMotionState();
        if (ms) {
            ms.getWorldTransform(btTransform);
            var origin = btTransform.getOrigin();
            origin.setY(origin.y() + 0.06);
            playerBody.setWorldTransform(btTransform);
            ms.setWorldTransform(btTransform);
        }
        playerBody.setActivationState(4);
        
        // 【Vue 项目参考】时间基保护期 300ms，而非固定帧数
        var now = performance.now();
        _jumpTargetVy = v;
        _jumpProtectionFrames = 30;  // 设大帧数避免帧数低时提前结束
        _jumpInputLocked = true;
        _jumpProtectionEndTime = now + _jumpProtectionDuration;
        
        // 【修复】跳跃触发时立即更新 Ammo 离地缓存，避免主循环因缓存默认值误判为地面状态
        // 导致摇杆在起跳瞬间打断跳跃动画
        if (_ammoToeResult) {
            _ammoToeResult.airborne = true;
            _ammoToeResult.grounded = false;
            _ammoToeResult.leftGrounded = false;
            _ammoToeResult.rightGrounded = false;
            _ammoToeTime = performance.now();
        }
    }

    // ===== 【Vue 项目参考】土狼时间 + 跳跃缓冲 + 保护期管理 =====
    function tryJump() {
        if (!playerBody) return false;
        var now = performance.now();
        // 【Vue 项目参考】允许跳跃的条件：着地 OR 土狼时间窗口内 OR 缓冲窗口内
        var onFloor = getIsGrounded() || (now - _lastOnFloorTime < _coyoteTime);
        
        if (onFloor || (now < _jumpBufferEndTime)) {
            var jumpVel = _jumpVelocity;
            setVerticalVelocity(jumpVel);
            _jumpBufferEndTime = 0; // 清除缓冲
            return true;
        } else {
            // 【Vue 项目参考】缓冲跳跃输入：落地前预按跳跃键
            _jumpBufferEndTime = now + _jumpBufferTime;
            return false;
        }
    }

    // ===== 【Vue 项目参考】每帧更新跳跃状态 =====
    function updateJumpState() {
        var now = performance.now();
        
        // 更新着地时间戳（用于土狼时间判定）
        if (getIsGrounded()) {
            _lastOnFloorTime = now;
        }
        
        // 保护到期自动解锁（时间基）
        if (_jumpInputLocked && now >= _jumpProtectionEndTime) {
            _jumpInputLocked = false;
            _jumpProtectionFrames = 0;
            _jumpTargetVy = 0;
        }
        
        // 缓冲过期清理
        if (_jumpBufferEndTime > 0 && now >= _jumpBufferEndTime) {
            _jumpBufferEndTime = 0;
        }
    }

    function getVerticalVelocity() {
        if (!playerBody) return 0;
        return playerBody.getLinearVelocity().y();
    }

    function isJumpProtectionActive() {
        // 【Vue 项目参考】时间基保护判定
        return _jumpInputLocked && performance.now() < _jumpProtectionEndTime;
    }

    // ===== 【Vue 项目参考】台阶跨越系统 =====
    // 检测前方是否有低于 maxStepHeight 的障碍物，若有则自动抬升玩家跨越
    function tryStepUp() {
        if (!playerBody || !getIsGrounded()) return false;
        // 保护期内不执行台阶检测（避免干扰跳跃脱离）
        if (_jumpInputLocked) return false;
        // 冷却中，跳过
        if (_stepUpCooldown > 0) {
            _stepUpCooldown--;
            return false;
        }

        var ms = playerBody.getMotionState();
        if (!ms) return false;
        ms.getWorldTransform(btTransform);
        var origin = btTransform.getOrigin();

        var vel = playerBody.getLinearVelocity();
        var vx = vel.x();
        var vz = vel.z();
        var hSpeed = Math.sqrt(vx * vx + vz * vz);
        
        // 【速度优化】奔跑时允许跨越更高的台阶
        // 行走时 maxStepHeight = 0.4，奔跑时提升到 0.6
        var currentMaxStepHeight = hSpeed > 1.8 ? 0.55 : _maxStepHeight;
        var currentStepForwardDist = hSpeed > 1.8 ? 0.5 : _stepForwardDist;
        if (hSpeed < 0.3) {
            if (_stepUpActive) {
                _stepUpActive = false;
                _stepUpHeight = 0;
            }
            return false;
        }

        // 归一化水平方向
        var dirX = vx / hSpeed;
        var dirZ = vz / hSpeed;

        // 脚底 Y：胶囊底部 + 小偏移
        var footY = origin.y() - playerHeight * 0.5 + 0.08;

        // Ray 1：在脚底高度向前检测
        var fwd = currentStepForwardDist;
        if (!_stepUpTempFrom) {
            _stepUpTempFrom = new Ammo.btVector3(0, 0, 0);
            _stepUpTempTo = new Ammo.btVector3(0, 0, 0);
            _stepUpCB = new Ammo.ClosestRayResultCallback(_stepUpTempFrom, _stepUpTempTo);
            _stepUpCB2 = new Ammo.ClosestRayResultCallback(_stepUpTempFrom, _stepUpTempTo);
        }
        _stepUpTempFrom.setValue(origin.x(), footY, origin.z());
        _stepUpTempTo.setValue(origin.x() + dirX * fwd, footY, origin.z() + dirZ * fwd);

        // 重置并执行前向射线检测
        _stepUpCB.m_closestHitFraction = 1;
        _stepUpCB.m_collisionObject = null;
        _stepUpCB.m_rayFromWorld = _stepUpTempFrom;
        _stepUpCB.m_rayToWorld = _stepUpTempTo;
        world.rayTest(_stepUpTempFrom, _stepUpTempTo, _stepUpCB);

        if (!_stepUpCB.hasHit()) {
            if (_stepUpActive) {
                _stepUpActive = false;
                _stepUpHeight = 0;
            }
            return false;
        }

        var hitNormal = _stepUpCB.m_hitNormalWorld;
        // 只处理垂直或接近垂直的面（法线 y < 0.3 视为墙面/台阶立面）
        if (hitNormal.y() > 0.3) {
            if (_stepUpActive) {
                _stepUpActive = false;
                _stepUpHeight = 0;
            }
            return false;
        }

        var hitPt = _stepUpCB.m_hitPointWorld;

        // Ray 2：从碰撞点向上检测，找到台阶顶面
        _stepUpTempFrom.setValue(hitPt.x(), footY + 0.005, hitPt.z());
        _stepUpTempTo.setValue(hitPt.x(), footY + currentMaxStepHeight + 0.1, hitPt.z());

        _stepUpCB2.m_closestHitFraction = 1;
        _stepUpCB2.m_collisionObject = null;
        _stepUpCB2.m_rayFromWorld = _stepUpTempFrom;
        _stepUpCB2.m_rayToWorld = _stepUpTempTo;
        world.rayTest(_stepUpTempFrom, _stepUpTempTo, _stepUpCB2);

        var stepHeight;
        if (_stepUpCB2.hasHit()) {
            var topPt = _stepUpCB2.m_hitPointWorld;
            stepHeight = topPt.y() - hitPt.y();
        } else {
            // 没有检测到顶面，按最大高度处理
            stepHeight = currentMaxStepHeight;
        }

        if (stepHeight < 0.04 || stepHeight > currentMaxStepHeight) {
            if (_stepUpActive) {
                _stepUpActive = false;
                _stepUpHeight = 0;
            }
            return false;
        }

        // Ray 3：确认抬升位置没有遮挡物
        var liftY = origin.y() + stepHeight + 0.03;
        _stepUpTempFrom.setValue(origin.x() + dirX * (playerRadius + 0.05), footY + stepHeight + 0.05, origin.z() + dirZ * (playerRadius + 0.05));
        _stepUpTempTo.setValue(origin.x() + dirX * (playerRadius + 0.05), liftY, origin.z() + dirZ * (playerRadius + 0.05));

        _stepUpCB.m_closestHitFraction = 1;
        _stepUpCB.m_collisionObject = null;
        _stepUpCB.m_rayFromWorld = _stepUpTempFrom;
        _stepUpCB.m_rayToWorld = _stepUpTempTo;
        world.rayTest(_stepUpTempFrom, _stepUpTempTo, _stepUpCB);

        if (_stepUpCB.hasHit()) {
            // 抬升路径有遮挡，放弃
            if (_stepUpActive) {
                _stepUpActive = false;
                _stepUpHeight = 0;
            }
            return false;
        }

        // ===== 【Vue 项目参考】自然抬升：不传送位置，用速度冲量 =====
        var currentVel = playerBody.getLinearVelocity();
        var liftVel = 0.5 + stepHeight * 1.8;
        currentVel.setY(Math.max(currentVel.y(), liftVel));
        playerBody.setLinearVelocity(currentVel);
        playerBody.setActivationState(4);

        _stepUpActive = true;
        _stepUpHeight = stepHeight;
        _stepUpCooldown = 2;

        return true;
    }

    // 台阶跨越状态导出
    function isStepUpActive() {
        return _stepUpActive;
    }
    
    function getStepUpHeight() {
        return _stepUpHeight;
    }

    // ===== 【Vue 项目参考】使用速度冲量的台阶跨越 =====
    // 由 main-loop 在 setPlayerVelocity 之后、stepSimulation 之前调用
    // 传入 worker 输出的目标速度 (inputVX, inputVZ)
    // 关键：不直接传送位置，而是用向上速度冲量让物理引擎自然抬升角色
    function tryStepUpWithInput(inputVX, inputVZ) {
        if (!playerBody || !getIsGrounded()) return false;
        if (_jumpInputLocked) return false;
        if (_stepUpCooldown > 0) {
            _stepUpCooldown--;
            return false;
        }

        var hSpeed = Math.sqrt(inputVX * inputVX + inputVZ * inputVZ);
        if (hSpeed < 0.3) {
            if (_stepUpActive) { _stepUpActive = false; _stepUpHeight = 0; }
            return false;
        }

        // 奔跑时略微提升跨越能力
        var currentMaxStepHeight = hSpeed > 1.8 ? 0.50 : _maxStepHeight;
        var currentStepForwardDist = hSpeed > 1.8 ? 0.50 : _stepForwardDist;

        var ms = playerBody.getMotionState();
        if (!ms) return false;
        ms.getWorldTransform(btTransform);
        var origin = btTransform.getOrigin();

        var dirX = inputVX / hSpeed;
        var dirZ = inputVZ / hSpeed;
        var footY = origin.y() - playerHeight * 0.5 + 0.08;

        // 确保射线对象已初始化
        if (!_stepUpTempFrom) _stepUpTempFrom = new Ammo.btVector3(0, 0, 0);
        if (!_stepUpTempTo) _stepUpTempTo = new Ammo.btVector3(0, 0, 0);
        if (!_stepUpCB) _stepUpCB = new Ammo.ClosestRayResultCallback(_stepUpTempFrom, _stepUpTempTo);
        if (!_stepUpCB2) _stepUpCB2 = new Ammo.ClosestRayResultCallback(_stepUpTempFrom, _stepUpTempTo);

        // Ray 1：在脚底高度向前检测障碍物立面
        _stepUpTempFrom.setValue(origin.x(), footY, origin.z());
        _stepUpTempTo.setValue(origin.x() + dirX * currentStepForwardDist, footY, origin.z() + dirZ * currentStepForwardDist);

        _stepUpCB.m_closestHitFraction = 1;
        _stepUpCB.m_collisionObject = null;
        _stepUpCB.m_rayFromWorld = _stepUpTempFrom;
        _stepUpCB.m_rayToWorld = _stepUpTempTo;
        world.rayTest(_stepUpTempFrom, _stepUpTempTo, _stepUpCB);

        if (!_stepUpCB.hasHit()) {
            if (_stepUpActive) { _stepUpActive = false; _stepUpHeight = 0; }
            return false;
        }

        var hitNormal = _stepUpCB.m_hitNormalWorld;
        if (hitNormal.y() > 0.3) {
            if (_stepUpActive) { _stepUpActive = false; _stepUpHeight = 0; }
            return false;
        }

        var hitPt = _stepUpCB.m_hitPointWorld;

        // Ray 2：从碰撞点向上检测，找到台阶顶面
        _stepUpTempFrom.setValue(hitPt.x(), footY + 0.005, hitPt.z());
        _stepUpTempTo.setValue(hitPt.x(), footY + currentMaxStepHeight + 0.1, hitPt.z());

        _stepUpCB2.m_closestHitFraction = 1;
        _stepUpCB2.m_collisionObject = null;
        _stepUpCB2.m_rayFromWorld = _stepUpTempFrom;
        _stepUpCB2.m_rayToWorld = _stepUpTempTo;
        world.rayTest(_stepUpTempFrom, _stepUpTempTo, _stepUpCB2);

        var stepHeight;
        if (_stepUpCB2.hasHit()) {
            var topPt = _stepUpCB2.m_hitPointWorld;
            stepHeight = topPt.y() - hitPt.y();
        } else {
            stepHeight = currentMaxStepHeight;
        }

        if (stepHeight < 0.04 || stepHeight > currentMaxStepHeight) {
            if (_stepUpActive) { _stepUpActive = false; _stepUpHeight = 0; }
            return false;
        }

        // ===== 【Vue 项目参考】自然抬升：不传送位置，用速度冲量 =====
        // 直接设置向上速度，让物理引擎自然完成抬升
        var currentVel = playerBody.getLinearVelocity();
        // 抬升速度与台阶高度成正比，确保足够脱离表面
        var liftVel = 0.5 + stepHeight * 1.8;
        currentVel.setY(Math.max(currentVel.y(), liftVel));
        playerBody.setLinearVelocity(currentVel);
        playerBody.setActivationState(4);

        _stepUpActive = true;
        _stepUpHeight = stepHeight;
        // 短冷却让每帧可连续检测
        _stepUpCooldown = 2;

        return true;
    }

    // ===== 【Vue 项目参考】地面吸附 =====
    // 将模型脚底吸附到地面，确保台阶/斜坡上姿态自然
    function applyGroundAdhesion(model) {
        if (!playerBody || !model) return;
        var ms = playerBody.getMotionState();
        if (!ms) return;
        ms.getWorldTransform(btTransform);
        var origin = btTransform.getOrigin();

        // 从脚底向下发射短射线
        var footY = origin.y() - playerHeight * 0.5 - 0.02;
        var castDist = 0.15;
        if (!_stepUpTempFrom) {
            _stepUpTempFrom = new Ammo.btVector3(0, 0, 0);
            _stepUpTempTo = new Ammo.btVector3(0, 0, 0);
            _stepUpCB = new Ammo.ClosestRayResultCallback(_stepUpTempFrom, _stepUpTempTo);
        }
        _stepUpTempFrom.setValue(origin.x(), footY, origin.z());
        _stepUpTempTo.setValue(origin.x(), footY - castDist, origin.z());

        _stepUpCB.m_closestHitFraction = 1;
        _stepUpCB.m_collisionObject = null;
        _stepUpCB.m_rayFromWorld = _stepUpTempFrom;
        _stepUpCB.m_rayToWorld = _stepUpTempTo;
        world.rayTest(_stepUpTempFrom, _stepUpTempTo, _stepUpCB);

        if (_stepUpCB.hasHit()) {
            var normal = _stepUpCB.m_hitNormalWorld;
            if (normal.y() > 0.7 && getIsGrounded()) {
                var hitPt = _stepUpCB.m_hitPointWorld;
                var targetY = hitPt.y() + playerHeight * 0.5 + 0.01;
                // 平滑吸附：差值到目标 Y
                var currentY = model.position.y;
                var snapSpeed = 0.25;
                model.position.y += (targetY - currentY) * snapSpeed;
            }
        }
    }

    var _closestRayCB = null; // 复用的 ClosestRayResultCallback
    var _groundNormal = null; // 地面法线缓存
    var _flatMode = false;    // 平地模式标志

    // ===== 【Vue 项目参考】台阶跨越检测 =====
    var _stepUpCB = null;      // 台阶检测射线回调（向前）
    var _stepUpCB2 = null;     // 台阶检测射线回调（向上）
    var _stepUpTempFrom = null; // 台阶检测临时起点
    var _stepUpTempTo = null;  // 台阶检测临时终点
    var _maxStepHeight = 0.4;  // 最大可跨越台阶高度（参考 Vue 项目 CONTROLLER_MAX_STEP_HEIGHT）
    var _stepForwardDist = 0.5; // 台阶检测前向距离（增大以提前检测）
    var _stepUpActive = false; // 正在跨越台阶的标志（用于动画系统）
    var _stepUpHeight = 0;     // 当前跨越的台阶高度
    var _stepUpCooldown = 0;   // 台阶跨越冷却帧数，防止楼梯上反复触发

    function getIsGrounded() {
        if (!playerBody) return false;
        // 【Vue 项目参考】使用射线检测判断是否着地，结合法线阈值区分平地与斜坡
        var ms = playerBody.getMotionState();
        if (!ms) return false;
        ms.getWorldTransform(btTransform);
        var origin = btTransform.getOrigin();
        var castLen = playerHeight * 0.5 + playerRadius + 0.15;
        _rayFrom.setValue(origin.x(), origin.y(), origin.z());
        _rayTo.setValue(origin.x(), origin.y() - castLen, origin.z());
        if (!_closestRayCB) {
            _closestRayCB = new Ammo.ClosestRayResultCallback(_rayFrom, _rayTo);
        }
        _closestRayCB.m_closestHitFraction = 1;
        _closestRayCB.m_collisionObject = null;
        _closestRayCB.m_rayFromWorld = _rayFrom;
        _closestRayCB.m_rayToWorld = _rayTo;
        world.rayTest(_rayFrom, _rayTo, _closestRayCB);
        var hit = _closestRayCB.hasHit();
        if (hit) {
            var hitNormal = _closestRayCB.m_hitNormalWorld;
            var ny = hitNormal.y();
            // 【Vue 项目参考】法线 y > 0.7 视为地面（原 0.95 过于严格，平缓斜坡上会认为离地）
            _flatMode = (ny > 0.7);
            if (!_groundNormal) {
                _groundNormal = new Ammo.btVector3(hitNormal.x(), hitNormal.y(), hitNormal.z());
            } else {
                _groundNormal.setValue(hitNormal.x(), hitNormal.y(), hitNormal.z());
            }
        } else {
            _flatMode = false;
        }
        return hit;
    }

    // ===== 同步玩家位置到 model =====
    function syncPlayerToModel(model) {
        if (!playerBody || !model) return;
        var ms = playerBody.getMotionState();
        if (ms) {
            ms.getWorldTransform(btTransform);
            var o = btTransform.getOrigin();
            model.position.x = o.x();
            model.position.y = o.y() - playerHeight * 0.5;
            model.position.z = o.z();
        }
    }

    function syncPlayerState(model, body, joystickState, delta, isPhysicsMode) {
        if (isPhysicsMode && ready) { syncPlayerToModel(model); }
    }

    function resetPhysicsBody(body, model) {
        if (!playerBody) return;
        if (model) {
            setPlayerPosition(model.position.x, model.position.y, model.position.z);
        }
        playerBody.setLinearVelocity(new Ammo.btVector3(0, 0, 0));
        playerBody.setAngularVelocity(new Ammo.btVector3(0, 0, 0));
    }

    // ===== 清理场景中可移除的刚体（静态+动态）=====
    function removeRigidBody(obj) {
        if (!world || !obj.body) return;
        // 检查是否是真正的 Ammo 刚体
        if (!obj.body.getMotionState) return;
        world.removeRigidBody(obj.body);
        // 如果是动态刚体，也从 rigidBodies 列表中移除
        var idx = rigidBodies.indexOf(obj);
        if (idx !== -1) rigidBodies.splice(idx, 1);
    }

    // ===== 移除所有动态刚体（模型切换时清理）=====
    function clearDynamicBodies() {
        for (var i = rigidBodies.length - 1; i >= 0; i--) {
            world.removeRigidBody(rigidBodies[i].body);
        }
        rigidBodies = [];
    }

    // ===== 移除玩家碰撞体（模型切换时清理）=====
    function removePlayerBody(oldBody) {
        if (!world || !oldBody || !oldBody.getMotionState) return;
        world.removeRigidBody(oldBody);
        if (oldBody === playerBody) playerBody = null;
    }

    // ===== 基于 Ammo.rayTest 的脚部离地检测（替代昂贵的 Three.js raycaster）=====
    // 使用物理引擎的碰撞形状做射线检测，比 Three.js raycaster 快 10-100 倍
    // 【修复】延迟初始化到 doInit() 内部，避免顶层执行时 Ammo 尚未就绪导致脚本中断
    var _ammoToeFrom = null;
    var _ammoToeTo = null;
    var _ammoToeCB = null;

    // 缓存检测结果
    var _ammoToeResult = { airborne: false, grounded: true, leftGrounded: true, rightGrounded: true };
    var _ammoToeTime = 0;
    var AMMO_TOE_RAY_LEN = 0.35;
    var AMMO_TOE_THRESHOLD = 0.18; // 增大阈值，减少地面/窄表面误判

    // 滞回计数器：避免单帧误判导致摇杆动画被阻断
    var _airborneHysteresis = 0;
    var AIRBORNE_HYSTERESIS_FRAMES = 3; // 连续3帧判定为空中才真正阻断

    // 确保 Ammo 检测对象已初始化（懒加载，仅在首次调用时创建）
    function _ensureAmmoToeObjects() {
        if (_ammoToeFrom) return true;
        if (typeof Ammo === 'undefined' || !Ammo.btVector3) return false;
        _ammoToeFrom = new Ammo.btVector3(0, 0, 0);
        _ammoToeTo = new Ammo.btVector3(0, 0, 0);
        _ammoToeCB = new Ammo.ClosestRayResultCallback(_ammoToeFrom, _ammoToeTo);
        return true;
    }

    // 检测单只脚是否着地（利用 Ammo 物理世界的碰撞形状加速）
    function _ammoCheckFoot(footX, footY, footZ) {
        if (!world) return 'grounded';
        // 【修复】Ammo 对象可能尚未初始化（顶层代码执行时 Ammo 还未就绪）
        if (!_ensureAmmoToeObjects()) return 'grounded';

        _ammoToeFrom.setValue(footX, footY, footZ);
        _ammoToeTo.setValue(footX, footY - AMMO_TOE_RAY_LEN, footZ);
        _ammoToeCB.m_closestHitFraction = 1;
        _ammoToeCB.m_collisionObject = null;

        world.rayTest(_ammoToeFrom, _ammoToeTo, _ammoToeCB);

        if (_ammoToeCB.hasHit()) {
            var hitBody = Ammo.castObject(_ammoToeCB.m_collisionObject, Ammo.btCollisionObject);
            if (hitBody === playerBody) return 'unknown';
            var dist = _ammoToeCB.m_closestHitFraction * AMMO_TOE_RAY_LEN;
            return dist <= AMMO_TOE_THRESHOLD ? 'grounded' : 'airborne';
        }
        return 'airborne';
    }

    // 主线程每 100ms 调用一次（传入脚趾骨骼世界坐标）
    function updateToeDetection(leftX, leftY, leftZ, rightX, rightY, rightZ) {
        _ammoToeTime = performance.now();

        var l = _ammoCheckFoot(leftX, leftY, leftZ);
        var r = _ammoCheckFoot(rightX, rightY, rightZ);

        var lG = (l === 'grounded');
        var rG = (r === 'grounded');

        if (lG || rG) {
            _ammoToeResult.grounded = true;
            _ammoToeResult.airborne = false;
            _ammoToeResult.leftGrounded = lG;
            _ammoToeResult.rightGrounded = rG;
            return;
        }

        if (l === 'airborne' && r === 'airborne') {
            _ammoToeResult.grounded = false;
            _ammoToeResult.airborne = true;
            _ammoToeResult.leftGrounded = false;
            _ammoToeResult.rightGrounded = false;
            return;
        }
        // 不明确结果维持前一次状态（滞后保护）
    }

    function getToeDetectionResult() { return _ammoToeResult; }
    function getToeDetectionTime() { return _ammoToeTime; }

    // 兼容旧接口导出
    window.physicsModule = {
        world: world, // 动态更新
        groundBody: { position: { x: 0, y: 0, z: 0 }, quaternion: { setFromAxisAngle: function() {} } },
        groundMat: {},
        init: init,
        isReady: isReady,
        getWorld: getWorld,
        initPlayerCollider: initPlayerCollider,
        buildPlayerConvexHull: buildPlayerConvexHull,
        isPlayerHullDirty: isPlayerHullDirty,
        markPlayerHullDirty: markPlayerHullDirty,
        setPlayerHitCallback: setPlayerHitCallback,
        wakeUpBody: wakeUpBody,
        createPhysicsObject: createPhysicsObject,
        createRamp: createRamp,
        createConvexHullCollider: createTriangleMeshCollider,
        registerWalkable: registerWalkable,
        syncPlayerState: syncPlayerState,
        resetPhysicsBody: resetPhysicsBody,
        resolveCollisions: resolveCollisions,
        constrainToGround: constrainToGround,
        applyGravity: applyGravity,
        getIsGrounded: getIsGrounded,
        getVerticalVelocity: getVerticalVelocity,
        setVerticalVelocity: setVerticalVelocity,
        isJumpProtectionActive: isJumpProtectionActive,
        tryJump: tryJump,
        updateJumpState: updateJumpState,
        tryStepUp: tryStepUp,
        tryStepUpWithInput: tryStepUpWithInput,
        isStepUpActive: isStepUpActive,
        getStepUpHeight: getStepUpHeight,
        applyGroundAdhesion: applyGroundAdhesion,
        setPlayerPosition: setPlayerPosition,
        setPlayerVelocity: setPlayerVelocity,
        syncPlayerToModel: syncPlayerToModel,
        stepSimulation: stepSimulation,
        removeRigidBody: removeRigidBody,
        removePlayerBody: removePlayerBody,
        clearDynamicBodies: clearDynamicBodies,
        updateToeDetection: updateToeDetection,
        getToeDetectionResult: getToeDetectionResult,
        getToeDetectionTime: getToeDetectionTime,
        sceneObstacles: []
    };
})();