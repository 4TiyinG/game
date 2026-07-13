// video-reader.worker.js — 视频文件后台读取、校验与预处理
// 视频文件后台读取、校验与预处理，减少主线程卡顿

self.onmessage = function(e) {
    var data = e.data;
    if (data.type === 'loadVideoFile') {
        var file = data.file;
        // 文件大小限制：手机端超过 50MB 直接拒绝，避免内存爆炸
        if (file.size > 50 * 1024 * 1024) {
            self.postMessage({ type: 'error', message: '视频文件过大（>50MB），请选择更小的文件' });
            return;
        }
        var reader = new FileReaderSync();
        try {
            var arrayBuffer = reader.readAsArrayBuffer(file);
            var view = new DataView(arrayBuffer);
            var valid = false;
            var mimeType = file.type || 'video/mp4';

            // 简易格式校验：MP4/MOV/WebM/OGG
            if (arrayBuffer.byteLength > 12) {
                var fourCC = view.getUint32(4, true);
                if (fourCC === 0x66747970) valid = true; // ftyp
            }
            if (!valid && arrayBuffer.byteLength > 4) {
                if (view.getUint32(0, true) === 0x1A45Dfa3) valid = true; // EBML/WebM
            }
            if (!valid && arrayBuffer.byteLength > 4) {
                if (view.getUint32(0, true) === 0x4F676753) valid = true; // OggS
            }

            if (valid) {
                self.postMessage({
                    type: 'videoReady',
                    buffer: arrayBuffer,
                    fileName: file.name,
                    fileType: mimeType,
                    fileSize: file.size
                }, [arrayBuffer]);
            } else {
                self.postMessage({ type: 'error', message: '不支持的视频格式，请上传 MP4/WebM/OGG' });
            }
        } catch (err) {
            self.postMessage({ type: 'error', message: '视频读取失败: ' + err.message });
        }
        return;
    }
    if (data.type === 'loadVideoBuffer') {
        // 直接从主线程传来的 ArrayBuffer（已通过 file.arrayBuffer() 读取）
        var arrayBuffer = data.buffer;
        var view = new DataView(arrayBuffer);
        var valid = false;
        var mimeType = data.fileType || 'video/mp4';

        if (arrayBuffer.byteLength > 12) {
            var fourCC = view.getUint32(4, true);
            if (fourCC === 0x66747970) valid = true; // ftyp
        }
        if (!valid && arrayBuffer.byteLength > 4) {
            if (view.getUint32(0, true) === 0x1A45Dfa3) valid = true; // EBML/WebM
        }
        if (!valid && arrayBuffer.byteLength > 4) {
            if (view.getUint32(0, true) === 0x4F676753) valid = true; // OggS
        }

        if (valid) {
            self.postMessage({
                type: 'videoReady',
                buffer: arrayBuffer,
                fileName: data.fileName,
                fileType: mimeType,
                fileSize: arrayBuffer.byteLength
            }, [arrayBuffer]);
        } else {
            self.postMessage({ type: 'error', message: '不支持的视频格式，请上传 MP4/WebM/OGG' });
        }
        return;
    }
    if (data.type === 'dispose') {
        // 清理 Worker 资源（可选）
        self.close();
    }
};
