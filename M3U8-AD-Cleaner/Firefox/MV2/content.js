// ============================================================
// M3U8 AD Cleaner - Content Script (Firefox)
//
// 职责：
//   - 检测"未检测到 m3u8"并提示用户（8 秒未收到 checkSeen 命中）
//   - 响应 debug 开关变化
//
// 过滤主逻辑全部在 background 的 webRequest.filterResponseData，
// 本脚本不参与任何 m3u8 拦截。
// ============================================================

(function () {
    'use strict';

    let DEBUG = false;
    function log(...args) { if (DEBUG) console.log('[AD-CS]', ...args); }
    function warn(...args) { if (DEBUG) console.warn('[AD-CS]', ...args); }

    function setDebug(v) {
        DEBUG = !!v;
    }

    browser.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.debug) setDebug(changes.debug.newValue);
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
            if (processedUrls.has(url) || resolvedUrls.has(url)) return;
            if (pendingTimers.has(url)) return;

            const t = setTimeout(function () {
                pendingTimers.delete(url);
                if (processedUrls.has(url)) return;
                if (resolvedUrls.has(url)) return;

                const curM = findMedia(document);
                const curUrl = getUrl(curM);
                if (curUrl !== url) return;

                checkBackground().then(function (r) {
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

        function poll() {
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
                if (r.seen) {
                    processedUrls.add(url);
                    return;
                }
                if (r.seenMedia) {
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
    // 启动
    // ============================================================
    browser.storage.local.get({ debug: false }).then(function (data) {
        setDebug(data.debug);
        setupNoM3U8Detection();
    }).catch(function () {
        setupNoM3U8Detection();
    });

})();