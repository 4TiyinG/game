// character-anim.js — 动画混合系统
// 参考实现：基于时间的手动权重插值 + ease-in-out 缓动
// 核心优势：过渡自然、可控、支持立即切换和渐变切换

// ============================================================
// 过渡系统状态
// ============================================================
var _transition = {
    active: false,
    startTime: 0,       // performance.now() 时间戳
    duration: 0,         // 过渡总时长 (ms)
    fromAction: null,    // 源动作（淡出）
    toAction: null,      // 目标动作（淡入）
    fromIndex: -1,
    toIndex: -1
};

// 默认过渡时长（秒）
var DEFAULT_TRANSITION = 0.35;
// 摇杆移动动画过渡时长（秒）— 更快响应
var JOYSTICK_TRANSITION = 0.18;
// 动作打断过渡时长（秒）— 用于动作→移动的平滑混合
var INTERRUPT_TRANSITION = 0.2;

// ============================================================
// 辅助：安全终止当前过渡（清理权重残留）
// ============================================================
function _safeEndTransition() {
    if (!_transition.active) return;
    // 强制将过渡中尚未完成的权重拉到最终状态
    if (_transition.toAction) {
        _transition.toAction.setEffectiveWeight(1);
    }
    if (_transition.fromAction) {
        _transition.fromAction.setEffectiveWeight(0);
        _transition.fromAction.stop();
    }
    _transition.active = false;
}

// ============================================================
// 核心：带过渡的动画播放
// ============================================================

function playAnimation(index, transitionDuration) {
    if (!mixer || actions.length === 0) return;
    if (index === currentActionIndex) return;
    if (index < 0 || index >= actions.length) return;

    var fromAction = actions[currentActionIndex];
    var toAction = actions[index];

    // 先保存旧索引再更新 currentActionIndex
    var oldIndex = currentActionIndex;
    currentActionIndex = index;
    isAnimationPlaying = true;

    var duration = (transitionDuration !== undefined) ? transitionDuration : DEFAULT_TRANSITION;

    if (fromAction && fromAction !== toAction && duration > 0) {
        // ===== 交叉淡入淡出过渡 =====
        // 关键：先安全终止之前的过渡（如有），再开始新过渡
        _safeEndTransition();

        // 立即停止并归零所有非源、非目标的动画权重
        for (var i = 0; i < actions.length; i++) {
            if (actions[i] && actions[i] !== fromAction && actions[i] !== toAction) {
                actions[i].setEffectiveWeight(0);
                actions[i].stop();
                actions[i].enabled = false;
            }
        }

        // 1. 确保目标动作已启用
        toAction.enabled = true;
        toAction.setEffectiveTimeScale(1);
        toAction.setEffectiveWeight(0); // 从 0 开始，由过渡系统渐入
        // 时间同步：目标动画从源动画当前时间开始
        toAction.time = fromAction.time % toAction.getClip().duration;
        toAction.play();

        // 2. 确保源动作权重从 1 开始淡出
        fromAction.setEffectiveWeight(1);

        // 3. 设置过渡参数
        _transition.active = true;
        _transition.startTime = performance.now();
        _transition.duration = duration * 1000;
        _transition.fromAction = fromAction;
        _transition.toAction = toAction;
        _transition.fromIndex = oldIndex;
        _transition.toIndex = index;
    } else {
        // 无过渡或源=目标：直接切换
        _safeEndTransition();
        _stopAllExcept(toAction);
        toAction.enabled = true;
        toAction.setEffectiveTimeScale(1);
        toAction.setEffectiveWeight(1);
        toAction.play();
        _transition.active = false;
    }

    // 应用速度设置
    toAction.timeScale = animSettings.speed;

    // 更新 UI
    var name = toAction._clip.name || '动画 ' + (index + 1);
    DOM.selectedName.textContent = name;
    updateStatus(name, true);
    var items = DOM.listContainer.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
        if (i === index) items[i].classList.add('active');
        else items[i].classList.remove('active');
    }
    lastMappedAnimIndex = -1;
    lastMappedDirection = 'forward';
    isJoystickControlled = false;
}

/**
 * 立即切换动画（无过渡）
 */
function switchAnimation(index) {
    playAnimation(index, 0);
}

// ============================================================
// 核心增强：动作打断 → 立即切换到移动动画
// ============================================================

/**
 * 强制打断当前动作（跳跃/技能/受击/蹲下等），平滑过渡到移动动画
 * 无 cooldown 延迟，使用交叉淡入淡出实现流畅混合
 * 适用于：移动时打断跳跃、技能后摇、蹲下、受击等所有非移动状态
 */
function interruptToMovementAnim(direction) {
    if (direction === 'idle') return;
    if (!mixer || actions.length === 0) return;

    var targetName = animSettings.map[direction];
    var targetIndex = -1;
    if (targetName && actions) {
        targetIndex = getAnimIndexByName(targetName);
    }
    if (targetIndex === -1 || targetIndex >= actions.length) return;

    // 如果已经是同一个移动动画，只更新方向信息
    if (targetIndex === lastMappedAnimIndex) {
        lastMappedDirection = direction;
        var toAction = actions[targetIndex];
        if (toAction) {
            var clipSetting = animSettings.clip[direction];
            if (clipSetting && clipSetting.end > 0) {
                if (toAction.time < clipSetting.start || toAction.time > clipSetting.end) {
                    toAction.time = Math.min(Math.max(clipSetting.start, 0), toAction.getClip().duration);
                }
            }
        }
        return;
    }

    var fromAction = actions[currentActionIndex];
    var toAction = actions[targetIndex];
    var oldIndex = currentActionIndex;

    currentActionIndex = targetIndex;

    // 设置剪辑区间
    toAction.reset();
    var clipSetting = animSettings.clip[direction];
    if (clipSetting && clipSetting.end > 0) {
        toAction.time = Math.min(Math.max(clipSetting.start, 0), toAction.getClip().duration);
    }

    toAction.enabled = true;
    toAction.setEffectiveTimeScale(1);
    toAction.timeScale = animSettings.speed;

    if (fromAction && fromAction !== toAction) {
        // 安全终止之前的过渡
        _safeEndTransition();

        // 清理非源非目标的其它动画，只保留 from 和 to 两个进行交叉淡入淡出
        for (var i = 0; i < actions.length; i++) {
            if (actions[i] && actions[i] !== fromAction && actions[i] !== toAction) {
                actions[i].setEffectiveWeight(0);
                actions[i].stop();
                actions[i].enabled = false;
            }
        }

        // ===== 设置交叉淡入淡出过渡 =====
        toAction.setEffectiveWeight(0); // 从 0 开始渐入
        toAction.play();
        fromAction.setEffectiveWeight(1); // 从 1 开始淡出

        var transitionMs = INTERRUPT_TRANSITION * 1000; // 150ms 平滑混合

        _transition.active = true;
        _transition.startTime = performance.now();
        _transition.duration = transitionMs;
        _transition.fromAction = fromAction;
        _transition.toAction = toAction;
        _transition.fromIndex = oldIndex;
        _transition.toIndex = targetIndex;
    } else {
        _safeEndTransition();
        _stopAllExcept(toAction);
        toAction.setEffectiveWeight(1);
        toAction.play();
        _transition.active = false;
    }

    // —— 状态更新 ——
    lastMappedAnimIndex = targetIndex;
    lastMappedDirection = direction;
    lastSwitchTime = performance.now();
    isAnimationPlaying = true;
    isJoystickControlled = true;
}

// ============================================================
// 增强版：摇杆移动动画播放（支持可选 force 打断模式）
// ============================================================

/**
 * 播放摇杆映射的移动动画
 * 使用较短的过渡时间以快速响应
 *
 * @param {string} direction - 方向键名（forward/backward/left/right 等）
 * @param {boolean} [force=false] - 是否强制打断（用于动作→移动场景），跳过 cooldown
 */
function playJoystickAnim(direction, force) {
    if (direction === 'idle') return;
    var targetName = animSettings.map[direction];
    var targetIndex = -1;
    if (targetName && actions) {
        targetIndex = getAnimIndexByName(targetName);
    }
    if (targetIndex !== -1 && targetIndex < actions.length) {
        // 如果是同一动画，不切换（但更新方向用于循环逻辑）
        if (targetIndex === lastMappedAnimIndex) {
            lastMappedDirection = direction;
            return;
        }

        // 【优化】cooldown 仅对移动方向之间的快速切换生效
        // force=true 时（动作→移动打断场景）跳过 cooldown，实现零延迟响应
        if (!force) {
            var now = performance.now();
            if ((now - lastSwitchTime) < animSettings.cooldown * 1000) return;
        }

        var fromAction = actions[currentActionIndex];
        var toAction = actions[targetIndex];

        // 先保存旧索引，下面设置好过渡后再更新 currentActionIndex
        var oldIndex = currentActionIndex;

        // 设置剪辑区间
        toAction.reset();
        var clipSetting = animSettings.clip[direction];
        if (clipSetting && clipSetting.end > 0) {
            toAction.time = Math.min(Math.max(clipSetting.start, 0), toAction.getClip().duration);
        }

        toAction.enabled = true;
        toAction.setEffectiveTimeScale(1);
        toAction.timeScale = animSettings.speed;

        // 如果当前过渡还活跃，先安全终止
        _safeEndTransition();

        if (fromAction && fromAction !== toAction) {
            // 清理所有非源、非目标动画，防止多动画同时混合
            for (var i = 0; i < actions.length; i++) {
                if (actions[i] && actions[i] !== fromAction && actions[i] !== toAction) {
                    actions[i].setEffectiveWeight(0);
                    actions[i].stop();
                    actions[i].enabled = false;
                }
            }

            // 【优化】force 模式下使用极短过渡时间，实现快速打断
            var transitionMs = force ? INTERRUPT_TRANSITION * 1000 : JOYSTICK_TRANSITION * 1000;

            // 时间同步
            toAction.setEffectiveWeight(0); // 从 0 开始渐入
            toAction.time = fromAction.time % toAction.getClip().duration;
            toAction.play();
            fromAction.setEffectiveWeight(1); // 从 1 开始淡出

            // 设置过渡参数
            _transition.active = true;
            _transition.startTime = performance.now();
            _transition.duration = transitionMs;
            _transition.fromAction = fromAction;
            _transition.toAction = toAction;
            _transition.fromIndex = oldIndex;
            _transition.toIndex = targetIndex;
        } else {
            _safeEndTransition();
            _stopAllExcept(toAction);
            toAction.setEffectiveWeight(1);
            toAction.play();
            _transition.active = false;
        }

        currentActionIndex = targetIndex;
        lastMappedAnimIndex = targetIndex;
        lastMappedDirection = direction;
        lastSwitchTime = performance.now() || 0;
        isAnimationPlaying = true;
        isJoystickControlled = true;
    }
}

function toggleAnimation() {
    if (actions.length === 0) return;
    var nextIndex = (currentActionIndex + 1) % actions.length;
    playAnimation(nextIndex);
}

function resetJoystickControl() {
    lastMappedAnimIndex = -1;
    isJoystickControlled = false;
    lastSwitchTime = 0;
}

// ============================================================
// 每帧更新（在 main-loop.js 的 mixer.update 之前调用）
// ============================================================

/**
 * 更新动画过渡权重
 * 必须在 mixer.update(delta) 之前调用
 */
function updateTransitionWeights() {
    if (!_transition.active) return;

    var elapsed = performance.now() - _transition.startTime;
    var progress = Math.min(elapsed / _transition.duration, 1);

    // ease-in-out 缓动
    var eased = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;

    // 源淡出，目标淡入
    if (_transition.fromAction) {
        _transition.fromAction.setEffectiveWeight(1 - eased);
    }
    if (_transition.toAction) {
        _transition.toAction.setEffectiveWeight(eased);
    }

    // 过渡完成
    if (progress >= 1) {
        _transition.active = false;
        if (_transition.fromAction) {
            _transition.fromAction.setEffectiveWeight(0);
            _transition.fromAction.stop();
        }
        if (_transition.toAction) {
            _transition.toAction.setEffectiveWeight(1);
        }
    }
}

// ============================================================
// 辅助函数
// ============================================================

function _stopAllExcept(keepAction) {
    for (var i = 0; i < actions.length; i++) {
        if (actions[i] && actions[i] !== keepAction) {
            actions[i].setEffectiveWeight(0);
            actions[i].stop();
            actions[i].enabled = false;
        }
    }
}

/**
 * 混合器循环事件 — 源动画循环完成时加速过渡
 */
function _onMixerLoop(event) {
    if (!_transition.active) return;
    if (event.action === _transition.fromAction) {
        var remaining = _transition.duration - (performance.now() - _transition.startTime);
        if (remaining > 80) {
            _transition.startTime = performance.now() - (_transition.duration - remaining / 2);
        }
    }
}

// 在 mixer 创建后调用此函数注册循环事件监听
function setupMixerLoopListener() {
    if (mixer) {
        mixer.addEventListener('loop', _onMixerLoop);
    }
}
