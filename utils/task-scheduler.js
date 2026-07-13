// task-scheduler.js — 协作式任务调度系统
// 基于 scheduler.postTask() / scheduler.yield() / requestIdleCallback()
// 提供 Unity 式的任务优先级调度，将卡顿和掉帧降到最低
(function() {
    'use strict';

    var hasScheduler = typeof scheduler !== 'undefined';
    var hasPostTask = hasScheduler && typeof scheduler.postTask === 'function';
    var hasYield = hasScheduler && typeof scheduler.yield === 'function';
    var hasRIC = typeof requestIdleCallback === 'function';

    // 优先级映射：scheduler.postTask 的三档优先级
    var PRIORITY = {
        BLOCKING: 'user-blocking',    // 最高：用户交互响应、渲染
        VISIBLE: 'user-visible',      // 普通：UI 更新、动画
        BACKGROUND: 'background'      // 最低：日志、缓存、预加载
    };

    // ===== 核心 API 1: postTask — 按优先级排队 =====
    function postTask(callback, priority) {
        priority = priority || PRIORITY.VISIBLE;

        if (hasPostTask) {
            return scheduler.postTask(callback, { priority: priority });
        }

        // 降级：用 setTimeout 模拟优先级
        // user-blocking → microtask（最快）
        // user-visible → setTimeout(0)
        // background → setTimeout(50)（延迟执行）
        return new Promise(function(resolve, reject) {
            if (priority === PRIORITY.BLOCKING) {
                Promise.resolve().then(function() {
                    try { resolve(callback()); } catch (e) { reject(e); }
                });
            } else if (priority === PRIORITY.BACKGROUND) {
                setTimeout(function() {
                    try { resolve(callback()); } catch (e) { reject(e); }
                }, 50);
            } else {
                setTimeout(function() {
                    try { resolve(callback()); } catch (e) { reject(e); }
                }, 0);
            }
        });
    }

    // ===== 核心 API 2: yield — 主动让出主线程 =====
    // 在长时间任务中插入 await yield()，让浏览器处理高优先级输入和渲染
    function yieldToMain() {
        if (hasYield) {
            return scheduler.yield();
        }
        // 降级：用 setTimeout(0) 让出
        return new Promise(function(resolve) {
            setTimeout(resolve, 0);
        });
    }

    // ===== 核心 API 3: runIdle — 利用空闲时间执行 =====
    function runIdle(callback, options) {
        options = options || {};
        var timeout = options.timeout || 2000; // 默认 2 秒超时保证执行

        if (hasRIC) {
            return requestIdleCallback(callback, { timeout: timeout });
        }
        // 降级：用 setTimeout 延迟执行
        return setTimeout(callback, timeout);
    }

    // ===== 高级 API: 切片执行长任务 =====
    // 将一个大任务拆分为多个小块，每块之间 yield 让出主线程
    // 避免长时间阻塞导致掉帧
    function chunkTask(taskList, processor, options) {
        options = options || {};
        var chunkSize = options.chunkSize || 1;     // 每次处理几个
        var onProgress = options.onProgress;          // 进度回调
        var onComplete = options.onComplete;          // 完成回调
        var priority = options.priority || PRIORITY.BACKGROUND;
        var index = 0;
        var total = taskList.length;

        return new Promise(function(resolve) {
            function processChunk() {
                var processed = 0;
                var shouldYield = false;

                while (index < total && processed < chunkSize) {
                    processor(taskList[index], index);
                    index++;
                    processed++;

                    // 检查是否需要让出（每处理 chunkSize 个让出一次）
                    if (processed >= chunkSize && index < total) {
                        shouldYield = true;
                    }
                }

                if (onProgress) onProgress(index, total);

                if (index >= total) {
                    if (onComplete) onComplete();
                    resolve();
                    return;
                }

                if (shouldYield) {
                    // 让出主线程，下一轮继续
                    yieldToMain().then(processChunk);
                } else {
                    // 直接继续
                    processChunk();
                }
            }

            // 根据优先级决定首次执行时机
            if (priority === PRIORITY.BLOCKING) {
                processChunk();
            } else if (priority === PRIORITY.BACKGROUND) {
                runIdle(function() { processChunk(); }, { timeout: 1000 });
            } else {
                postTask(processChunk, priority);
            }
        });
    }

    // ===== 高级 API: 帧预算管理 =====
    // 在给定的帧预算内执行尽可能多的工作，超时则让出
    function runInFrameBudget(workItems, processor, frameBudget) {
        frameBudget = frameBudget || 8; // 默认 8ms 帧预算（60fps 留 8ms 给后台任务）
        var index = 0;
        var total = workItems.length;

        return new Promise(function(resolve) {
            function processBatch() {
                var startTime = performance.now();

                while (index < total) {
                    processor(workItems[index], index);
                    index++;

                    // 检查帧预算
                    if (performance.now() - startTime >= frameBudget) {
                        // 超出预算，让出主线程
                        yieldToMain().then(processBatch);
                        return;
                    }
                }

                resolve();
            }

            processBatch();
        });
    }

    // ===== 暴露 API =====
    window.TaskScheduler = {
        PRIORITY: PRIORITY,
        postTask: postTask,
        yield: yieldToMain,
        runIdle: runIdle,
        chunkTask: chunkTask,
        runInFrameBudget: runInFrameBudget,
        // 能力检测
        capabilities: {
            hasScheduler: hasScheduler,
            hasPostTask: hasPostTask,
            hasYield: hasYield,
            hasRIC: hasRIC
        }
    };

    console.log('[TaskScheduler] 初始化完成 | postTask:', hasPostTask, '| yield:', hasYield, '| idleCallback:', hasRIC);
})();
