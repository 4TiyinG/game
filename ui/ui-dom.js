// ui-dom.js — UI 核心：DOM 引用缓存 + 状态更新 + 屏幕视频系统
(function() {
    var DOM = {
        fileInput: document.getElementById('file-input'),
        fileLabel: document.getElementById('file-label'),
        loadBtn: document.getElementById('load-btn'),
        statusText: document.getElementById('status-text'),
        overlay: document.getElementById('loading-overlay'),
        pickerWrapper: document.getElementById('anim-picker-wrapper'),
        pickerTrigger: document.getElementById('anim-picker-trigger'),
        selectedName: document.getElementById('selected-anim-name'),
        listContainer: document.getElementById('anim-list-container'),
        playIcon: document.getElementById('play-icon'),
        pauseIcon: document.getElementById('pause-icon'),
        joystickZone: document.getElementById('joystick-zone'),
        settingsBtn: document.getElementById('toggle-mapping') || document.getElementById('joystick-settings-btn'),
        settingsOverlay: document.getElementById('settings-overlay'),
        settingsClose: document.getElementById('settings-close'),
        toggleColliderBtn: document.getElementById('toggle-collider'),
        toggleDynamicBtn: document.getElementById('toggle-dynamic'),
        toggleWireframeBtn: document.getElementById('toggle-wireframe'),
        togglePhysicsBtn: document.getElementById('toggle-physics'),
        toggleTapBtn: document.getElementById('toggle-tap'),
        toggleScreenBtn: document.getElementById('toggle-screen'),
        // 视频 input 改为惰性创建，避免手机端预加载冻结
        screenVideoInput: null,
        screenVideoPlayer: document.getElementById('screen-video-player'),
    };
    
    var animSelectorIds = ['map-active'];

    function updateStatus(text, isPlaying, animName) {
        DOM.statusText.textContent = text;
        if (isPlaying && animName) {
            DOM.playIcon.style.display = 'none';
            DOM.pauseIcon.style.display = 'inline-block';
            DOM.statusText.textContent = '🎬 ' + animName;
        } else if (!isPlaying) {
            DOM.playIcon.style.display = 'block';
            DOM.pauseIcon.style.display = 'none';
        }
    }

    function updateAnimPicker(names, activeIndex) {
        DOM.listContainer.innerHTML = '';
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            var li = document.createElement('li');
            li.textContent = name;
            if (i === activeIndex) li.classList.add('active');
            (function(index) {
                li.addEventListener('click', function(e) {
                    e.stopPropagation();
                    if (window.__playAnimCallback) window.__playAnimCallback(index);
                    DOM.pickerWrapper.classList.remove('open');
                });
            })(i);
            DOM.listContainer.appendChild(li);
        }
    }

    function toggleSettingsOverlay(show) {
        if (show) {
            DOM.settingsOverlay.classList.add('open');
        } else {
            DOM.settingsOverlay.classList.remove('open');
        }
    }

    // ===== Screen Video System =====
    var screenVideoState = {
        mesh: null,
        texture: null,
        video: DOM.screenVideoPlayer,
        input: null, // 惰性创建
        active: false,
        worker: null,
        _currentBlobUrl: null,
        _prevCanplay: null,
        _prevError: null
    };

    // 惰性创建视频文件 input 元素，避免手机端页面加载时预初始化冻结
    function getOrCreateVideoInput() {
        if (screenVideoState.input) return screenVideoState.input;
        var input = document.createElement('input');
        input.type = 'file';
        input.id = 'screen-video-input';
        input.accept = 'video/*';
        input.style.display = 'none';
        input.addEventListener('change', function(e) {
            var file = e.target.files[0];
            if (file) handleScreenVideoFile(file);
            // 及时清理，避免重复选择同一文件不触发 change
            setTimeout(function() { input.value = ''; }, 100);
        });
        document.body.appendChild(input);
        screenVideoState.input = input;
        return input;
    }

    function initVideoWorker() {
        if (screenVideoState.worker) return;
        try {
            screenVideoState.worker = new Worker('./workers/video-reader.worker.js');
            screenVideoState.worker.onmessage = function(e) {
                var data = e.data;
                if (data.type === 'videoReady') {
                    var blob = new Blob([data.buffer], { type: data.fileType || 'video/mp4' });
                    var url = URL.createObjectURL(blob);
                    applyVideoSource(url, data.fileName);
                } else if (data.type === 'error') {
                    console.warn('视频 Worker 错误:', data.message);
                    updateStatus('❌ ' + data.message);
                }
            };
        } catch (err) {
            console.warn('视频 Worker 初始化失败，回退到主线程:', err);
            screenVideoState.worker = null;
        }
    }

    function openScreenVideoPicker() {
        var input = getOrCreateVideoInput();
        if (input) {
            // ===== 投机性预热：利用文件选择器弹出的 1~3 秒间隙初始化硬解码资源 =====
            preheatVideoResources();

            // 延迟到下一帧再调用 click()，避免当前事件循环中
            // 原生文件选择器弹窗瞬间冻结 RAF/渲染管线导致卡顿
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    input.click();
                });
            });
        }
    }

    // ===== 投机性预热：解码器 + 音频图 =====
    var _preheated = false;
    function preheatVideoResources() {
        if (_preheated) return;
        _preheated = true;

        try {
            // 1. 预热音频上下文（首次 resume 编译音频图，耗时 20-50ms）
            if (window.AudioSystem && AudioSystem.ensureContext) {
                var ctx = AudioSystem.ensureContext();
                if (ctx && ctx.state === 'suspended') {
                    ctx.resume().then(function() {
                        // 立即挂起，只编译图，不消耗电量
                        if (ctx.suspend) ctx.suspend();
                    }).catch(function() {});
                }
            }

            // 2. 预热视频解码器（创建不可见 video，只加载元数据）
            if (screenVideoState.video) {
                screenVideoState.video.preload = 'metadata';
                screenVideoState.video.muted = true;
                // 触发解码器固件加载（空 src 即可触发 load 事件）
                screenVideoState.video.load();
            }

            // 3. 预热 MediaElementSource（只创建节点，不连接）
            if (screenVideoState._audioCtx && !screenVideoState._sourceNode && screenVideoState.video) {
                try {
                    screenVideoState._sourceNode = screenVideoState._audioCtx.createMediaElementSource(screenVideoState.video);
                    // 不连接到 destination，避免噪声
                } catch (e) {
                    // 如果已创建过会报错，忽略
                }
            }
        } catch (e) {
            console.warn('[VideoPreheat] 预热失败（不影响后续流程）:', e);
        }
    }

    function applyVideoSource(url, fileName) {
        if (!screenVideoState.video) return;

        // 清理旧的 blob URL，避免内存泄漏和 ERR_ABORTED
        if (screenVideoState._currentBlobUrl) {
            URL.revokeObjectURL(screenVideoState._currentBlobUrl);
        }
        screenVideoState._currentBlobUrl = url;

        // 移除旧的事件监听，避免重复绑定
        if (screenVideoState._prevCanplay) {
            screenVideoState.video.removeEventListener('canplay', screenVideoState._prevCanplay);
        }
        if (screenVideoState._prevError) {
            screenVideoState.video.removeEventListener('error', screenVideoState._prevError);
        }

        // 重置视频状态
        screenVideoState.video.pause();
        screenVideoState.active = false;
        if (DOM.toggleScreenBtn) DOM.toggleScreenBtn.classList.remove('active');

        screenVideoState.video.loop = true;
        screenVideoState.video.muted = false;
        screenVideoState.video.playsInline = true;

        // 确保 Web Audio API 上下文已激活
        if (window.AudioSystem && AudioSystem.ensureContext) {
            AudioSystem.ensureContext();
        }

        // 设置新的视频源
        screenVideoState.video.src = url;
        screenVideoState.video.load();

        // 3D 音频设置（复用已有节点，避免重复创建 MediaElementSourceNode）
        // 注意：预热阶段已创建 _sourceNode，此处的音频连接在分帧恢复协议第3帧中完成
        if (window.AudioSystem && screenVideoState.mesh) {
            try {
                if (!screenVideoState._audioCtx) {
                    screenVideoState._audioCtx = AudioSystem.ensureContext();
                }
                if (screenVideoState._audioCtx && !screenVideoState._sourceNode) {
                    screenVideoState._sourceNode = screenVideoState._audioCtx.createMediaElementSource(screenVideoState.video);
                    screenVideoState._panner = screenVideoState._audioCtx.createPanner();
                    screenVideoState._panner.panningModel = 'HRTF';
                    screenVideoState._panner.distanceModel = 'inverse';
                    screenVideoState._panner.refDistance = 1;
                    screenVideoState._panner.maxDistance = 20;
                    screenVideoState._panner.rolloffFactor = 1;
                    screenVideoState._panner.coneInnerAngle = 360;
                    screenVideoState._panner.coneOuterAngle = 360;
                    screenVideoState._panner.coneOuterGain = 0;
                    // 不在此处连接，移至分帧恢复协议第3帧
                }
            } catch (e) {
                console.warn('视频 3D 音频接入失败，回退到普通播放:', e);
            }
        }

        // 等待视频就绪后，采用"分帧恢复协议"逐步启动，避免单帧内多资源争抢总线
        var onCanPlay = function() {
            screenVideoState.video.removeEventListener('canplay', onCanPlay);
            screenVideoState._prevCanplay = null;

            // ===== 分3帧恢复：音频 → 视频 → 纹理 =====
            var resumeStep = 0;
            function resumeBySteps() {
                resumeStep++;
                if (resumeStep === 1) {
                    // 第一帧：恢复音频上下文（此时无声音输出，仅唤醒）
                    if (screenVideoState._audioCtx && screenVideoState._audioCtx.state === 'suspended') {
                        screenVideoState._audioCtx.resume().then(function() {
                            requestAnimationFrame(resumeBySteps);
                        }).catch(function() {
                            requestAnimationFrame(resumeBySteps);
                        });
                    } else {
                        requestAnimationFrame(resumeBySteps);
                    }
                } else if (resumeStep === 2) {
                    // 第二帧：启动视频播放（此时解码器开始吐帧）
                    screenVideoState.video.play().then(function() {
                        requestAnimationFrame(resumeBySteps);
                    }).catch(function(err) {
                        console.warn('屏幕视频播放失败:', err);
                        screenVideoState.active = true;
                        if (DOM.toggleScreenBtn) DOM.toggleScreenBtn.classList.add('active');
                        // 仍然继续到第三帧创建纹理
                        requestAnimationFrame(resumeBySteps);
                    });
                } else if (resumeStep === 3) {
                    // 第三帧：才将音频连接到输出 + 创建纹理 + 挂载到模型
                    if (screenVideoState._sourceNode && screenVideoState._panner) {
                        try {
                            screenVideoState._sourceNode.connect(screenVideoState._panner);
                            screenVideoState._panner.connect(screenVideoState._audioCtx.destination);
                        } catch (e) {
                            // 已连接过会报错，忽略
                        }
                    }
                    applyScreenVideoTexture();
                    screenVideoState.active = true;
                    if (DOM.toggleScreenBtn) DOM.toggleScreenBtn.classList.add('active');

                    // ===== 启动低清缩略图前10帧注入 =====
                    startLowResWarmup();
                }
            }
            resumeBySteps(); // 启动分帧队列
        };
        screenVideoState._prevCanplay = onCanPlay;
        screenVideoState.video.addEventListener('canplay', onCanPlay);

        // 加载失败处理
        var onError = function() {
            screenVideoState.video.removeEventListener('error', onError);
            screenVideoState._prevError = null;
            console.warn('视频加载失败:', fileName, screenVideoState.video.error ? screenVideoState.video.error.message : '未知错误');
            updateStatus('❌ 视频加载失败，请检查格式');
        };
        screenVideoState._prevError = onError;
        screenVideoState.video.addEventListener('error', onError);
    }

    // 清理视频资源（取消上传/切换视频时调用）
    function disposeScreenVideo() {
        if (screenVideoState._currentBlobUrl) {
            URL.revokeObjectURL(screenVideoState._currentBlobUrl);
            screenVideoState._currentBlobUrl = null;
        }
        if (screenVideoState.texture) {
            screenVideoState.texture.dispose();
            screenVideoState.texture = null;
        }
        if (screenVideoState.video) {
            screenVideoState.video.pause();
            screenVideoState.video.src = '';
            screenVideoState.video.load();
        }
        // 清理着色器材质
        if (window.videoScreenShader) {
            videoScreenShader.disposeMaterial();
        }
        screenVideoState.active = false;
        if (DOM.toggleScreenBtn) DOM.toggleScreenBtn.classList.remove('active');
    }

    // ===== 滤镜面板控制 =====
    function toggleFilterOverlay(show) {
        var overlay = document.getElementById('filter-overlay');
        if (!overlay) return;
        if (show) {
            overlay.classList.add('open');
        } else {
            overlay.classList.remove('open');
        }
    }

    function syncSliderUI(state) {
        var brightnessSlider = document.getElementById('filter-brightness');
        var contrastSlider = document.getElementById('filter-contrast');
        var saturationSlider = document.getElementById('filter-saturation');
        var hueSlider = document.getElementById('filter-hue');
        if (brightnessSlider) {
            brightnessSlider.value = state.brightness;
            document.getElementById('filter-brightness-val').textContent = state.brightness.toFixed(2);
        }
        if (contrastSlider) {
            contrastSlider.value = state.contrast;
            document.getElementById('filter-contrast-val').textContent = state.contrast.toFixed(2);
        }
        if (saturationSlider) {
            saturationSlider.value = state.saturation;
            document.getElementById('filter-saturation-val').textContent = state.saturation.toFixed(2);
        }
        if (hueSlider) {
            hueSlider.value = state.hue;
            document.getElementById('filter-hue-val').textContent = state.hue.toFixed(2);
        }
    }

    function highlightActivePreset(index) {
        var btns = document.querySelectorAll('.filter-preset-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('active', parseInt(btns[i].getAttribute('data-index')) === index);
        }
    }

    function initFilterPanel() {
        // 动态生成预设按钮
        var presetsContainer = document.getElementById('filter-presets-scroll');
        if (presetsContainer && window.videoScreenShader) {
            var presets = videoScreenShader.getPresets();
            presetsContainer.innerHTML = '';
            for (var i = 0; i < presets.length; i++) {
                (function(idx, preset) {
                    var btn = document.createElement('button');
                    btn.className = 'filter-preset-btn';
                    btn.setAttribute('data-index', idx);
                    btn.textContent = preset.name;
                    if (idx === 0) btn.classList.add('active');
                    btn.addEventListener('click', function() {
                        videoScreenShader.applyPreset(idx);
                        var state = videoScreenShader.getFilterState();
                        syncSliderUI(state);
                        highlightActivePreset(idx);
                    });
                    presetsContainer.appendChild(btn);
                })(i, presets[i]);
            }
        }

        // 亮度
        var brightnessSlider = document.getElementById('filter-brightness');
        if (brightnessSlider) {
            brightnessSlider.addEventListener('input', function(e) {
                var val = parseFloat(e.target.value);
                document.getElementById('filter-brightness-val').textContent = val.toFixed(2);
                if (window.videoScreenShader) {
                    videoScreenShader.setFilterParam('brightness', val);
                }
                highlightActivePreset(-1);
            });
        }
        // 对比度
        var contrastSlider = document.getElementById('filter-contrast');
        if (contrastSlider) {
            contrastSlider.addEventListener('input', function(e) {
                var val = parseFloat(e.target.value);
                document.getElementById('filter-contrast-val').textContent = val.toFixed(2);
                if (window.videoScreenShader) {
                    videoScreenShader.setFilterParam('contrast', val);
                }
                highlightActivePreset(-1);
            });
        }
        // 饱和度
        var saturationSlider = document.getElementById('filter-saturation');
        if (saturationSlider) {
            saturationSlider.addEventListener('input', function(e) {
                var val = parseFloat(e.target.value);
                document.getElementById('filter-saturation-val').textContent = val.toFixed(2);
                if (window.videoScreenShader) {
                    videoScreenShader.setFilterParam('saturation', val);
                }
                highlightActivePreset(-1);
            });
        }
        // 色相
        var hueSlider = document.getElementById('filter-hue');
        if (hueSlider) {
            hueSlider.addEventListener('input', function(e) {
                var val = parseFloat(e.target.value);
                document.getElementById('filter-hue-val').textContent = val.toFixed(2);
                if (window.videoScreenShader) {
                    videoScreenShader.setFilterParam('hue', val);
                }
                highlightActivePreset(-1);
            });
        }
        // 重置按钮
        var resetBtn = document.getElementById('filter-reset-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', function() {
                if (!window.videoScreenShader) return;
                videoScreenShader.resetFilterParams();
                var state = videoScreenShader.getFilterState();
                syncSliderUI(state);
                highlightActivePreset(0);
            });
        }
        // 关闭按钮
        var closeBtn = document.getElementById('filter-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function() {
                toggleFilterOverlay(false);
            });
        }
        // 点击遮罩关闭
        var overlay = document.getElementById('filter-overlay');
        if (overlay) {
            overlay.addEventListener('click', function(e) {
                if (e.target === overlay) {
                    toggleFilterOverlay(false);
                }
            });
        }
    }

    function handleScreenVideoFile(file) {
        if (!file || !screenVideoState.video) return;
        // 先清理旧资源，避免内存堆积
        if (screenVideoState._currentBlobUrl) {
            URL.revokeObjectURL(screenVideoState._currentBlobUrl);
            screenVideoState._currentBlobUrl = null;
        }
        if (screenVideoState.texture) {
            screenVideoState.texture.dispose();
            screenVideoState.texture = null;
        }
        // 清理旧的 WebCodecs pipeline（如果存在）
        if (window.VideoDecodeBridge && VideoDecodeBridge.isUsingWebCodecs()) {
            VideoDecodeBridge.dispose();
        }
        screenVideoState.active = false;
        if (DOM.toggleScreenBtn) DOM.toggleScreenBtn.classList.remove('active');

        // 异步处理：用 setTimeout(0) 脱离 change 事件的调用栈
        setTimeout(function() {
            requestAnimationFrame(function() {
                if (file.arrayBuffer) {
                    file.arrayBuffer().then(function(buffer) {
                        // ===== 优先尝试 WebCodecs 解码流水线 =====
                        if (window.VideoDecodeBridge) {
                            var caps = VideoDecodeBridge.detectCapabilities();
                            if (caps.allSupported) {
                                // 先用 MediaCapabilities 查询硬解能力
                                VideoDecodeBridge.queryDecodeCapability({
                                    contentType: file.type || 'video/mp4; codecs="avc1.42E01E"',
                                    width: 1280, height: 720, bitrate: 5000000, framerate: 30
                                }).then(function(result) {
                                    if (result.supported && result.smooth) {
                                        // 硬解可行：初始化 WebCodecs 流水线
                                        initScreenVideoTexture();
                                        if (VideoDecodeBridge.initWebCodecsPipeline(screenVideoState.texture, screenVideoState.mesh)) {
                                            console.log('[Video] Using WebCodecs pipeline');
                                            // 将文件数据投递给 Worker 解码
                                            var copy = buffer.slice(0);
                                            VideoDecodeBridge.startDecoding(copy);
                                            screenVideoState.active = true;
                                            if (DOM.toggleScreenBtn) DOM.toggleScreenBtn.classList.add('active');
                                            return;
                                        }
                                    }
                                    // 硬解不可行或初始化失败：降级到 <video> + rVFC
                                    fallbackToVideoElement(buffer, file);
                                }).catch(function() {
                                    fallbackToVideoElement(buffer, file);
                                });
                            } else {
                                // 不支持 WebCodecs：降级到 <video> + rVFC
                                fallbackToVideoElement(buffer, file);
                            }
                        } else {
                            // VideoDecodeBridge 未加载：走原来的 Worker 读取流程
                            if (screenVideoState.worker) {
                                screenVideoState.worker.postMessage({
                                    type: 'loadVideoBuffer',
                                    buffer: buffer,
                                    fileName: file.name,
                                    fileType: file.type
                                }, [buffer]);
                            } else {
                                var url = URL.createObjectURL(file);
                                applyVideoSource(url, file.name);
                            }
                        }
                    }).catch(function() {
                        // 回退：直接传 File 对象给 Worker
                        if (screenVideoState.worker) {
                            screenVideoState.worker.postMessage({ type: 'loadVideoFile', file: file });
                        } else {
                            var url2 = URL.createObjectURL(file);
                            applyVideoSource(url2, file.name);
                        }
                    });
                } else {
                    if (screenVideoState.worker) {
                        screenVideoState.worker.postMessage({ type: 'loadVideoFile', file: file });
                    } else {
                        var url3 = URL.createObjectURL(file);
                        applyVideoSource(url3, file.name);
                    }
                }
            });
        }, 0);
    }

    // ===== 降级到 <video> 元素方案（含 requestVideoFrameCallback 优化）=====
    function fallbackToVideoElement(buffer, file) {
        console.log('[Video] Falling back to <video> + rVFC');
        var blob = new Blob([buffer], { type: file.type || 'video/mp4' });
        var url = URL.createObjectURL(blob);
        applyVideoSource(url, file.name);

        // 使用 requestVideoFrameCallback 替代 rAF 同步纹理（减少无效 CPU 检查）
        // 在 canplay 事件触发后启动
        var origOnCanPlay = screenVideoState._prevCanplay;
        screenVideoState.video.addEventListener('canplay', function onCanPlayRVFC() {
            screenVideoState.video.removeEventListener('canplay', onCanPlayRVFC);
            if (window.VideoDecodeBridge && screenVideoState.texture) {
                VideoDecodeBridge.startVideoFrameCallback(screenVideoState.video, screenVideoState.texture);
            }
        }, { once: true });
    }

    // ===== 初始化屏幕视频纹理（供 WebCodecs 路径使用）=====
    function initScreenVideoTexture() {
        if (!screenVideoState.mesh) return;
        // 创建普通 Texture（非 VideoTexture），用于接收 ImageBitmap
        if (!screenVideoState.texture || screenVideoState.texture.isVideoTexture) {
            if (screenVideoState.texture) screenVideoState.texture.dispose();
            screenVideoState.texture = new THREE.Texture();
            screenVideoState.texture.minFilter = THREE.LinearFilter;
            screenVideoState.texture.magFilter = THREE.LinearFilter;
            screenVideoState.texture.format = THREE.RGBAFormat;
            screenVideoState.texture.colorSpace = THREE.SRGBColorSpace;
        }
        // 挂载到模型
        applyScreenVideoTexture();
    }

    function applyScreenVideoTexture() {
        if (!screenVideoState.video || !screenVideoState.mesh) return;
        if (!screenVideoState.texture) {
            screenVideoState.texture = new THREE.VideoTexture(screenVideoState.video);
            screenVideoState.texture.minFilter = THREE.LinearFilter;
            screenVideoState.texture.magFilter = THREE.LinearFilter;
            screenVideoState.texture.format = THREE.RGBAFormat;
        }
        // 使用自定义着色器材质替代标准材质，彻底解决 emissiveMap 叠加导致的泛白问题
        // 同时支持亮度/对比度/饱和度/色相实时滤镜调整
        if (window.videoScreenShader) {
            var shaderMat = videoScreenShader.createVideoScreenMaterial(screenVideoState.texture);
            screenVideoState.mesh.traverse(function(child) {
                if (child.isMesh) {
                    if (!child.material) return;
                    child.material = shaderMat;
                    child.material.needsUpdate = true;
                }
            });
            // 同步当前滤镜面板的滑块值到着色器
            syncFilterUItoShader();
        } else {
            // 降级：使用标准材质（无滤镜功能）
            screenVideoState.mesh.traverse(function(child) {
                if (child.isMesh) {
                    if (!child.material) return;
                    var mats = Array.isArray(child.material) ? child.material : [child.material];
                    for (var i = 0; i < mats.length; i++) {
                        var mat = mats[i];
                        if (mat.isMeshStandardMaterial || mat.isMeshBasicMaterial || mat.isMeshPhongMaterial) {
                            mat.map = screenVideoState.texture;
                            mat.emissiveMap = null;
                            mat.emissive = new THREE.Color(0x000000);
                            mat.emissiveIntensity = 0;
                            mat.needsUpdate = true;
                        }
                    }
                }
            });
        }
    }

    // ===== 低清缩略图前10帧注入 =====
    // VideoTexture 首帧 1080P 上传 GPU 耗时约 30~50ms
    // 先用半分辨率 canvas 缩略图上传 10 帧，待解码器稳定后恢复原始视频流
    var _lowResWarmupActive = false;
    function startLowResWarmup() {
        if (!screenVideoState.video || !screenVideoState.texture) return;
        var video = screenVideoState.video;
        var texture = screenVideoState.texture;

        // 仅在视频分辨率较大时启用（<480p 不需要）
        if (!video.videoWidth || video.videoWidth < 480) return;

        var tempCanvas = document.createElement('canvas');
        tempCanvas.width = Math.max(1, Math.floor(video.videoWidth / 2));
        tempCanvas.height = Math.max(1, Math.floor(video.videoHeight / 2));
        var tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) return;

        _lowResWarmupActive = true;
        var originalImage = texture.image; // 保存原始 video 元素引用
        var uploadFrame = 0;
        var MAX_WARMUP_FRAMES = 10;

        function uploadLowResFrame() {
            if (!_lowResWarmupActive) return;
            if (uploadFrame < MAX_WARMUP_FRAMES) {
                try {
                    tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
                    texture.image = tempCanvas; // 先喂低清图
                    texture.needsUpdate = true;
                } catch (e) {
                    // 视频未准备好，跳过
                }
                uploadFrame++;
                requestAnimationFrame(uploadLowResFrame);
            } else {
                // 10 帧后恢复原始视频流，此时解码器已稳定
                texture.image = originalImage;
                texture.needsUpdate = true;
                _lowResWarmupActive = false;
            }
        }
        uploadLowResFrame();
    }

    // 同步滤镜面板 UI 滑块到着色器
    function syncFilterUItoShader() {
        if (!window.videoScreenShader) return;
        var filterSlider = document.getElementById('filter-brightness');
        if (filterSlider) {
            videoScreenShader.setFilterParam('brightness', parseFloat(filterSlider.value));
            document.getElementById('filter-brightness-val').textContent = filterSlider.value;
        }
        var contrastSlider = document.getElementById('filter-contrast');
        if (contrastSlider) {
            videoScreenShader.setFilterParam('contrast', parseFloat(contrastSlider.value));
            document.getElementById('filter-contrast-val').textContent = contrastSlider.value;
        }
        var saturationSlider = document.getElementById('filter-saturation');
        if (saturationSlider) {
            videoScreenShader.setFilterParam('saturation', parseFloat(saturationSlider.value));
            document.getElementById('filter-saturation-val').textContent = saturationSlider.value;
        }
        var hueSlider = document.getElementById('filter-hue');
        if (hueSlider) {
            videoScreenShader.setFilterParam('hue', parseFloat(hueSlider.value));
            document.getElementById('filter-hue-val').textContent = hueSlider.value;
        }
    }

    function toggleScreenVideoPlayback() {
        if (!screenVideoState.video) return;
        if (screenVideoState.video.paused) {
            screenVideoState.video.play().catch(function(err) {
                console.warn('屏幕视频播放失败:', err);
            });
            if (DOM.toggleScreenBtn) DOM.toggleScreenBtn.classList.add('active');
        } else {
            screenVideoState.video.pause();
            if (DOM.toggleScreenBtn) DOM.toggleScreenBtn.classList.remove('active');
        }
    }

    window.uiModule = {
        DOM: DOM,
        animSelectorIds: animSelectorIds,
        updateStatus: updateStatus,
        updateAnimPicker: updateAnimPicker,
        toggleSettingsOverlay: toggleSettingsOverlay,
        screenVideoState: screenVideoState,
        openScreenVideoPicker: openScreenVideoPicker,
        handleScreenVideoFile: handleScreenVideoFile,
        applyScreenVideoTexture: applyScreenVideoTexture,
        toggleScreenVideoPlayback: toggleScreenVideoPlayback,
        disposeScreenVideo: disposeScreenVideo,
        toggleFilterOverlay: toggleFilterOverlay,
        initFilterPanel: initFilterPanel,
        syncFilterUItoShader: syncFilterUItoShader
    };
})();