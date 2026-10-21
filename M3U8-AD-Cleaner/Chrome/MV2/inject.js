// ============================================================
// M3U8 AD Cleaner - Page World Injection (Chrome MV2)
// ============================================================

(function () {
    'use strict';

    if (window.__m3u8ar_injected) return;
    window.__m3u8ar_injected = true;

    let __m3u8ar_disabled = false;

    let DEBUG = false;
    try {
        if (window.__M3U8AR_DEBUG__ === true) DEBUG = true;
    } catch (e) {}
    function log(...args) { if (DEBUG) console.log('[AD-PAGE]', ...args); }

    // ---- disableHls 状态（必须在监听器之前声明）----
    let disableHls = false;

    // 初始值：兼容 URL query（保留旧行为）
    try {
        const scriptUrl = (document.currentScript && document.currentScript.src) || '';
        if (/[?&]disableHls=1(?:&|$)/.test(scriptUrl)) {
            disableHls = true;
        }
    } catch (e) {}

    // ---- 唯一的 message 监听器（合并 debug / disable / setDisableHls）----
    try {
        window.addEventListener('message', function (e) {
            if (e.source !== window) return;
            const d = e.data;
            if (!d || d.source !== 'm3u8-ad-cleaner') return;

            if (d.type === 'debug') {
                DEBUG = !!d.value;
            } else if (d.type === 'disable') {
                __m3u8ar_disabled = true;
            } else if (d.type === 'setDisableHls') {
                disableHls = !!d.value;
                log('运行时切换 disableHls=' + disableHls);
            }
        });
    } catch (e) {}

    // ---- 无条件安装 canPlayType 代理（只装一次，闭包读 disableHls）----
    (function installCanPlayTypeProxy() {
        try {
            const proto = HTMLMediaElement.prototype;
            if (proto.__m3u8ar_cpt) return;
            const orig = proto.canPlayType;
            if (typeof orig !== 'function') return;

            proto.__m3u8ar_orig_cpt = orig;

            const proxy = function (type) {
                if (disableHls && type && /mpegurl|m3u8/i.test(type)) return '';
                return proto.__m3u8ar_orig_cpt.apply(this, arguments);
            };
            try {
                Object.defineProperty(proxy, 'name', { value: 'canPlayType', configurable: true });
                Object.defineProperty(proxy, 'length', { value: orig.length, configurable: true });
            } catch (e) {}

            proto.canPlayType = proxy;
            proto.__m3u8ar_cpt = true;
            log('canPlayType 代理已安装，初始 disableHls=' + disableHls);
        } catch (e) {
            console.error('[AD-PAGE] 安装 canPlayType 代理失败:', e);
        }
    })();

    if (!window.M3U8Filter) {
        console.error('[AD-PAGE] M3U8Filter 未加载');
        return;
    }

    function looksLikeM3U8(url) {
        if (!url || typeof url !== 'string') return false;
        let end = url.length;
        const q = url.indexOf('?');
        if (q !== -1 && q < end) end = q;
        const h = url.indexOf('#');
        if (h !== -1 && h < end) end = h;
        return /\.m3u8$/i.test(url.slice(0, end));
    }

    function notifyFiltered(url, result) {
        if (__m3u8ar_disabled) return;
        try {
            window.postMessage({
                source: 'm3u8-ad-cleaner',
                type: 'filtered',
                url: url,
                adsCount: result.ads ? result.ads.length : 0,
                ads: result.ads || [],
                headLines: result.headLines || [],
                filtered: result.modified || '',
                modeName: result.stats ? result.stats.modeName : '',
                rules: result.stats ? result.stats.rules : []
            }, '*');
        } catch (e) {}
    }

    function notifyPending(url) {
        if (__m3u8ar_disabled) return;
        try {
            window.postMessage({
                source: 'm3u8-ad-cleaner',
                type: 'm3u8Pending',
                url: url
            }, '*');
        } catch (e) {}
    }

    // ★ 增加 filtered 和 headLines 参数（无广告时也传内容，供导出使用）
    function notifyStatus(url, outcome, parseError, filtered, headLines) {
        if (__m3u8ar_disabled) return;
        try {
            const msg = {
                source: 'm3u8-ad-cleaner',
                type: 'm3u8Status',
                url: url,
                outcome: outcome
            };
            if (parseError) msg.parseError = parseError;
            if (filtered) msg.filtered = filtered;
            if (headLines && headLines.length) msg.headLines = headLines;
            window.postMessage(msg, '*');
        } catch (e) {}
    }

    // ★ 新增：请求失败通知
    function notifyNetworkError(url) {
        if (__m3u8ar_disabled) return;
        try {
            window.postMessage({
                source: 'm3u8-ad-cleaner',
                type: 'm3u8NetworkError',
                url: url
            }, '*');
        } catch (e) {}
    }

    function handleResult(url, result) {
        const stats = result.stats;
        if (!stats) return;

        // master：不更新状态（后面紧跟 media playlist）
        if (stats.master) return;

        if (stats.error) {
            let outcome;
            if (stats.error === 'empty' ||
                stats.error === 'html' ||
                stats.error === 'not-m3u8' ||
                stats.error === 'empty-playlist') {
                outcome = 'invalid';
            } else {
                outcome = 'parse-error';
            }
            notifyStatus(url, outcome, stats.error);
            return;
        }

        if (result.changed) {
            notifyFiltered(url, result);
        } else {
            // ★ 无广告：也传原文和 headLines，让 background 保存供导出
            notifyStatus(url, 'no-ads', null, result.modified, result.headLines);
        }
    }

    // ============================================================
    // Hook fetch
    // ============================================================
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
        window.fetch = function (input, init) {
            if (__m3u8ar_disabled) {
                return origFetch.apply(this, arguments);
            }
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (!looksLikeM3U8(url)) {
                return origFetch.apply(this, arguments);
            }

            // 请求发出，立即通知 pending
            notifyPending(url);

            log('fetch 命中:', url);
            return origFetch.apply(this, arguments).then(function (response) {
                return response.clone().text().then(function (text) {
                    if (__m3u8ar_disabled) return response;
                    let result;
                    try {
                        result = window.M3U8Filter.filterM3U8(text, url);
                    } catch (e) {
                        console.error('[AD-PAGE] fetch 处理失败:', e);
                        return response;
                    }

                    handleResult(url, result);

                    if (!result.changed) return response;

                    log('已过滤:', url, 'removed=', result.stats.removedLines);
                    const headers = new Headers(response.headers);
                    headers.delete('content-length');
                    return new Response(result.modified, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: headers
                    });
                }).catch(function (e) {
                    console.error('[AD-PAGE] fetch text 失败:', e);
                    return response;
                });
            }).catch(function (e) {
                // ★ 请求失败（网络错误、CORS、超时等）
                if (!__m3u8ar_disabled) {
                    log('fetch 网络失败:', url);
                    notifyNetworkError(url);
                }
                throw e;   // 保持原语义
            });
        };
    }

    // ============================================================
    // Hook XHR
    // ============================================================
    const XHRProto = XMLHttpRequest.prototype;
    const origOpen = XHRProto.open;
    const origSend = XHRProto.send;
    const urlMap = new WeakMap();
    const respCache = new WeakMap();

    XHRProto.open = function (method, url) {
        urlMap.set(this, url);
        return origOpen.apply(this, arguments);
    };

    XHRProto.send = function () {
        if (__m3u8ar_disabled) {
            return origSend.apply(this, arguments);
        }
        const xhr = this;
        const url = urlMap.get(xhr) || '';
        if (!looksLikeM3U8(url)) {
            return origSend.apply(this, arguments);
        }
        // 请求发出，立即通知 pending
        notifyPending(url);

        // ★ 加网络失败监听（error / timeout），只触发一次
        try {
            let networkErrNotified = false;
            const onNetworkErr = function () {
                if (networkErrNotified) return;
                networkErrNotified = true;
                if (!__m3u8ar_disabled) {
                    log('XHR 网络失败:', url);
                    notifyNetworkError(url);
                }
            };
            xhr.addEventListener('error', onNetworkErr);
            xhr.addEventListener('timeout', onNetworkErr);
        } catch (e) {}

        log('XHR 命中:', url);
        const desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
        const origGet = desc && desc.get;
        if (origGet) {
            try {
                Object.defineProperty(xhr, 'responseText', {
                    get: function () {
                        if (__m3u8ar_disabled) return origGet.call(xhr);
                        const cached = respCache.get(xhr);
                        if (cached !== undefined) return cached;

                        let text;
                        try {
                            text = origGet.call(xhr);
                        } catch (e) {
                            respCache.set(xhr, '');
                            return '';
                        }
                        if (!text) {
                            respCache.set(xhr, text);
                            return text;
                        }

                        let result;
                        try {
                            result = window.M3U8Filter.filterM3U8(text, url);
                        } catch (e) {
                            console.error('[AD-PAGE] XHR 处理失败:', e);
                            respCache.set(xhr, text);
                            return text;
                        }

                        handleResult(url, result);

                        const out = result.changed ? result.modified : text;
                        respCache.set(xhr, out);
                        return out;
                    },
                    configurable: true
                });
            } catch (e) {
                console.error('[AD-PAGE] 覆盖 responseText 失败:', e);
            }
        }
        return origSend.apply(this, arguments);
    };

    log('页面脚本注入完成，disableHls=' + disableHls);

})();