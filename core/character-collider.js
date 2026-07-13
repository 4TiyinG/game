// character-collider.js
var _boneBuffer = null;
var _lastShapeHash = 0;

function prepareColliderData(root) {
    var allIndices = [];
    var vertexOffset = 0;
    skinnedMeshes = [];
    var localPositions = [];
    var rawIndices = [];
    var worldMatrices = [];
    var vertexOffsets = [];
    var skinIdxList = [];
    var skinWList = [];
    root.traverse(function(child) {
        if (child.isMesh) {
            var geometry = child.geometry;
            var posAttr = geometry.attributes.position;
            var indexAttr = geometry.index;
            var skinIndex = geometry.attributes.skinIndex;
            var skinWeight = geometry.attributes.skinWeight;
            vertexOffsets.push(vertexOffset);
            for (var i = 0; i < posAttr.count; i++) {
                localPositions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
                if (skinIndex && skinWeight) {
                    skinIdxList.push(skinIndex.getX(i), skinIndex.getY(i), skinIndex.getZ(i), skinIndex.getW(i));
                    skinWList.push(skinWeight.getX(i), skinWeight.getY(i), skinWeight.getZ(i), skinWeight.getW(i));
                } else {
                    skinIdxList.push(0, 0, 0, 0);
                    skinWList.push(0, 0, 0, 0);
                }
            }
            var m = child.matrixWorld.elements;
            worldMatrices.push(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);
            if (indexAttr) {
                for (var j = 0; j < indexAttr.count; j++) {
                    rawIndices.push(indexAttr.getX(j) + vertexOffset);
                }
            } else {
                for (var k = 0; k < posAttr.count; k++) {
                    rawIndices.push(k + vertexOffset);
                }
            }
            vertexOffset += posAttr.count;
            if (child.skeleton) {
                skinnedMeshes.push(child);
            }
        }
    });
    vertexOffsets.push(vertexOffset);
    combinedIndices = rawIndices;

    worker.postMessage({
        type: 'init',
        positions: new Float32Array(localPositions),
        skinIndices: new Uint16Array(skinIdxList),
        skinWeights: new Float32Array(skinWList),
        combinedIndices: new Uint32Array(rawIndices),
        meshCount: skinnedMeshes.length,
        vertexOffsets: vertexOffsets
    });

    builderWorker.postMessage({
        type: 'build',
        localPositions: new Float32Array(localPositions),
        worldMatrices: new Float32Array(worldMatrices),
        vertexOffsets: vertexOffsets
    });
}

worker.onmessage = function(e) {
    var data = e.data;
    if (data.type === 'result') {
        var newVerts = data.vertices;
        deformedVertices = newVerts;
        if (onModelLoadedCallback) {
            onModelLoadedCallback(newVerts, combinedIndices);
        }
        isUpdating = false;
    }
};

builderWorker.onmessage = function(e) {
    var data = e.data;
    if (data.type === 'buildResult') {
        var worldVerts = data.vertices;
        if (onModelLoadedCallback) {
            onModelLoadedCallback(worldVerts, combinedIndices);
        }
    }
};

function syncColliderShape() {
    // No-op: collider shape handled by lightweight AABB in physics.js
}

function findHeadBone() {
    if (!model) return null;
    // Mixamo 头部骨骼常见命名：优先精确匹配，再回退到模糊匹配
    var headCandidates = [
        'mixamorigHead', 'mixamorigHead_1', 'mixamorigHead_2', 'mixamorigHead_3',
        'mixamorigHeadTop_End', 'mixamorigHeadTop_End_1', 'mixamorigHeadTop_End_2'
    ];
    var fallbackKeywords = ['head', 'Head', 'HEAD', 'Head_End', 'Head_M', 'DEF-Head'];

    for (var i = 0; i < skinnedMeshes.length; i++) {
        var mesh = skinnedMeshes[i];
        if (mesh.skeleton) {
            var bones = mesh.skeleton.bones;
            // 优先精确匹配 Mixamo 命名
            for (var k = 0; k < headCandidates.length; k++) {
                var candidate = headCandidates[k];
                for (var j = 0; j < bones.length; j++) {
                    if (bones[j].name === candidate) {
                        return bones[j];
                    }
                }
            }
            // 回退到模糊匹配
            for (var j = 0; j < bones.length; j++) {
                var bone = bones[j];
                var boneName = bone.name || '';
                for (var k = 0; k < fallbackKeywords.length; k++) {
                    if (boneName.indexOf(fallbackKeywords[k]) !== -1) {
                        return bone;
                    }
                }
            }
        }
    }
    return null;
}

// ===== Toe Bone System — 脚部骨骼查找（用于跳跃离地检测）=====
var leftToeBone = null;
var rightToeBone = null;
var toeBonesFound = false;

function findToeBones() {
    if (!model) return false;
    var found = 0;
    for (var i = 0; i < skinnedMeshes.length; i++) {
        var mesh = skinnedMeshes[i];
        if (!mesh.skeleton) continue;
        var bones = mesh.skeleton.bones;
        for (var j = 0; j < bones.length; j++) {
            var name = (bones[j].name || '');
            if (!leftToeBone && name.indexOf('mixamorigLeftToe_End') !== -1) {
                leftToeBone = bones[j];
                found++;
            }
            if (!rightToeBone && name.indexOf('mixamorigRightToe_End') !== -1) {
                rightToeBone = bones[j];
                found++;
            }
            if (found >= 2) break;
        }
        if (found >= 2) break;
    }
    if (found >= 2) toeBonesFound = true;
    return toeBonesFound;
}

function getToeWorldPos(targetVec) {
    if (!toeBonesFound) {
        if (!findToeBones()) return false;
    }
    if (!leftToeBone || !rightToeBone) return false;
    var leftPos = new THREE.Vector3();
    var rightPos = new THREE.Vector3();
    leftToeBone.getWorldPosition(leftPos);
    rightToeBone.getWorldPosition(rightPos);
    // 返回较低的那个脚趾位置（最低点）
    if (leftPos.y < rightPos.y) {
        targetVec.copy(leftPos);
    } else {
        targetVec.copy(rightPos);
    }
    return true;
}

function getToeWorldPositions(leftTarget, rightTarget) {
    if (!toeBonesFound) {
        if (!findToeBones()) return false;
    }
    if (!leftToeBone || !rightToeBone) return false;
    leftToeBone.getWorldPosition(leftTarget);
    rightToeBone.getWorldPosition(rightTarget);
    return true;
}

function hasToeBones() { return toeBonesFound; }

function getHeadWorldPos(targetVec) {
    if (!headBoneFound) return false;
    if (!headBone) {
        headBone = findHeadBone();
        if (headBone) headBoneFound = true;
        else return false;
    }
    headBone.getWorldPosition(targetVec);
    return true;
}

function setHeadRotation(pitch) {
    if (!headBoneFound) return;
    if (!headBone) {
        headBone = findHeadBone();
        if (headBone) headBoneFound = true;
        else return;
    }
    var clampedPitch = Math.max(-0.8, Math.min(0.8, pitch));
    headBone.rotation.x = clampedPitch;
}

// ===== FP Head Bone — two eye bones anchor for precise first-person camera =====
var fpHeadBone = null;   // kept for backward compat, not used for FP
var fpLeftEyeBone = null;  // Bone004_11
var fpRightEyeBone = null; // Bone003_10
var fpHeadBoneFound = false;

// Temp vectors for FP eye calculations
var _fpLeftPos = new THREE.Vector3();
var _fpRightPos = new THREE.Vector3();
var _fpAvgQuat = new THREE.Quaternion();

// Reset FP head bone when model changes
function resetFPHeadBone() {
    fpHeadBone = null;
    fpLeftEyeBone = null;
    fpRightEyeBone = null;
    fpHeadBoneFound = false;
    // 【修复】同时重置眼睛骨骼和隐藏部件缓存，防止模型切换后缓存失效
    leftEyeBone = null;
    rightEyeBone = null;
    fpHiddenPart = null;
    eyeBonesFound = false;
}

function findFPHeadBone() {
    if (!model) return false;
    var found = 0;
    for (var i = 0; i < skinnedMeshes.length; i++) {
        var mesh = skinnedMeshes[i];
        if (!mesh.skeleton) continue;
        var bones = mesh.skeleton.bones;
        for (var j = 0; j < bones.length; j++) {
            var name = (bones[j].name || '');
            if (!fpLeftEyeBone && name.indexOf('Bone004_11') !== -1) {
                fpLeftEyeBone = bones[j];
                found++;
            }
            if (!fpRightEyeBone && name.indexOf('Bone003_10') !== -1) {
                fpRightEyeBone = bones[j];
                found++;
            }
            if (found >= 2) break;
        }
        if (found >= 2) break;
    }
    if (found >= 2) fpHeadBoneFound = true;
    return fpHeadBoneFound;
}

function getFPHeadWorldPos(targetVec) {
    if (!fpHeadBoneFound) { if (!findFPHeadBone()) return false; }
    if (!fpLeftEyeBone || !fpRightEyeBone) return false;
    fpLeftEyeBone.getWorldPosition(_fpLeftPos);
    fpRightEyeBone.getWorldPosition(_fpRightPos);
    targetVec.lerpVectors(_fpLeftPos, _fpRightPos, 0.5);
    return true;
}

function getFPHeadWorldQuaternion(targetQuat) {
    if (!fpHeadBoneFound) { if (!findFPHeadBone()) return false; }
    if (!fpLeftEyeBone || !fpRightEyeBone) return false;
    var ql = new THREE.Quaternion();
    var qr = new THREE.Quaternion();
    fpLeftEyeBone.getWorldQuaternion(ql);
    fpRightEyeBone.getWorldQuaternion(qr);
    ql.slerp(qr, 0.5);
    targetQuat.copy(ql);
    return true;
}

function hasFPHeadBone() { return fpHeadBoneFound; }

// ===== Eye Bone System (Object_15 = left eye, Object_19 = right eye) =====
var leftEyeBone = null;
var rightEyeBone = null;
var eyeBonesFound = false;
var fpHiddenPart = null; // Object_13 — hidden in first-person

function findEyeBones() {
    if (!model) return false;
    var found = 0;
    for (var i = 0; i < skinnedMeshes.length; i++) {
        var mesh = skinnedMeshes[i];
        if (!mesh.skeleton) continue;
        var bones = mesh.skeleton.bones;
        for (var j = 0; j < bones.length; j++) {
            var bone = bones[j];
            var name = (bone.name || '');
            if (!leftEyeBone && name.indexOf('Object_15') !== -1) {
                leftEyeBone = bone;
                found++;
            }
            if (!rightEyeBone && name.indexOf('Object_19') !== -1) {
                rightEyeBone = bone;
                found++;
            }
            if (!fpHiddenPart && name.indexOf('Object_13') !== -1) {
                fpHiddenPart = bone;
            }
            if (found >= 2 && fpHiddenPart) break;
        }
        if (found >= 2 && fpHiddenPart) break;
    }
    if (found >= 2) eyeBonesFound = true;
    return eyeBonesFound;
}

function getEyeCenterWorldPos(targetVec) {
    if (!eyeBonesFound) {
        if (!findEyeBones()) return false;
    }
    if (!leftEyeBone || !rightEyeBone) return false;
    var leftPos = new THREE.Vector3();
    var rightPos = new THREE.Vector3();
    leftEyeBone.getWorldPosition(leftPos);
    rightEyeBone.getWorldPosition(rightPos);
    targetVec.lerpVectors(leftPos, rightPos, 0.5);
    return true;
}

function setEyeRotation(yaw, pitch) {
    if (!eyeBonesFound) {
        if (!findEyeBones()) return;
    }
    var clampedPitch = Math.max(-0.5, Math.min(0.5, pitch));
    var clampedYaw = Math.max(-0.4, Math.min(0.4, yaw));
    // Eye rotation relative to head bone
    if (leftEyeBone) {
        leftEyeBone.rotation.x = clampedPitch;
        leftEyeBone.rotation.y = clampedYaw;
    }
    if (rightEyeBone) {
        rightEyeBone.rotation.x = clampedPitch;
        rightEyeBone.rotation.y = clampedYaw;
    }
}

function hasEyeBones() { return eyeBonesFound; }

function setFPPartHidden(hidden) {
    // 【修复】每次调用时重新查找 Object_13，防止模型切换后缓存失效
    // 旧逻辑只在第一次缓存，模型重新加载后缓存指向旧节点，新模型部件无法正确显隐
    fpHiddenPart = null;
    if (model) {
        model.traverse(function(c) {
            if (!fpHiddenPart && c.name && c.name.indexOf('Object_13') !== -1) fpHiddenPart = c;
        });
    }
    if (fpHiddenPart) fpHiddenPart.visible = !hidden;
}

function resetFaceBoneRotations() {
    // 【修复】视角切换时重置头部和眼睛骨骼旋转，避免残留旋转与动画混合器冲突
    if (headBoneFound && headBone) {
        headBone.rotation.x = 0;
    }
    if (eyeBonesFound) {
        if (leftEyeBone) {
            leftEyeBone.rotation.x = 0;
            leftEyeBone.rotation.y = 0;
        }
        if (rightEyeBone) {
            rightEyeBone.rotation.x = 0;
            rightEyeBone.rotation.y = 0;
        }
    }
}
