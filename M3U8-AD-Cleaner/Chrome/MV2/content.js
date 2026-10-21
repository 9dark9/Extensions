// ============================================================
// M3U8 AD Cleaner - Content Script (Chrome MV2)
// ============================================================

(function () {
    'use strict';

    if (window.__m3u8ar_cs_loaded) return;
    window.__m3u8ar_cs_loaded = true;

    let DEBUG = false;
    function log(...args) { if (DEBUG) console.log('[AD-CS]', ...args); }
    function warn(...args) { if (DEBUG) console.warn('[AD-CS]', ...args); }

    function setDebug(v) {
        DEBUG = !!v;
        try { window.__M3U8AR_DEBUG__ = DEBUG; } catch (e) {}
        try {
            window.postMessage({
                source: 'm3u8-ad-cleaner',
                type: 'debug',
                value: DEBUG
            }, '*');
        } catch (e) {}
    }

    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.debug) setDebug(changes.debug.newValue);
    });

    // ============================================================
    // 计算用于查询状态的 host
    //   1) location.ancestorOrigins（Chrome 特有）
    //   2) document.referrer 兜底
    //   3) 自身 hostname 兜底
    // ============================================================
    function getQueryHost() {
        const selfHost = location.hostname;

        if (window === window.top) return selfHost;

        try {
            const ao = location.ancestorOrigins;
            if (ao && ao.length > 0) {
                for (let i = ao.length - 1; i >= 0; i--) {
                    const origin = ao[i];
                    if (origin && origin !== 'null') {
                        try {
                            const h = new URL(origin).hostname;
                            if (h) return h;
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}

        try {
            const ref = document.referrer || '';
            if (ref) {
                const refHost = new URL(ref).hostname;
                if (refHost) return refHost;
            }
        } catch (e) {}

        return selfHost;
    }

    const host = location.hostname;
    const queryHost = getQueryHost();

    let injected = false;
    let parentPassed = false;
    let hlsDisabled = false;
    let extensionDisabled = false;

    // ============================================================
    // 注入工具
    // ============================================================
    function injectScript(src, onload) {
        const script = document.createElement('script');
        script.src = src;
        script.async = false;   // 关键：禁用 async，保证按插入顺序执行
        script.onload = function () {
            this.remove();
            if (onload) onload();
        };
        script.onerror = function () {
            console.error('[AD-CS] 注入失败:', src);
            this.remove();
        };
        (document.head || document.documentElement).appendChild(script);
    }

    function injectAll() {
        if (injected) return;
        if (extensionDisabled) return;
        injected = true;
        log('开始注入 @', location.href, 'frame:', window === window.top ? 'top' : 'iframe');
        injectScript(chrome.runtime.getURL('filter.js'), function () {
            log('filter.js 已加载');
            const injectUrl = chrome.runtime.getURL('inject.js') +
                '?disableHls=' + (hlsDisabled ? '1' : '0');
            injectScript(injectUrl);
        });
    }

    // ============================================================
    // 停手 / 抑制
    // ============================================================
    function suppressInjection() {
        if (extensionDisabled) return;
        extensionDisabled = true;
        try {
            window.postMessage({
                source: 'm3u8-ad-cleaner',
                type: 'disable'
            }, '*');
        } catch (e) {}
    }

    chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || msg.type !== 'extensionToggled') return;
        if (msg.enabled === false) {
            extensionDisabled = true;
            injected = true;
            try {
                window.postMessage({
                    source: 'm3u8-ad-cleaner',
                    type: 'disable'
                }, '*');
            } catch (e) {}
        }
    });

    // ============================================================
    // 转发 inject.js 的消息给 background
    // ============================================================
    window.addEventListener('message', function (e) {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== 'm3u8-ad-cleaner') return;
        if (extensionDisabled) return;

        if (d.type === 'filtered') {
            try {
                chrome.runtime.sendMessage({
                    type: 'm3u8Filtered',
                    url: d.url,
                    adsCount: d.adsCount,
                    ads: d.ads,
                    headLines: d.headLines,
                    filtered: d.filtered,
                    modeName: d.modeName,
                    rules: d.rules
                }, function () {
                    if (chrome.runtime.lastError) {}
                });
            } catch (err) {
                console.error('[AD-CS] 转发失败:', err);
            }
            return;
        }

        if (d.type === 'm3u8Status') {
            try {
                const msg = {
                    type: 'm3u8Status',
                    url: d.url,
                    outcome: d.outcome
                };
                if (d.parseError) msg.parseError = d.parseError;
                if (d.filtered) msg.filtered = d.filtered;
                if (d.headLines) msg.headLines = d.headLines;
                chrome.runtime.sendMessage(msg, function () {
                    if (chrome.runtime.lastError) {}
                });
            } catch (err) {
                console.error('[AD-CS] 转发失败:', err);
            }
            return;
        }

        if (d.type === 'm3u8Pending') {
            try {
                chrome.runtime.sendMessage({
                    type: 'm3u8Pending',
                    url: d.url
                }, function () {
                    if (chrome.runtime.lastError) {}
                });
            } catch (err) {
                console.error('[AD-CS] 转发失败:', err);
            }
            return;
        }
        
        if (d.type === 'm3u8NetworkError') {
            try {
                chrome.runtime.sendMessage({
                    type: 'm3u8NetworkError',
                    url: d.url
                }, function () {
                    if (chrome.runtime.lastError) {}
                });
            } catch (err) {
                console.error('[AD-CS] 转发失败:', err);
            }
            return;
        }
    });

    // ============================================================
    // 白名单广播
    // ============================================================
    function broadcastWhitelistPass() {
        if (extensionDisabled) return;
        let iframes;
        try {
            iframes = document.querySelectorAll('iframe');
        } catch (e) { return; }
        for (let i = 0; i < iframes.length; i++) {
            try {
                const w = iframes[i].contentWindow;
                if (w) {
                    w.postMessage({ __m3u8ar: true, type: 'whitelistPass' }, '*');
                }
            } catch (e) {}
        }
    }

    function watchIframes() {
        try {
            let timer = null;
            const mo = new MutationObserver(function () {
                if (timer) return;
                timer = setTimeout(function () {
                    timer = null;
                    if (extensionDisabled) return;
                    broadcastWhitelistPass();
                }, 200);
            });
            const start = function () {
                if (document.body) {
                    mo.observe(document.body, { childList: true, subtree: true });
                }
            };
            if (document.body) start();
            else document.addEventListener('DOMContentLoaded', start, { once: true });
        } catch (e) {}
    }

    window.addEventListener('message', function (e) {
        const d = e.data;
        if (!d || d.__m3u8ar !== true || d.type !== 'whitelistPass') return;
        if (parentPassed) return;
        if (extensionDisabled) return;

        parentPassed = true;
        log('收到父框架放行信号:', location.href);

        injectAll();
        broadcastWhitelistPass();
        watchIframes();
    });

    // ============================================================
    // 未检测到 m3u8 的提示（含原生 HLS 检测）
    // ============================================================
    function setupNoM3U8Detection() {
        if (window !== window.top) return;

        const HINT_DELAY_MS = 8000;
        const POLL_INTERVAL_MS = 1000;

        const processedUrls = new Set();
        const hintedUrls = new Set();
        const pendingTimers = new Map();

        let hintEl = null;
        let lastUrl = '';

        function removeHint() {
            if (hintEl && hintEl.isConnected) hintEl.remove();
            hintEl = null;
        }

        function showHint(html, bg) {
            if (extensionDisabled) return;
            if (hintEl && hintEl.isConnected) return;
            if (!document.body) return;
            hintEl = document.createElement('div');
            hintEl.id = 'm3u8ar-nom3u8';
            hintEl.style.cssText =
                'position:fixed;top:16px;right:16px;z-index:2147483647;' +
                'max-width:340px;padding:12px 30px 12px 14px;border-radius:10px;' +
                'background:' + (bg || '#e8a13a') + ';color:#fff;font-size:13px;line-height:1.5;' +
                'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
                'box-shadow:0 6px 18px rgba(0,0,0,.15)';

            const closeBtn = document.createElement('span');
            closeBtn.className = 'm3u8ar-hint-close';
            closeBtn.style.cssText =
                'position:absolute;top:6px;right:10px;cursor:pointer;font-size:16px;line-height:1;opacity:.7';
            closeBtn.textContent = '×';

            const contentDiv = document.createElement('div');
            const doc = new DOMParser().parseFromString(html, 'text/html');
            while (doc.body.firstChild) {
                contentDiv.appendChild(doc.body.firstChild);
            }

            hintEl.appendChild(closeBtn);
            hintEl.appendChild(contentDiv);
            document.body.appendChild(hintEl);
            closeBtn.addEventListener('click', removeHint);

            setTimeout(function () {
                if (hintEl && hintEl.isConnected) removeHint();
            }, 12000);
        }

        function findMedia(root) {
            if (!root) return null;
            try {
                const m = root.querySelector('video, audio');
                if (m) return m;
            } catch (e) {}
            let all;
            try {
                all = root.querySelectorAll('*');
            } catch (e) {
                return null;
            }
            for (let i = 0; i < all.length; i++) {
                if (all[i].shadowRoot) {
                    const found = findMedia(all[i].shadowRoot);
                    if (found) return found;
                }
            }
            return null;
        }

        function getUrl(m) {
            if (!m) return '';
            return m.currentSrc || m.src || '';
        }

        function checkBackground() {
            return new Promise(function (resolve) {
                try {
                    chrome.runtime.sendMessage({ type: 'checkFiltered' }, function (r) {
                        if (chrome.runtime.lastError) { resolve(false); return; }
                        resolve(!!(r && r.hasFiltered));
                    });
                } catch (e) {
                    resolve(false);
                }
            });
        }

        function notifyNativeHlsSuspect() {
            try {
                chrome.runtime.sendMessage({ type: 'nativeHlsSuspect' }, function () {
                    if (chrome.runtime.lastError) {}
                });
            } catch (e) {}
        }

        function buildHintMessage(url, m) {
            const isAudio = m && m.tagName === 'AUDIO';
            if (/\.mp4(\?|#|$)/i.test(url)) {
                return '视频格式是 <b>mp4</b>，扩展无法过滤广告。';
            }
            if (/\.mpd(\?|#|$)/i.test(url)) {
                return '视频格式是 <b>DASH (mpd)</b>，扩展无法过滤广告。';
            }
            if (/\.m3u8(\?|#|$)/i.test(url)) {
                return '检测到浏览器可能使用<b>原生 HLS</b> 播放，<br>' +
                    '请求不经过扩展，无法过滤广告。<br><br>' +
                    '<b>点击扩展图标，在弹出面板中禁用原生 HLS</b>，然后刷新页面。';
            }
            if (isAudio) {
                return '音频流的 m3u8 未被检测到，扩展无法过滤。';
            }
            return '未检测到 m3u8 请求。<br>' +
                '可能是其他格式或加载方式，扩展无法过滤。<br>' +
                '尝试刷新页面（Ctrl+F5）后再试。';
        }

        function scheduleHintForUrl(url, m) {
            if (extensionDisabled) return;
            if (processedUrls.has(url) || hintedUrls.has(url)) return;
            if (pendingTimers.has(url)) return;

            const t = setTimeout(function () {
                pendingTimers.delete(url);
                if (extensionDisabled) return;
                if (processedUrls.has(url)) return;
                if (hintedUrls.has(url)) return;

                const curM = findMedia(document);
                const curUrl = getUrl(curM);
                if (curUrl !== url) return;

                checkBackground().then(function (has) {
                    if (extensionDisabled) return;
                    if (has) {
                        processedUrls.add(url);
                        return;
                    }
                    if (processedUrls.has(url) || hintedUrls.has(url)) return;
                    hintedUrls.add(url);

                    if (/\.m3u8(\?|#|$)/i.test(url) && !hlsDisabled) {
                        notifyNativeHlsSuspect();
                    }

                    showHint(
                        buildHintMessage(url, curM),
                        /\.m3u8(\?|#|$)/i.test(url) ? '#dc3545' : '#e8a13a'
                    );
                });
            }, HINT_DELAY_MS);

            pendingTimers.set(url, t);
        }

        window.addEventListener('message', function (e) {
            if (e.source !== window) return;
            const d = e.data;
            if (!d || d.source !== 'm3u8-ad-cleaner') return;
            if (d.type === 'disable') {
                removeHint();
                return;
            }
            if (d.type !== 'filtered') return;

            if (d.url) {
                processedUrls.add(d.url);
                if (pendingTimers.has(d.url)) {
                    clearTimeout(pendingTimers.get(d.url));
                    pendingTimers.delete(d.url);
                }
            }
            removeHint();
        });

        function poll() {
            if (extensionDisabled) return;
            const m = findMedia(document);
            if (!m) return;

            if (m.paused && m.currentTime < 0.5) return;

            const url = getUrl(m);
            if (!url) return;
            if (url === lastUrl) return;
            lastUrl = url;

            if (processedUrls.has(url)) return;
            if (hintedUrls.has(url)) return;

            if (/\.mpd(\?|#|$)/i.test(url) || /\.mp4(\?|#|$)/i.test(url)) {
                hintedUrls.add(url);
                showHint(buildHintMessage(url, m));
                return;
            }

            checkBackground().then(function (has) {
                if (extensionDisabled) return;
                if (has) {
                    processedUrls.add(url);
                    return;
                }
                scheduleHintForUrl(url, m);
            });
        }

        function start() {
            const go = function () {
                setInterval(poll, POLL_INTERVAL_MS);
            };
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', go, { once: true });
            } else {
                go();
            }
        }

        start();
    }

    // ============================================================
    // 主流程
    // ============================================================

    log('注入 @', host, 'queryHost=', queryHost);

    // 1. 无条件同步注入（砍掉所有 chrome.* 异步等待）
    injectAll();
    broadcastWhitelistPass();
    watchIframes();
    setupNoM3U8Detection();

    // 2. 异步查状态，只用于事后关闭 / 动态切换 disableHls
    chrome.storage.local.get({ debug: false }, function (dbg) {
        setDebug(dbg.debug);

        try {
            chrome.runtime.sendMessage({ type: 'getContentState', host: queryHost }, function (state) {
                if (chrome.runtime.lastError) {
                    warn('获取状态失败，保持注入:', chrome.runtime.lastError.message);
                    return;
                }
                if (!state || !state.enabled) {
                    log('本 frame 未启用，通知停手:', queryHost, state && state.reason);
                    suppressInjection();
                    return;
                }
                // 动态切换 disableHls（不再重新注入）
                if (state.hlsDisabled && !hlsDisabled) {
                    hlsDisabled = true;
                    // 延迟 50ms，等 inject.js 的监听器装好再发
                    setTimeout(function () {
                        window.postMessage({
                            source: 'm3u8-ad-cleaner',
                            type: 'setDisableHls',
                            value: true
                        }, '*');
                    }, 50);
                }
            });
        } catch (e) {
            warn('查询状态异常，保持注入:', e);
        }
    });

})();