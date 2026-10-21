// ============================================================
// M3U8 AD Cleaner - Content Script (Chrome MV3)
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
        try {
            window.postMessage({
                source: 'm3u8-ad-cleaner',
                type: 'debug',
                value: DEBUG
            }, '*');
        } catch (e) {}
    }

    // ---- 状态 ----
    let extensionDisabled = false;
    let lastQueriedUrl = '';
    let iframesWatched = false;
    let lastAppliedEnabled = null;   // B3：状态变化检测，避免级联广播风暴

    // ============================================================
    // 启用 / 禁用
    // ============================================================
    function suppressInjection() {
        if (extensionDisabled) return;
        extensionDisabled = true;
        log('suppress injection @', location.href);
        try {
            window.postMessage({
                source: 'm3u8-ad-cleaner',
                type: 'disable'
            }, '*');
        } catch (e) {}
    }

    function resumeInjection() {
        if (!extensionDisabled) return;
        extensionDisabled = false;
        log('resume injection @', location.href);
        try {
            window.postMessage({
                source: 'm3u8-ad-cleaner',
                type: 'enable'
            }, '*');
        } catch (e) {}
    }

    // ============================================================
    // 状态查询与广播
    // ============================================================
    function queryAndApplyState(url) {
        if (!url) url = location.href;
        if (url === lastQueriedUrl) return;
        lastQueriedUrl = url;

        try {
            chrome.runtime.sendMessage({ type: 'getContentState', url: url }, function (state) {
                if (chrome.runtime.lastError) {
                    warn('获取状态失败:', chrome.runtime.lastError.message);
                    if (lastQueriedUrl === url) lastQueriedUrl = '';
                    return;
                }
                if (!state) {
                    if (lastQueriedUrl === url) lastQueriedUrl = '';
                    return;
                }

                const nextEnabled = !!state.enabled;

                if (nextEnabled) resumeInjection();
                else suppressInjection();

                // B3：只在状态实际变化时广播，避免级联风暴
                if (lastAppliedEnabled !== nextEnabled) {
                    lastAppliedEnabled = nextEnabled;
                    broadcastStateChange();
                    watchIframes();
                }

                if (state.hlsDisabled) {
                    try {
                        window.postMessage({
                            source: 'm3u8-ad-cleaner',
                            type: 'setDisableHls',
                            value: true
                        }, '*');
                    } catch (e) {}
                }

                // 查询期间 URL 变了：重新查询
                if (location.href !== url) {
                    lastQueriedUrl = '';
                    queryAndApplyState(location.href);
                }
            });
        } catch (e) {
            if (lastQueriedUrl === url) lastQueriedUrl = '';
            warn('查询状态异常:', e);
        }
    }

    // ============================================================
    // 广播（B3：不再限制顶层，所有 frame 都向下广播）
    // 通过 lastAppliedEnabled 防级联：只有状态实际变化才广播
    // ============================================================
    function broadcastStateChange() {
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
        if (iframesWatched) return;
        iframesWatched = true;
        try {
            let timer = null;
            const mo = new MutationObserver(function () {
                if (timer) return;
                timer = setTimeout(function () {
                    timer = null;
                    broadcastStateChange();
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

    // ============================================================
    // 接收父框架通知：重新查询 background
    // ============================================================
    window.addEventListener('message', function (e) {
        const d = e.data;
        if (!d || d.__m3u8ar !== true || d.type !== 'whitelistPass') return;

        lastQueriedUrl = '';
        queryAndApplyState(location.href);
    });

    // ============================================================
    // 存储变化监听
    // ============================================================
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.debug) setDebug(changes.debug.newValue);
        if (changes.disable_hls_hosts) checkDisableHlsAndNotify();
        if (changes.whitelist_mode || changes.whitelist_hosts ||
            changes.extra_exclude_hosts || changes.enabled) {
            lastQueriedUrl = '';
            queryAndApplyState(location.href);
        }
    });

    // ============================================================
    // 禁用原生 HLS 相关
    // ============================================================
    function checkDisableHlsAndNotify() {
        const h = location.hostname.toLowerCase();
        if (!h) return;
        chrome.storage.local.get({ disable_hls_hosts: [] }, function (data) {
            const list = Array.isArray(data.disable_hls_hosts) ? data.disable_hls_hosts : [];
            let hit = false;
            for (let i = 0; i < list.length; i++) {
                const d = String(list[i]).toLowerCase();
                if (d && (h === d || h.endsWith('.' + d))) { hit = true; break; }
            }
            if (!hit) return;
            try {
                window.postMessage({
                    source: 'm3u8-ad-cleaner',
                    type: 'setDisableHls',
                    value: true
                }, '*');
            } catch (e) {}
        });
    }

    checkDisableHlsAndNotify();

    // ============================================================
    // 扩展全局启用/禁用切换
    // ============================================================
    chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || msg.type !== 'extensionToggled') return;
        if (msg.enabled === false) {
            suppressInjection();
        } else {
            lastQueriedUrl = '';
            queryAndApplyState(location.href);
        }
    });

    // ============================================================
    // 业务消息转发（filtered / status / pending / networkError）
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
    // SPA URL 变化监听（inject.js 发来 urlChange）
    // ============================================================
    window.addEventListener('message', function (e) {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== 'm3u8-ad-cleaner') return;
        if (d.type === 'urlChange') {
            queryAndApplyState(location.href);
        }
    });

    // 定时兜底检查（O3：页面隐藏时跳过）
    let lastCheckUrl = location.href;
    setInterval(function () {
        if (document.hidden) return;
        if (location.href !== lastCheckUrl) {
            lastCheckUrl = location.href;
            queryAndApplyState(location.href);
        }
    }, 800);

    // ============================================================
    // 无 m3u8 提示检测
    // ============================================================
    function setupNoM3U8Detection() {
        if (window !== window.top) return;

        const HINT_DELAY_MS = 2000;
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

                    if (/\.m3u8(\?|#|$)/i.test(url)) {
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

            if (/\.m3u8(\?|#|$)/i.test(url)) {
                notifyNativeHlsSuspect();
            }

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
    const host = location.hostname;
    log('注入 @', host);

    setupNoM3U8Detection();

    chrome.storage.local.get({ debug: false }, function (dbg) {
        setDebug(dbg.debug);
        queryAndApplyState(location.href);
    });

})();