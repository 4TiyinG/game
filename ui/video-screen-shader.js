// video-screen-shader.js — 视频屏幕自定义着色器 + 滤镜控制
// 使用 ShaderMaterial 替代标准材质，支持亮度/对比度/饱和度/色相调整
// 解决原 emissiveMap 叠加导致的视频泛白问题
(function() {

    // ===== 顶点着色器 =====
    var vertexShader = [
        'varying vec2 vUv;',
        'void main() {',
        '    vUv = uv;',
        '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
    ].join('\n');

    // ===== 片元着色器 =====
    // 支持亮度(brightness)、对比度(contrast)、饱和度(saturation)、色相旋转(hue)
    var fragmentShader = [
        'uniform sampler2D uTexture;',
        'uniform float uBrightness;',
        'uniform float uContrast;',
        'uniform float uSaturation;',
        'uniform float uHue;',
        'varying vec2 vUv;',

        // 色相旋转矩阵 (角度弧度制)
        'vec3 hueRotate(vec3 color, float hue) {',
        '    float angle = hue * 3.14159265;',
        '    float s = sin(angle);',
        '    float c = cos(angle);',
        '    mat3 rot = mat3(',
        '        vec3(0.299, 0.587, 0.114) + vec3(0.701, -0.587, -0.114) * c + vec3(0.168, 0.330, -0.497) * s,',
        '        vec3(0.299, 0.587, 0.114) + vec3(-0.299, 0.413, -0.114) * c + vec3(-0.328, 0.035, 0.292) * s,',
        '        vec3(0.299, 0.587, 0.114) + vec3(-0.300, -0.588, 0.886) * c + vec3(1.250, -1.050, -0.203) * s',
        '    );',
        '    return color * rot;',
        '}',

        'void main() {',
        '    vec4 texColor = texture2D(uTexture, vUv);',
        '    vec3 color = texColor.rgb;',

        // 亮度调整 (加法偏移)
        '    color += uBrightness;',

        // 对比度调整 (围绕 0.5 缩放)
        '    color = (color - 0.5) * uContrast + 0.5;',

        // 饱和度调整 (混合亮度与原始色)
        '    float luminance = dot(color, vec3(0.299, 0.587, 0.114));',
        '    color = mix(vec3(luminance), color, uSaturation);',

        // 色相旋转
        '    color = hueRotate(color, uHue);',

        // 钳制到合法范围
        '    color = clamp(color, 0.0, 1.0);',

        '    gl_FragColor = vec4(color, texColor.a);',
        '}'
    ].join('\n');

    // ===== 滤镜配置状态 =====
    var filterState = {
        brightness: 0.0,    // [-1, 1]
        contrast: 1.0,      // [0, 3]
        saturation: 1.0,    // [0, 2]
        hue: 0.0           // [-1, 1]
    };

    // 默认值 (用于重置)
    var defaultState = {
        brightness: 0.0,
        contrast: 1.0,
        saturation: 1.0,
        hue: 0.0
    };

    // ===== 滤镜预设 =====
    var presets = [
        { name: '原片',   brightness: 0.0,  contrast: 1.0,  saturation: 1.0,  hue: 0.0 },
        { name: '鲜艳',   brightness: 0.05, contrast: 1.15, saturation: 1.4,  hue: 0.0 },
        { name: '影院',   brightness: -0.05, contrast: 1.2,  saturation: 0.85, hue: 0.0 },
        { name: '暖调',   brightness: 0.03, contrast: 1.05, saturation: 1.1,  hue: -0.12 },
        { name: '冷调',   brightness: 0.0,  contrast: 1.05, saturation: 1.1,  hue: 0.12 },
        { name: '黑白',   brightness: 0.0,  contrast: 1.1,  saturation: 0.0,  hue: 0.0 },
        { name: '复古',   brightness: -0.03, contrast: 0.9, saturation: 0.7,  hue: -0.2 },
        { name: '明亮',   brightness: 0.12, contrast: 1.1,  saturation: 1.2,  hue: 0.0 }
    ];

    // 当前材质引用
    var _currentMaterial = null;
    var _currentUniforms = null;

    // ===== 创建视频屏幕着色器材质 =====
    function createVideoScreenMaterial(texture) {
        var uniforms = {
            uTexture: { value: texture },
            uBrightness: { value: filterState.brightness },
            uContrast: { value: filterState.contrast },
            uSaturation: { value: filterState.saturation },
            uHue: { value: filterState.hue }
        };

        var material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            side: THREE.DoubleSide,
            transparent: false,
            depthWrite: true,
            depthTest: true
        });

        _currentMaterial = material;
        _currentUniforms = uniforms;

        return material;
    }

    // ===== 更新单个滤镜参数 =====
    function setFilterParam(name, value) {
        if (!(name in filterState)) return;
        filterState[name] = value;
        if (_currentUniforms && _currentUniforms['u' + name.charAt(0).toUpperCase() + name.slice(1)]) {
            _currentUniforms['u' + name.charAt(0).toUpperCase() + name.slice(1)].value = value;
        }
    }

    // ===== 批量更新滤镜参数 =====
    function setFilterParams(params) {
        if (!params) return;
        var uniformMap = {
            brightness: 'uBrightness',
            contrast: 'uContrast',
            saturation: 'uSaturation',
            hue: 'uHue'
        };
        for (var key in params) {
            if (key in filterState) {
                filterState[key] = params[key];
                if (_currentUniforms && _currentUniforms[uniformMap[key]]) {
                    _currentUniforms[uniformMap[key]].value = params[key];
                }
            }
        }
    }

    // ===== 获取当前滤镜状态 =====
    function getFilterState() {
        return {
            brightness: filterState.brightness,
            contrast: filterState.contrast,
            saturation: filterState.saturation,
            hue: filterState.hue
        };
    }

    // ===== 重置滤镜到默认值 =====
    function resetFilterParams() {
        setFilterParams(defaultState);
    }

    // ===== 获取预设列表 =====
    function getPresets() {
        return presets;
    }

    // ===== 应用预设 =====
    function applyPreset(index) {
        if (index < 0 || index >= presets.length) return;
        setFilterParams(presets[index]);
    }

    // ===== 清理材质 =====
    function disposeMaterial() {
        if (_currentMaterial) {
            _currentMaterial.dispose();
            _currentMaterial = null;
            _currentUniforms = null;
        }
    }

    // ===== 导出模块 =====
    window.videoScreenShader = {
        createVideoScreenMaterial: createVideoScreenMaterial,
        setFilterParam: setFilterParam,
        setFilterParams: setFilterParams,
        getFilterState: getFilterState,
        resetFilterParams: resetFilterParams,
        getPresets: getPresets,
        applyPreset: applyPreset,
        disposeMaterial: disposeMaterial
    };

})();