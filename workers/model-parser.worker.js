// model-parser.worker.js

// 辅助函数：解析 GLB 头部元数据
function parseGLBMeta(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    // 检查是否含有 glTF 魔数
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546c67) {
        throw new Error('无效的 GLB 文件格式');
    }

    const version = view.getUint32(4, true);
    if (version !== 2) {
        throw new Error('仅支持 GLB v2 格式');
    }

    // 读取第一块 JSON 数据
    const chunkLen1 = view.getUint32(12, true);
    // 跳过前 20 字节 (Magic 4 + Version 4 + Length 4 + ChunkLen 4 + ChunkType 4)
    const chunkDataStart = 20;
    const jsonData = arrayBuffer.slice(chunkDataStart, chunkDataStart + chunkLen1);

    const decoder = new TextDecoder('utf-8');
    const jsonStr = decoder.decode(jsonData);
    const json = JSON.parse(jsonStr);

    // 提取动画名称和网格数量
    const animNames = (json.animations || []).map(a => a.name || '未命名动画');
    const meshCount = (json.meshes || []).length;

    return { animNames, meshCount };
}

self.onmessage = function(e) {
    const data = e.data;
    
    if (data.type === 'loadLocalFile') {
        const file = data.file;
        const reader = new FileReaderSync();
        try {
            const arrayBuffer = reader.readAsArrayBuffer(file);
            
            // 【拦截】：先进行元数据解析，如果格式不对，直接抛出错误，不发送数据！
            let meta = null;
            try {
                meta = parseGLBMeta(arrayBuffer);
            } catch (parseErr) {
                throw new Error('文件格式解析失败，请确保上传的是 GLB 文件: ' + parseErr.message);
            }

            if (meta) {
                self.postMessage({ type: 'meta', data: meta });
            }

            self.postMessage({ 
                type: 'arrayBuffer', 
                fileName: file.name, 
                buffer: arrayBuffer 
            }, [arrayBuffer]);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message });
        }
        return;
    }
    
    if (data.type === 'loadURL') {
        const url = data.url;
        const token = data.token || null;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        fetch(url, { signal: controller.signal })
            .then(async (response) => {
                clearTimeout(timeoutId);
                if (!response.ok) {
                    throw new Error('HTTP status ' + response.status);
                }

                const reader = response.body.getReader();
                let loaded = 0;
                const chunks = [];

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    loaded += value.length;
                    self.postMessage({ type: 'progress', loaded: loaded, total: loaded, token: token });
                }

                const buffer = new Uint8Array(loaded);
                let offset = 0;
                for (const chunk of chunks) {
                    buffer.set(chunk, offset);
                    offset += chunk.length;
                }
                const arrayBuffer = buffer.buffer;

                // 【拦截】：先进行元数据解析，如果格式不对，直接抛出错误，不发送数据！
                let meta = null;
                try {
                    meta = parseGLBMeta(arrayBuffer);
                } catch (parseErr) {
                    throw new Error('文件格式解析失败，请确保下载的是 GLB 文件: ' + parseErr.message);
                }

                if (meta) {
                    self.postMessage({ type: 'meta', data: meta, token: token });
                }

                self.postMessage({
                    type: 'arrayBuffer',
                    fileName: url.split('/').pop(),
                    url: url,
                    buffer: arrayBuffer,
                    token: token
                }, [arrayBuffer]);
            })
            .catch(err => {
                clearTimeout(timeoutId);
                if (err.name === 'AbortError') {
                    self.postMessage({ type: 'error', message: '网络下载超时 (超过60秒)', token: token });
                } else {
                    self.postMessage({ type: 'error', message: err.message, token: token });
                }
            });
        return;
    }
};