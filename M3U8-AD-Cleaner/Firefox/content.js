// ============================================================
// M3U8 AD Cleaner - Content Script
// ============================================================

(function () {
    'use strict';

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

    browser.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.debug) setDebug(changes.debug.newValue);
    });

    let injected = false;
    let parentPassed = false;
    let extensionDisabled = false;

    function injectScript(src, onload) {
        const script = document.createElement('script');
        script.src = src;
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
        injectScript(browser.runtime.getURL('filter.js'), function () {
            injectScript(browser.runtime.getURL('inject.js'));
        });
    }

    browser.runtime.onMessage.addListener(function (msg) {
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

    window.addEventListener('message', function (e) {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== 'm3u8-ad-cleaner') return;
        if (extensionDisabled) return;

        if (d.type === 'filtered') {
            try {
                browser.runtime.sendMessage({
                    type: 'm3u8Filtered',
                    url: d.url,
                    adsCount: d.adsCount,
                    ads: d.ads,
                    headLines: d.headLines,
                    filtered: d.filtered,
                    modeName: d.modeName,
                    rules: d.rules
                }).catch(function () {});
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
                browser.runtime.sendMessage(msg).catch(function () {});
            } catch (err) {
                console.error('[AD-CS] 转发失败:', err);
            }
            return;
        }

        if (d.type === 'm3u8Pending') {
            try {
                browser.runtime.sendMessage({
                    type: 'm3u8Pending',
                    url: d.url
                }).catch(function () {});
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
    // 未检测到 m3u8 的提示
    // ============================================================
    function setupNoM3U8Detection() {
        if (window !== window.top) return;

        const HINT_DELAY_MS = 8000;
        const POLL_INTERVAL_MS = 1000;

        const processedUrls = new Set();
        const resolvedUrls = new Set();
        const pendingTimers = new Map();

        let hintEl = null;
        let lastUrl = '';

        function removeHint() {
            if (hintEl && hintEl.isConnected) hintEl.remove();
            hintEl = null;
        }

        function showHint(html) {
            if (extensionDisabled) return;
            if (hintEl && hintEl.isConnected) return;
            if (!document.body) return;
            hintEl = document.createElement('div');
            hintEl.id = 'm3u8ar-nom3u8';
            hintEl.style.cssText =
                'position:fixed;top:16px;right:16px;z-index:2147483647;' +
                'max-width:320px;padding:12px 30px 12px 14px;border-radius:10px;' +
                'background:#e8a13a;color:#fff;font-size:13px;line-height:1.5;' +
                'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
                'box-shadow:0 6px 18px rgba(0,0,0,.15)';
            const closeBtn = document.createElement('span');
            closeBtn.className = 'm3u8ar-hint-close';
            closeBtn.style.cssText = 'position:absolute;top:6px;right:10px;cursor:pointer;font-size:16px;line-height:1;opacity:.7';
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
            }, 10000);
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
            try {
                return browser.runtime.sendMessage({ type: 'checkSeen' })
                    .then(function (r) {
                        return {
                            seen: !!(r && r.seen),
                            seenMedia: !!(r && r.seenMedia)
                        };
                    })
                    .catch(function () {
                        return { seen: false, seenMedia: false };
                    });
            } catch (e) {
                return Promise.resolve({ seen: false, seenMedia: false });
            }
        }

        function buildHintMessage(url, m) {
            const isAudio = m && m.tagName === 'AUDIO';
            let msg = '未检测到 m3u8 请求。<br>';
            if (/\.mp4(\?|#|$)/i.test(url)) {
                msg += '视频格式是 <b>mp4</b>，扩展无法过滤广告。';
            } else if (/\.mpd(\?|#|$)/i.test(url)) {
                msg += '视频格式是 <b>DASH (mpd)</b>，扩展无法过滤广告。';
            } else if (isAudio) {
                msg += '音频流的 m3u8 未被检测到，扩展无法过滤。';
            } else {
                msg += '可能是其他格式或加载方式，扩展无法过滤。<br>尝试刷新页面（Ctrl+F5）后再试。';
            }
            return msg;
        }

        function scheduleHintForUrl(url, m) {
            if (extensionDisabled) return;
            if (processedUrls.has(url) || resolvedUrls.has(url)) return;
            if (pendingTimers.has(url)) return;

            const t = setTimeout(function () {
                pendingTimers.delete(url);
                if (extensionDisabled) return;
                if (processedUrls.has(url)) return;
                if (resolvedUrls.has(url)) return;

                const curM = findMedia(document);
                const curUrl = getUrl(curM);
                if (curUrl !== url) return;

                checkBackground().then(function (r) {
                    if (extensionDisabled) return;
                    if (r.seen) {
                        processedUrls.add(url);
                        return;
                    }
                    if (r.seenMedia) {
                        resolvedUrls.add(url);
                        return;
                    }
                    if (processedUrls.has(url) || resolvedUrls.has(url)) return;
                    resolvedUrls.add(url);
                    showHint(buildHintMessage(url, curM));
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
            if (resolvedUrls.has(url)) return;

            if (/\.mpd(\?|#|$)/i.test(url)) {
                resolvedUrls.add(url);
                showHint(buildHintMessage(url, m));
                return;
            }

            checkBackground().then(function (r) {
                if (extensionDisabled) return;
                if (r.seen) {
                    processedUrls.add(url);
                    return;
                }
                if (r.seenMedia) {
                    // 视频在加载，但格式不是 m3u8（mp4/dash/加密）
                    // 刷新也没用，不提示
                    resolvedUrls.add(url);
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
    // 向 background 查询本 frame 是否启用
    // ============================================================
    const host = location.hostname;
    if (!host) {
        browser.storage.local.get({ debug: false }).then(function (data) {
            setDebug(data.debug);
            if (extensionDisabled) return;
            injectAll();
            broadcastWhitelistPass();
            watchIframes();
            setupNoM3U8Detection();
        }).catch(function () {
            if (extensionDisabled) return;
            injectAll();
            broadcastWhitelistPass();
            watchIframes();
            setupNoM3U8Detection();
        });
        return;
    }

    Promise.all([
        browser.runtime.sendMessage({ type: 'getContentState', host: host }),
        browser.storage.local.get({ debug: false })
    ]).then(function (arr) {
        const state = arr[0];
        setDebug(arr[1].debug);
        if (extensionDisabled) return;
        if (state && state.enabled) {
            injectAll();
            broadcastWhitelistPass();
            watchIframes();
            setupNoM3U8Detection();
        } else {
            log('本 frame 未启用:', host, state && state.reason);
        }
    }).catch(function (e) {
        if (extensionDisabled) return;
        warn('[AD-CS] 获取状态失败，默认注入:', e);
        browser.storage.local.get({ debug: false }).then(function (data) {
            setDebug(data.debug);
            injectAll();
            setupNoM3U8Detection();
        }).catch(function () {
            injectAll();
            setupNoM3U8Detection();
        });
    });

})();