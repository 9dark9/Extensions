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

    let disableHls = false;

    try {
        window.addEventListener('message', function (e) {
            if (e.source !== window) return;
            const d = e.data;
            if (!d || d.source !== 'm3u8-ad-cleaner') return;

            if (d.type === 'debug') {
                DEBUG = !!d.value;
            } else if (d.type === 'disable') {
                __m3u8ar_disabled = true;
            } else if (d.type === 'enable') {
                __m3u8ar_disabled = false;
                log('恢复启用');
            } else if (d.type === 'setDisableHls') {
                disableHls = !!d.value;
                log('运行时切换 disableHls=' + disableHls);
            }
        });
    } catch (e) {}

    // ---- canPlayType 代理 ----
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

    // ---- SPA URL 变化监听 ----
    (function installUrlChangeWatcher() {
        try {
            const notify = function () {
                try {
                    window.postMessage({
                        source: 'm3u8-ad-cleaner',
                        type: 'urlChange'
                    }, '*');
                } catch (e) {}
            };

            const origPush = history.pushState;
            if (typeof origPush === 'function') {
                history.pushState = function () {
                    const r = origPush.apply(this, arguments);
                    notify();
                    return r;
                };
            }

            const origReplace = history.replaceState;
            if (typeof origReplace === 'function') {
                history.replaceState = function () {
                    const r = origReplace.apply(this, arguments);
                    notify();
                    return r;
                };
            }

            window.addEventListener('popstate', notify);
            window.addEventListener('hashchange', notify);
            log('URL 变化监听已安装');
        } catch (e) {
            console.error('[AD-PAGE] 安装 URL 变化监听失败:', e);
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
                if (!__m3u8ar_disabled) {
                    log('fetch 网络失败:', url);
                    notifyNetworkError(url);
                }
                throw e;
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

    // O5 修复：descriptor 在模块级缓存，避免每次 send 重复取
    const RESP_TEXT_DESC = Object.getOwnPropertyDescriptor(
        XMLHttpRequest.prototype, 'responseText'
    );
    const ORIG_RESP_TEXT_GET = RESP_TEXT_DESC && RESP_TEXT_DESC.get;

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
        notifyPending(url);

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
            // O2 修复：{ once: true } 避免复用 XHR 时叠加监听器
            xhr.addEventListener('error', onNetworkErr, { once: true });
            xhr.addEventListener('timeout', onNetworkErr, { once: true });
        } catch (e) {}

        log('XHR 命中:', url);
        if (ORIG_RESP_TEXT_GET) {
            try {
                Object.defineProperty(xhr, 'responseText', {
                    get: function () {
                        if (__m3u8ar_disabled) return ORIG_RESP_TEXT_GET.call(xhr);
                        const cached = respCache.get(xhr);
                        if (cached !== undefined) return cached;

                        // B4 修复：不吞异常，保持标准语义
                        // （readyState < 3 或 responseType 不匹配时，原 getter 会抛 InvalidStateError）
                        const text = ORIG_RESP_TEXT_GET.call(xhr);

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