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

    try {
        window.addEventListener('message', function (e) {
            if (e.source !== window) return;
            const d = e.data;
            if (!d || d.source !== 'm3u8-ad-cleaner') return;
            if (d.type === 'debug') DEBUG = !!d.value;
            if (d.type === 'disable') __m3u8ar_disabled = true;
        });
    } catch (e) {}

    // 从 query 参数读取 disableHls 标记
    let disableHls = false;
    try {
        const scriptUrl = (document.currentScript && document.currentScript.src) || '';
        if (/[?&]disableHls=1(?:&|$)/.test(scriptUrl)) {
            disableHls = true;
        }
    } catch (e) {}

    if (disableHls) {
        try {
            const proto = HTMLMediaElement.prototype;
            const orig = proto.canPlayType;
            if (typeof orig === 'function' && !proto.__m3u8ar_cpt) {
                proto.__m3u8ar_cpt = true;
                const proxy = function (type) {
                    if (type && /mpegurl|m3u8/i.test(type)) return '';
                    return orig.apply(this, arguments);
                };
                try {
                    Object.defineProperty(proxy, 'name', {
                        value: 'canPlayType', configurable: true
                    });
                } catch (e) {}
                try {
                    Object.defineProperty(proxy, 'length', {
                        value: orig.length, configurable: true
                    });
                } catch (e) {}
                proto.canPlayType = proxy;
                log('已禁用原生 HLS（canPlayType 已覆盖）');
            }
        } catch (e) {
            console.error('[AD-PAGE] 覆盖 canPlayType 失败:', e);
        }
    }

    if (!window.M3U8Filter) {
        console.error('[AD-PAGE] M3U8Filter 未加载');
        return;
    }

    function isM3U8Url(url) {
        if (!url || typeof url !== 'string') return false;
        return /\.m3u8([?#&]|$)/i.test(url);
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

    function notifyStatus(url, outcome, parseError) {
        if (__m3u8ar_disabled) return;
        try {
            const msg = {
                source: 'm3u8-ad-cleaner',
                type: 'm3u8Status',
                url: url,
                outcome: outcome
            };
            if (parseError) msg.parseError = parseError;
            window.postMessage(msg, '*');
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
            notifyStatus(url, 'no-ads');
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
            if (!isM3U8Url(url)) {
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
                    console.error('[AD-PAGE] fetch 处理失败:', e);
                    return response;
                });
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
        if (!isM3U8Url(url)) {
            return origSend.apply(this, arguments);
        }

        // 请求发出，立即通知 pending
        notifyPending(url);

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

                        const text = origGet.call(xhr);
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