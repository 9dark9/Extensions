// ============================================================
// M3U8 AD Cleaner - Popup
// ============================================================

(function () {
    'use strict';

    const el = {
        hostname: document.getElementById('hostname'),
        status: document.getElementById('status'),
        count: document.getElementById('count'),
        adInfo: document.getElementById('adInfo'),
        lastUrl: document.getElementById('lastUrl'),
        lastUrlRow: document.getElementById('lastUrlRow'),
        exportAdBtn: document.getElementById('exportAdBtn'),
        exportCleanBtn: document.getElementById('exportCleanBtn'),
        whitelistBtn: document.getElementById('whitelistBtn'),
        excludeBtn: document.getElementById('excludeBtn'),
        logBtn: document.getElementById('logBtn'),
        optionsBtn: document.getElementById('optionsBtn'),
        powerBtn: document.getElementById('powerBtn'),
        modeToggleBtn: document.getElementById('modeToggleBtn'),
        modeText: document.getElementById('modeText'),
        toast: document.getElementById('toast')
    };

    let currentTabId = -1;
    let currentHostname = '';
    let currentWhitelistMode = false;
    let currentInWhitelist = false;
    let currentInExtraExclude = false;
    let currentInHardExclude = false;
    let currentEnabled = true;
    let currentOs = '';
    let toastTimer = null;

    function showToast(text, duration) {
        el.toast.textContent = text;
        el.toast.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.toast.classList.remove('show');
        }, duration || 2500);
    }

    function setStatus(text, on) {
        const statusSpan = document.createElement('span');
        statusSpan.className = 'status';

        const dotSpan = document.createElement('span');
        dotSpan.className = 'dot ' + (on ? 'on' : 'off');

        statusSpan.appendChild(dotSpan);
        statusSpan.appendChild(document.createTextNode(text));

        el.status.textContent = '';
        el.status.appendChild(statusSpan);
    }

    function setCount(n) {
        el.count.textContent = String(n);
        el.count.classList.toggle('zero', n === 0);
    }

    function showError(msg) {
        setStatus(msg, false);
        el.hostname.textContent = '—';
        el.count.textContent = '0';
        el.adInfo.textContent = '—';
        el.exportAdBtn.disabled = true;
        el.exportCleanBtn.disabled = true;
    }

    function sendMessageWithTimeout(msg, ms) {
        return Promise.race([
            browser.runtime.sendMessage(msg),
            new Promise(function (_, reject) {
                setTimeout(function () { reject(new Error('timeout')); }, ms || 600);
            })
        ]);
    }

    function statusToText(status) {
        switch (status) {
            case 'active': return '过滤中';
            case 'hard-excluded': return '内置排除';
            case 'extra-excluded': return '已排除';
            case 'not-in-whitelist': return '不在白名单';
            default: return '未知';
        }
    }

    async function reloadAndClose(delayMs) {
        setTimeout(async function () {
            try {
                if (currentTabId >= 0) await browser.tabs.reload(currentTabId);
            } catch (e) {}
            window.close();
        }, delayMs || 100);
    }

    async function loadPlatform() {
        try {
            const info = await browser.runtime.getPlatformInfo();
            currentOs = (info && info.os) || '';
        } catch (e) {
            currentOs = '';
        }
    }

    function triggerDownloadInPopup(text, filename) {
        const blob = new Blob([text], { type: 'application/vnd.apple.mpegurl' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            a.remove();
            try { URL.revokeObjectURL(url); } catch (e) {}
        }, 1000);
    }

    async function doExport(kind) {
        if (currentTabId < 0) return;
        const btn = kind === 'ad' ? el.exportAdBtn : el.exportCleanBtn;
        btn.disabled = true;

        try {
            const r = await browser.runtime.sendMessage({
                type: kind === 'ad' ? 'exportAd' : 'exportClean',
                tabId: currentTabId
            });

            if (!r || !r.ok) {
                showToast('导出失败：' + ((r && r.error) || '未知错误'), 4000);
                btn.disabled = false;
                return;
            }

            if (currentOs === 'android') {
                triggerDownloadInPopup(r.text, r.filename);
            } else {
                const rr = await browser.runtime.sendMessage({
                    type: 'downloadSaveAs',
                    text: r.text,
                    filename: r.filename
                });
                if (!rr || !rr.ok) {
                    showToast('保存失败：' + ((rr && rr.error) || '未知错误'), 4000);
                }
            }
        } catch (e) {
            showToast('导出失败：' + e.message, 4000);
        } finally {
            setTimeout(refresh, 800);
        }
    }

    async function refresh() {
        el.hostname.textContent = '加载中…';
        setStatus('加载中', false);

        try {
            let tabs;
            try {
                tabs = await Promise.race([
                    browser.tabs.query({ active: true, currentWindow: true }),
                    new Promise(function (_, reject) {
                        setTimeout(function () { reject(new Error('tabs.query timeout')); }, 800);
                    })
                ]);
            } catch (e) {
                console.error('[AD-Popup] tabs.query 超时:', e);
                el.hostname.textContent = '—';
                setStatus('标签页读取超时', false);
                return;
            }

            if (!tabs || !tabs.length) {
                showError('未找到活动标签页');
                return;
            }

            const tab = tabs[0];
            currentTabId = tab.id;

            let hostname = '';
            try { hostname = new URL(tab.url).hostname; } catch (e) {}
            currentHostname = hostname;
            el.hostname.textContent = hostname || '—';

            let resp = null;
            try {
                resp = await sendMessageWithTimeout({
                    type: 'getTabState',
                    tabId: tab.id
                }, 600);
            } catch (e) {
                console.error('[AD-Popup] getTabState 超时:', e);
                setStatus('后台繁忙', false);
                return;
            }

            if (!resp) {
                setStatus('未知', false);
                setCount(0);
                return;
            }

            currentWhitelistMode = resp.whitelistMode;
            currentInWhitelist = !!resp.inWhitelist;
            currentInExtraExclude = !!resp.inExtraExclude;
            currentInHardExclude = !!resp.inHardExclude;
            currentEnabled = resp.enabled !== false;

            if (currentEnabled) {
                el.powerBtn.classList.add('on');
                el.powerBtn.title = '已启用（点击禁用）';
            } else {
                el.powerBtn.classList.remove('on');
                el.powerBtn.title = '已禁用（点击启用）';
            }

            el.modeText.textContent = currentWhitelistMode ? '白名单模式' : '全匹配模式';

            const statusText = statusToText(resp.status);
            setStatus(statusText, resp.status === 'active');
            setCount(resp.filterCount || 0);

            const detect = resp.detect || { seen: false, outcome: 'none', parseError: '' };
            let adInfoText = '—';

            if (detect.outcome === 'pending') {
                adInfoText = '检查中…';
            } else if (detect.outcome === 'filtered') {
                adInfoText = (resp.adLineCount || 0) + ' 行';
            } else if (detect.outcome === 'no-ads') {
                adInfoText = '已检查，未发现广告';
            } else if (detect.outcome === 'invalid') {
                const pe = detect.parseError;
                if (pe === 'empty') adInfoText = '响应为空';
                else if (pe === 'html') adInfoText = '响应是 HTML';
                else if (pe === 'not-m3u8') adInfoText = '响应不是 m3u8';
                else if (pe === 'empty-playlist') adInfoText = 'm3u8 无分片';
                else adInfoText = '响应无效';
            } else if (detect.outcome === 'parse-error') {
                adInfoText = '解析失败';
            } else if (detect.seen) {
                adInfoText = '检查中…';
            }

            el.adInfo.textContent = adInfoText;

            if (resp.lastUrl) {
                el.lastUrlRow.style.display = '';
                el.lastUrl.textContent = resp.lastUrl.length > 42
                    ? resp.lastUrl.slice(0, 42) + '…'
                    : resp.lastUrl;
            } else {
                el.lastUrlRow.style.display = 'none';
            }

            if (!currentWhitelistMode || currentInHardExclude) {
                el.whitelistBtn.style.display = 'none';
            } else if (currentInWhitelist) {
                el.whitelistBtn.style.display = '';
                el.whitelistBtn.disabled = false;
                el.whitelistBtn.textContent = '移出白名单';
                el.whitelistBtn.classList.remove('ghost');
                el.whitelistBtn.classList.add('warn');
            } else {
                el.whitelistBtn.style.display = '';
                el.whitelistBtn.disabled = false;
                el.whitelistBtn.textContent = '加入白名单';
                el.whitelistBtn.classList.remove('warn');
                el.whitelistBtn.classList.add('ghost');
            }

            if (currentInHardExclude) {
                el.excludeBtn.style.display = 'none';
            } else {
                el.excludeBtn.style.display = '';
                el.excludeBtn.disabled = false;
                if (currentInExtraExclude) {
                    el.excludeBtn.textContent = '移出排除名单';
                    el.excludeBtn.classList.remove('ghost');
                    el.excludeBtn.classList.add('warn');
                } else {
                    el.excludeBtn.textContent = '加入排除名单';
                    el.excludeBtn.classList.remove('warn');
                    el.excludeBtn.classList.add('ghost');
                }
            }

            el.exportAdBtn.disabled = !resp.hasExportAd;
            el.exportCleanBtn.disabled = !resp.hasExportClean;

        } catch (e) {
            console.error('[AD-Popup] refresh 失败:', e);
            showError('读取状态失败');
        }
    }

    el.logBtn.addEventListener('click', function () {
        browser.tabs.create({ url: browser.runtime.getURL('log.html') });
        window.close();
    });

    el.optionsBtn.addEventListener('click', function () {
        if (currentOs === 'android') {
            browser.tabs.create({ url: browser.runtime.getURL('options.html') });
        } else {
            browser.runtime.openOptionsPage();
        }
        window.close();
    });

    el.powerBtn.addEventListener('click', async function () {
        el.powerBtn.disabled = true;
        el.modeToggleBtn.disabled = true;
        el.whitelistBtn.disabled = true;
        el.excludeBtn.disabled = true;
        try {
            const r = await browser.runtime.sendMessage({
                type: 'toggleEnabled',
                value: !currentEnabled
            });
            if (r && r.ok) {
                showToast(r.enabled ? '已启用，正在刷新…' : '已禁用，正在刷新…', 1500);
                await reloadAndClose(100);
            } else {
                showToast('操作失败');
                el.powerBtn.disabled = false;
                el.modeToggleBtn.disabled = false;
                el.whitelistBtn.disabled = false;
                el.excludeBtn.disabled = false;
            }
        } catch (e) {
            showToast('操作失败');
            el.powerBtn.disabled = false;
            el.modeToggleBtn.disabled = false;
            el.whitelistBtn.disabled = false;
            el.excludeBtn.disabled = false;
        }
    });

    el.modeToggleBtn.addEventListener('click', async function () {
        el.modeToggleBtn.disabled = true;
        el.powerBtn.disabled = true;
        el.whitelistBtn.disabled = true;
        el.excludeBtn.disabled = true;
        try {
            const next = !currentWhitelistMode;
            await browser.storage.local.set({ whitelist_mode: next });
            showToast(next ? '已切换到白名单模式，正在刷新…' : '已切换到全匹配模式，正在刷新…', 1500);
            await reloadAndClose(100);
        } catch (e) {
            showToast('操作失败');
            el.modeToggleBtn.disabled = false;
            el.powerBtn.disabled = false;
            el.whitelistBtn.disabled = false;
            el.excludeBtn.disabled = false;
        }
    });

    el.whitelistBtn.addEventListener('click', async function () {
        if (!currentHostname) return;
        el.whitelistBtn.disabled = true;
        el.excludeBtn.disabled = true;
        el.powerBtn.disabled = true;
        el.modeToggleBtn.disabled = true;
        try {
            const r = await browser.runtime.sendMessage({
                type: 'toggleWhitelistCurrent',
                host: currentHostname
            });
            if (r && r.ok) {
                if (r.action === 'removed') {
                    if (r.removedHost === currentHostname) {
                        showToast('已移出白名单，正在刷新…', 1500);
                    } else {
                        showToast('已移除覆盖域名 ' + r.removedHost + '，正在刷新…', 1800);
                    }
                } else {
                    const n = (r.replacedHosts || []).length;
                    showToast(n > 0 ? '已加入（取代 ' + n + ' 个子域），正在刷新…' : '已加入白名单，正在刷新…', 1800);
                }
                await reloadAndClose(100);
            } else if (r && r.action === 'hard-excluded') {
                showToast('该域名在内置排除名单中，无法加入白名单', 3500);
                el.whitelistBtn.disabled = false;
                el.excludeBtn.disabled = false;
                el.powerBtn.disabled = false;
                el.modeToggleBtn.disabled = false;
            } else {
                showToast('操作失败');
                el.whitelistBtn.disabled = false;
                el.excludeBtn.disabled = false;
                el.powerBtn.disabled = false;
                el.modeToggleBtn.disabled = false;
            }
        } catch (e) {
            showToast('操作失败');
            el.whitelistBtn.disabled = false;
            el.excludeBtn.disabled = false;
            el.powerBtn.disabled = false;
            el.modeToggleBtn.disabled = false;
        }
    });

    el.excludeBtn.addEventListener('click', async function () {
        if (!currentHostname) return;
        el.excludeBtn.disabled = true;
        el.whitelistBtn.disabled = true;
        el.powerBtn.disabled = true;
        el.modeToggleBtn.disabled = true;
        try {
            const r = await browser.runtime.sendMessage({
                type: 'toggleExcludeCurrent',
                host: currentHostname
            });
            if (r && r.ok) {
                if (r.action === 'removed') {
                    if (r.removedHost === currentHostname) {
                        showToast('已移出排除名单，正在刷新…', 1500);
                    } else {
                        showToast('已移除覆盖域名 ' + r.removedHost + '，正在刷新…', 1800);
                    }
                } else {
                    const n = (r.replacedHosts || []).length;
                    showToast(n > 0 ? '已加入（取代 ' + n + ' 个子域），正在刷新…' : '已加入排除名单，正在刷新…', 1800);
                }
                await reloadAndClose(100);
            } else if (r && r.action === 'hard-excluded') {
                showToast('该域名已在内置排除名单中', 3000);
                el.excludeBtn.disabled = false;
                el.whitelistBtn.disabled = false;
                el.powerBtn.disabled = false;
                el.modeToggleBtn.disabled = false;
            } else {
                showToast('操作失败');
                el.excludeBtn.disabled = false;
                el.whitelistBtn.disabled = false;
                el.powerBtn.disabled = false;
                el.modeToggleBtn.disabled = false;
            }
        } catch (e) {
            showToast('操作失败');
            el.excludeBtn.disabled = false;
            el.whitelistBtn.disabled = false;
            el.powerBtn.disabled = false;
            el.modeToggleBtn.disabled = false;
        }
    });

    el.exportAdBtn.addEventListener('click', function () {
        doExport('ad');
    });

    el.exportCleanBtn.addEventListener('click', function () {
        doExport('clean');
    });

    // 启动
    (async function init() {
        await loadPlatform();
        await refresh();
    })();

})();