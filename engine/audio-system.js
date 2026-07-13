// audio-system.js
// 简易音频系统：支持 BGM、音效、3D 空间音

var AudioSystem = (function() {
    var ctx = null;
    var bgmGain = null;
    var sfxGain = null;
    var bgmSource = null;
    var bgmBuffer = null;
    var isMuted = false;
    var bgmVolume = 0.6;
    var sfxVolume = 0.8;

    // 3D 空间音
    var spatialEnabled = true;
    var listenerPos = { x: 0, y: 0, z: 0 };
    var listenerForward = { x: 0, y: 0, z: -1 };
    var listenerUp = { x: 0, y: 1, z: 0 };
    var pannerRefs = [];

    function ensureContext() {
        if (!ctx) {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
            bgmGain = ctx.createGain();
            bgmGain.gain.value = bgmVolume;
            bgmGain.connect(ctx.destination);

            sfxGain = ctx.createGain();
            sfxGain.gain.value = sfxVolume;
            sfxGain.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') {
            ctx.resume();
        }
        return ctx;
    }

    function loadBuffer(url, callback) {
        ensureContext();
        if (!ctx) return;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function() {
            if (xhr.status === 200) {
                ctx.decodeAudioData(xhr.response, function(buffer) {
                    bgmBuffer = buffer;
                    if (callback) callback(buffer);
                }, function(err) {
                    console.warn('音频解码失败:', err);
                });
            }
        };
        xhr.onerror = function() {
            console.warn('音频下载失败:', url);
        };
        xhr.send();
    }

    function playBGM(url, options) {
        options = options || {};
        stopBGM();
        var ac = ensureContext();
        if (!ac || !url) return;
        if (options.buffer) {
            playBufferBGM(options.buffer);
            return;
        }
        loadBuffer(url, function(buffer) {
            playBufferBGM(buffer);
        });
    }

    function playBufferBGM(buffer) {
        if (!ctx || !buffer) return;
        stopBGM();
        bgmSource = ctx.createBufferSource();
        bgmSource.buffer = buffer;
        bgmSource.loop = true;
        bgmSource.connect(bgmGain);
        bgmSource.start(0);
    }

    function stopBGM() {
        if (bgmSource) {
            try { bgmSource.stop(); } catch(e) {}
            bgmSource.disconnect();
            bgmSource = null;
        }
    }

    function playSFX(url) {
        var ac = ensureContext();
        if (!ac || !url) return;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function() {
            if (xhr.status === 200) {
                ctx.decodeAudioData(xhr.response, function(buffer) {
                    playBufferSFX(buffer);
                }, function(err) {
                    console.warn('音效解码失败:', err);
                });
            }
        };
        xhr.onerror = function() {
            console.warn('音效下载失败:', url);
        };
        xhr.send();
    }

    function playBufferSFX(buffer) {
        if (!ctx || !buffer) return;
        var source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(sfxGain);
        source.start(0);
    }

    function setMuted(muted) {
        isMuted = muted;
        if (!bgmGain || !sfxGain) return;
        if (muted) {
            bgmGain.gain.value = 0;
            sfxGain.gain.value = 0;
        } else {
            bgmGain.gain.value = bgmVolume;
            sfxGain.gain.value = sfxVolume;
        }
    }

    function toggleMute() {
        setMuted(!isMuted);
        return isMuted;
    }

    function setBGMVolume(v) {
        bgmVolume = Math.max(0, Math.min(1, v));
        if (bgmGain && !isMuted) bgmGain.gain.value = bgmVolume;
    }

    function setSFXVolume(v) {
        sfxVolume = Math.max(0, Math.min(1, v));
        if (sfxGain && !isMuted) sfxGain.gain.value = sfxVolume;
    }

    function getMuted() {
        return isMuted;
    }

    // ===== 3D 空间音 =====
    function setSpatialEnabled(enabled) {
        spatialEnabled = enabled;
    }

    function setListener(x, y, z, forwardX, forwardY, forwardZ, upX, upY, upZ) {
        listenerPos.x = x;
        listenerPos.y = y;
        listenerPos.z = z;
        listenerForward.x = forwardX;
        listenerForward.y = forwardY;
        listenerForward.z = forwardZ;
        listenerUp.x = upX;
        listenerUp.y = upY;
        listenerUp.z = upZ;

        if (!ctx) return;
        try {
            var listener = ctx.listener;
            if (listener.positionX) {
                listener.positionX.value = x;
                listener.positionY.value = y;
                listener.positionZ.value = z;
                listener.forwardX.value = forwardX;
                listener.forwardY.value = forwardY;
                listener.forwardZ.value = forwardZ;
                listener.upX.value = upX;
                listener.upY.value = upY;
                listener.upZ.value = upZ;
            } else if (listener.setPosition) {
                listener.setPosition(x, y, z);
                listener.setOrientation(forwardX, forwardY, forwardZ, upX, upY, upZ);
            }
        } catch (e) {
            // 部分浏览器 listener 可能不可写，忽略
        }
    }

    function createSpatialSource(buffer) {
        var ac = ensureContext();
        if (!ac || !buffer) return null;
        var source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;

        var panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1;
        panner.maxDistance = 20;
        panner.rolloffFactor = 1;
        panner.coneInnerAngle = 360;
        panner.coneOuterAngle = 360;
        panner.coneOuterGain = 0;

        source.connect(panner);
        panner.connect(ctx.destination);
        source.start(0);

        var ref = { source: source, panner: panner, buffer: buffer };
        pannerRefs.push(ref);
        return ref;
    }

    function updateSpatialSource(ref, x, y, z) {
        if (!ref || !ref.panner) return;
        try {
            if (ref.panner.positionX) {
                ref.panner.positionX.value = x;
                ref.panner.positionY.value = y;
                ref.panner.positionZ.value = z;
            } else if (ref.panner.setPosition) {
                ref.panner.setPosition(x, y, z);
            }
        } catch (e) {
            // ignore
        }
    }

    function disposeSpatialSource(ref) {
        if (!ref) return;
        try { ref.source.stop(); } catch(e) {}
        try { ref.source.disconnect(); } catch(e) {}
        try { ref.panner.disconnect(); } catch(e) {}
        var idx = pannerRefs.indexOf(ref);
        if (idx !== -1) pannerRefs.splice(idx, 1);
    }

    return {
        ensureContext: ensureContext,
        playBGM: playBGM,
        stopBGM: stopBGM,
        playSFX: playSFX,
        setMuted: setMuted,
        toggleMute: toggleMute,
        setBGMVolume: setBGMVolume,
        setSFXVolume: setSFXVolume,
        getMuted: getMuted,
        setSpatialEnabled: setSpatialEnabled,
        setListener: setListener,
        createSpatialSource: createSpatialSource,
        updateSpatialSource: updateSpatialSource,
        disposeSpatialSource: disposeSpatialSource
    };
})();
