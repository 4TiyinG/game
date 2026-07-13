// character-module.js
var _boneBuffer = null;
var _prevBoneHash = 0; // 【新增】记录上一帧的骨骼哈希值

window.coreModule = {
    setModelAndMixer: function(m, mx, act) {
        model = m;
        mixer = mx;
        actions = act;
        headBone = null;
        headBoneFound = false;
        resetFPHeadBone();
        if (isDefaultModel) {
            setTimeout(function() {
                headBone = findHeadBone();
                if (headBone) {
                    headBoneFound = true;
                    console.log('✅ 已成功定位头部骨骼: ' + headBone.name);
                } else {
                    console.warn('⚠️ 未找到头部骨骼，第一人称将回退到脚底+1.85高度');
                }
            }, 100);
        }
    },
    getModel: function() { return model; },
    getMixer: function() { return mixer; },
    getActions: function() { return actions; },
    setDeformedVerts: function(d) { deformedVertices = d; },
    getDeformedVerts: function() { return deformedVertices; },
    getCombinedIndices: function() { return combinedIndices; },
    getSkinnedMeshes: function() { return skinnedMeshes; },
    getIsUpdating: function() { return isUpdating; },
    setIsUpdating: function(val) { isUpdating = val; },
    getIsAnimationPlaying: function() { return isAnimationPlaying; },
    getIsJoystickControlled: function() { return isJoystickControlled; },
    setIsJoystickControlled: function(val) { isJoystickControlled = val; },
    getIdleAnimIndex: function() { return idleAnimIndex; },
    setIdleAnimIndex: function(index) { idleAnimIndex = index; },
    getCurrentActionIndex: function() { return currentActionIndex; },
    getAnimSettings: function() { return animSettings; },
    getLastMappedDirection: function() { return lastMappedDirection; },
    resetJoystickControl: resetJoystickControl,
    resetToDefaults: resetToDefaults,
    getAnimIndexByName: getAnimIndexByName,
    playAnimation: playAnimation,
    switchAnimation: switchAnimation,
    toggleAnimation: toggleAnimation,
    playJoystickAnim: playJoystickAnim,
    interruptToMovementAnim: interruptToMovementAnim,
    updateTransitionWeights: updateTransitionWeights,
    setupMixerLoopListener: setupMixerLoopListener,
    prepareColliderData: prepareColliderData,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    onModelLoadedCallback: function(cb) { onModelLoadedCallback = cb; },
    requestWorkerUpdate: function() {
        if (isUpdating || skinnedMeshes.length === 0 || !model) return;
        var firstMesh = skinnedMeshes[0];
        if (!firstMesh || !firstMesh.skeleton) return;
        var boneMatrices = firstMesh.skeleton.boneMatrices;
        
        // 【优化】删除骨骼矩阵哈希遍历（每帧 1600+ 次循环开销）
        // 改为直接基于动画播放状态判断：动画播放或摇杆活跃时才触发更新
        // 调用方已有 if (getIsAnimationPlaying() || joystickState.active) 条件守卫
        // 这里无需重复检测，直接提交更新
        
        isUpdating = true;
        if (!_boneBuffer || _boneBuffer.length !== boneMatrices.length) {
            _boneBuffer = new Float32Array(boneMatrices.length);
        }
        _boneBuffer.set(boneMatrices);
        worker.postMessage({ type: 'update', boneMatrices: _boneBuffer });
    },
    hasHeadBone: function() { return headBoneFound; },
    getHeadWorldPos: getHeadWorldPos,
    setHeadRotation: setHeadRotation,
    hasFPHeadBone: hasFPHeadBone,
    getFPHeadWorldPos: getFPHeadWorldPos,
    getFPHeadWorldQuaternion: getFPHeadWorldQuaternion,
    hasEyeBones: hasEyeBones,
    getEyeCenterWorldPos: getEyeCenterWorldPos,
    setEyeRotation: setEyeRotation,
    setFPPartHidden: setFPPartHidden,
    resetFaceBoneRotations: resetFaceBoneRotations,
    hasToeBones: hasToeBones,
    getToeWorldPos: getToeWorldPos,
    getToeWorldPositions: getToeWorldPositions,
    findToeBones: findToeBones,
    isDefaultModel: function() { return isDefaultModel; },
    setDefaultModel: function(v) { isDefaultModel = !!v; }
};