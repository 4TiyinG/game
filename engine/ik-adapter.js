// ik-adapter.js — 脚部 IK 系统项目适配器
// 将项目的 model/physics/animation 状态包装为 LegIKController 所需的 player 接口
(function() {
    var legIK = null;
    var playerMock = null;
    var mockCapsule = null;
    var groundPlane = null;
    var colliderMeshes = [];
    var ikEnabled = true;
    var debugEnabled = false;
    var soleSampleDebugEnabled = false;
    var preIKModelY = 0; // IK 修改前的模型 Y（用于下帧 restore 撤销 meshStepOffset）

    // Mixamo 标准骨骼命名（与 demo 一致）
    var skeletonConfig = {
        hips: "mixamorigHips",
        legs: {
            left: {
                upper: "mixamorigLeftUpLeg",
                lower: "mixamorigLeftLeg",
                foot: "mixamorigLeftFoot",
                toe: "mixamorigLeftToeBase",
            },
            right: {
                upper: "mixamorigRightUpLeg",
                lower: "mixamorigRightLeg",
                foot: "mixamorigRightFoot",
                toe: "mixamorigRightToeBase",
            },
        },
        arms: {
            left: {
                upper: "mixamorigLeftArm",
                lower: "mixamorigLeftForeArm",
                hand: "mixamorigLeftHand",
            },
            right: {
                upper: "mixamorigRightArm",
                lower: "mixamorigRightForeArm",
                hand: "mixamorigRightHand",
            },
        },
    };

    // 创建不可见地面平面供 IK 射线检测
    function ensureGroundPlane() {
        if (groundPlane) return groundPlane;
        var geo = new THREE.PlaneGeometry(200, 200);
        groundPlane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
        groundPlane.rotation.x = -Math.PI / 2;
        groundPlane.position.set(0, 0, 0);
        groundPlane.updateMatrixWorld(true);
        scene.add(groundPlane);
        console.log('[legIK] 不可见地面平面已创建 (200x200, y=0)');
        return groundPlane;
    }

    function isPlayerDescendant(obj) {
        var p = obj;
        while (p) {
            if (p === model) return true;
            p = p.parent;
        }
        return false;
    }

    function refreshColliders() {
        if (!scene) return;
        ensureGroundPlane();
        colliderMeshes = [];
        scene.traverse(function(obj) {
            if (!obj.isMesh) return;
            if (isPlayerDescendant(obj)) return;
            if (obj.isLine || obj.isLineSegments) return;
            // 性能优化：跳过 PC 模型的原始子 mesh（已禁用 raycast，避免 IK 射线检测高面数网格）
            if (obj.userData && obj.userData.isPCChild) return;
            colliderMeshes.push(obj);
        });
        // 确保 PC 简化碰撞体在列表中
        if (window.pcIKCollider && colliderMeshes.indexOf(window.pcIKCollider) === -1) {
            colliderMeshes.push(window.pcIKCollider);
        }
        if (groundPlane && colliderMeshes.indexOf(groundPlane) === -1) {
            colliderMeshes.push(groundPlane);
        }
        if (legIK) {
            legIK.collider = colliderMeshes;
        }
    }

    function createMockCapsule() {
        var cap = new THREE.Object3D();
        // 胶囊尺寸匹配 demo 比例：胶囊底部（segment end）在脚底上方 0.5
        // 这样 getCapsuleBottomY() 返回 model.y + 0.5，高于脚底地面命中点，
        // 避免 hasFootHitAboveCapsuleBottom 误判导致 IK 被完全禁用
        cap.capsuleInfo = {
            radius: 0.3,
            segment: new THREE.Line3(
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, -0.5, 0)
            )
        };
        return cap;
    }

    function createPlayerMock() {
        return {
            playerModel: model,
            playerCapsule: mockCapsule,
            playerIsOnGround: true,
            collider: colliderMeshes,
            currentDelta: 0,
            animation: {
                state: null,
                clips: []
            },
            getCurrentPlayerAnimationName: function() {
                if (typeof core === 'undefined' || !core.getCurrentActionIndex) return '';
                var idx = core.getCurrentActionIndex();
                if (idx >= 0 && idx < actions.length) {
                    return actions[idx]._clip ? (actions[idx]._clip.name || '') : '';
                }
                return '';
            }
        };
    }

    function init() {
        if (!model || !actions || actions.length === 0) {
            console.warn('[legIK] 模型或动画未就绪，跳过 IK 初始化');
            return;
        }

        destroy();
        ensureGroundPlane();

        mockCapsule = createMockCapsule();
        mockCapsule.position.set(model.position.x, model.position.y + 1.0, model.position.z);
        mockCapsule.updateMatrixWorld(true);

        refreshColliders();

        playerMock = createPlayerMock();

        var clips = [];
        for (var i = 0; i < actions.length; i++) {
            if (actions[i]._clip) clips.push(actions[i]._clip);
        }
        playerMock.animation.clips = clips;

        if (typeof core !== 'undefined' && core.getCurrentActionIndex) {
            var idx = core.getCurrentActionIndex();
            if (idx >= 0 && idx < actions.length) {
                playerMock.animation.state = actions[idx];
            }
        }

        try {
            legIK = new LegIKController(playerMock, {
                collider: colliderMeshes,
                scene: scene,
                skeleton: skeletonConfig,
                soleHalfWidth: 0.05,    // 脚底左右采样半宽（适配全尺寸模型）
                soleHeelExtend: 0.03,   // 脚跟延伸距离
                soleToeExtend: 0.06,    // 脚尖延伸距离
                soleOffsetY: 0.068,     // 脚底采样点下移量（趾骨到地面距离，站立时toeY≈0.068）
                maxMeshStepDrop: 0.25   // 台阶视觉补偿最大下拽（覆盖0.2台阶高度+余量）
            });
            legIK.enabled = ikEnabled;
            legIK.setDebugEnabled(debugEnabled);
            legIK.setSoleSampleDebugEnabled(soleSampleDebugEnabled);
            console.log('[legIK] ✅ 脚部 IK 系统已初始化 (enabled=' + ikEnabled + ')');
        } catch(e) {
            console.error('[legIK] 初始化失败:', e);
            legIK = null;
        }
    }

    function restore() {
        if (legIK && ikEnabled) {
            try { legIK.restore(); } catch(e) {}
        }
        // 撤销上一帧 IK 对 model.position.y 的 meshStepOffset 修改
        // 防止 meshBaseY 累积反馈（IK 设 model.y = baseY + offset，下帧 baseY 不能带 offset）
        if (model && ikEnabled) {
            model.position.y = preIKModelY;
            model.updateMatrixWorld(true);
        }
    }

    function update(delta) {
        if (!legIK || !model || !ikEnabled) return;

        // 保存 IK 修改前的模型 Y（物理/动画给出的真实位置）
        // 下帧 restore() 会用这个值撤销 IK 的 meshStepOffset，打破 Y 累积反馈
        preIKModelY = model.position.y;

        // 同步胶囊位置：胶囊中心在模型上方 1.0，段底端在模型上方 0.5
        // 这样 getCapsuleBottomY() 返回 model.y + 0.5，高于脚底地面命中点
        mockCapsule.position.set(model.position.x, model.position.y + 1.0, model.position.z);
        mockCapsule.updateMatrixWorld(true);

        // 着地状态：物理模式开时用物理检测，关时默认着地（模型在地面 y=0）
        var grounded = true;
        if (typeof physicsMode !== 'undefined' && physicsMode &&
            typeof physicsModule !== 'undefined' && physicsModule.isReady &&
            physicsModule.isReady() && physicsModule.getIsGrounded) {
            grounded = physicsModule.getIsGrounded();
        }
        playerMock.playerIsOnGround = grounded;

        // 更新动画状态
        if (typeof core !== 'undefined' && core.getCurrentActionIndex) {
            var idx = core.getCurrentActionIndex();
            if (idx >= 0 && idx < actions.length) {
                playerMock.animation.state = actions[idx];
            }
        }
        playerMock.currentDelta = delta;

        // 仅更新模型自身矩阵树，避免全场景 updateMatrixWorld 开销
        if (model) model.updateMatrixWorld(true);
        if (playerMock && playerMock.mesh) playerMock.mesh.updateMatrixWorld(true);

        // meshBaseY 使用 IK 修改前的真实 Y，减去物理margin补偿（模型实际比地面高约0.04）
        legIK.meshBaseY = preIKModelY - 0.04;

        try {
            legIK.update(delta);
            legIK.updateSoleSampleDebug();
        } catch(e) {
            console.error('[legIK] 更新失败:', e);
        }
    }

    function destroy() {
        if (legIK) {
            try { legIK.restore(); } catch(e) {}
            legIK = null;
        }
        playerMock = null;
    }

    function setEnabled(enabled) {
        ikEnabled = enabled;
        if (legIK) {
            legIK.enabled = enabled;
            if (!enabled) {
                try { legIK.restore(); } catch(e) {}
                legIK.setDebugEnabled(false);
            } else {
                legIK.setDebugEnabled(debugEnabled);
                legIK.setSoleSampleDebugEnabled(soleSampleDebugEnabled);
            }
        }
    }

    function setDebugEnabled(enabled) {
        debugEnabled = enabled;
        if (legIK && ikEnabled) legIK.setDebugEnabled(enabled);
    }

    function setSoleSampleDebugEnabled(enabled) {
        soleSampleDebugEnabled = enabled;
        if (legIK && ikEnabled) legIK.setSoleSampleDebugEnabled(enabled);
    }

    function isEnabled() { return ikEnabled; }
    function isDebugEnabled() { return debugEnabled; }
    function isSoleSampleDebugEnabled() { return soleSampleDebugEnabled; }

    // 创建 IK 控制按钮并添加到 UI
    function createIKControls() {
        if (document.getElementById('ik-toggle-btn')) return; // 已存在

        var footer = document.querySelector('.ui-footer, .footer, [class*="footer"]');
        if (!footer) {
            // 回退：尝试找按钮容器
            footer = document.querySelector('.control-bar, .button-bar, .controls');
        }
        if (!footer) {
            // 再回退：直接添加到 body
            footer = document.body;
        }

        // IK 开关按钮
        var ikBtn = document.createElement('button');
        ikBtn.id = 'ik-toggle-btn';
        ikBtn.className = 'ik-btn active';
        ikBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M12 7v6M8 9l4-2 4 2M12 13l-3 8M12 13l3 8"/></svg>';
        ikBtn.title = 'IK';
        ikBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:24px;height:24px;min-width:24px;min-height:24px;padding:0;border:1px solid transparent;border-radius:5px;background:rgba(45,208,110,0.18);color:var(--green,#2dd06e);cursor:pointer;transition:all 0.18s cubic-bezier(0.4,0,0.2,1);flex:none;touch-action:manipulation;-webkit-user-select:none;user-select:none;';
        ikBtn.addEventListener('mousedown', function() { ikBtn.style.transform = 'scale(0.9)'; });
        ikBtn.addEventListener('mouseup', function() { ikBtn.style.transform = ''; });
        ikBtn.addEventListener('mouseleave', function() { ikBtn.style.transform = ''; });
        ikBtn.addEventListener('click', function() {
            ikEnabled = !ikEnabled;
            setEnabled(ikEnabled);
            ikBtn.classList.toggle('active', ikEnabled);
            ikBtn.style.background = ikEnabled ? 'rgba(45,208,110,0.18)' : 'rgba(120,120,120,0.15)';
            ikBtn.style.color = ikEnabled ? 'var(--green,#2dd06e)' : 'var(--text-3,#64748b)';
            ikBtn.style.borderColor = ikEnabled ? 'rgba(45,208,110,0.5)' : 'transparent';
            console.log('[legIK] IK ' + (ikEnabled ? '已启用' : '已禁用'));
        });
        footer.appendChild(ikBtn);

        // IK 调试按钮
        var dbgBtn = document.createElement('button');
        dbgBtn.id = 'ik-debug-btn';
        dbgBtn.className = 'ik-btn';
        dbgBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6l-4 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-4-8V2"/><path d="M7 2h10"/><path d="M7 14h10"/></svg>';
        dbgBtn.title = 'IK调试';
        dbgBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:24px;height:24px;min-width:24px;min-height:24px;padding:0;border:1px solid transparent;border-radius:5px;background:rgba(120,120,120,0.15);color:var(--text-3,#64748b);cursor:pointer;transition:all 0.18s cubic-bezier(0.4,0,0.2,1);flex:none;touch-action:manipulation;-webkit-user-select:none;user-select:none;margin-left:3px;';
        dbgBtn.addEventListener('mousedown', function() { dbgBtn.style.transform = 'scale(0.9)'; });
        dbgBtn.addEventListener('mouseup', function() { dbgBtn.style.transform = ''; });
        dbgBtn.addEventListener('mouseleave', function() { dbgBtn.style.transform = ''; });
        dbgBtn.addEventListener('click', function() {
            debugEnabled = !debugEnabled;
            if (debugEnabled) soleSampleDebugEnabled = true;
            setDebugEnabled(debugEnabled);
            setSoleSampleDebugEnabled(debugEnabled);
            dbgBtn.classList.toggle('active', debugEnabled);
            dbgBtn.style.background = debugEnabled ? 'rgba(255,152,0,0.18)' : 'rgba(120,120,120,0.15)';
            dbgBtn.style.color = debugEnabled ? '#ff9800' : 'var(--text-3,#64748b)';
            dbgBtn.style.borderColor = debugEnabled ? 'rgba(255,152,0,0.5)' : 'transparent';
            console.log('[legIK] 调试可视化 ' + (debugEnabled ? '已开启' : '已关闭'));
        });
        footer.appendChild(dbgBtn);
    }

    window.legIKModule = {
        init: init,
        restore: restore,
        update: update,
        destroy: destroy,
        refreshColliders: refreshColliders,
        setEnabled: setEnabled,
        setDebugEnabled: setDebugEnabled,
        setSoleSampleDebugEnabled: setSoleSampleDebugEnabled,
        isEnabled: isEnabled,
        isDebugEnabled: isDebugEnabled,
        isSoleSampleDebugEnabled: isSoleSampleDebugEnabled,
        createIKControls: createIKControls,
        getIK: function() { return legIK; }
    };
})();
