// ============================================================
// M3U8 AD Cleaner - Popup (Chrome MV2)
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
        hlsBtn: document.getElementById('hlsBtn'),
        whitelistBtn: document.getElementById('whitelistBtn'),
        excludeBtn: document.getElementById('excludeBtn'),
        logBtn: document.getElementById('logBtn'),
        optionsBtn: document.getElementById('optionsBtn'),
        powerBtn: document.getElementById('powerBtn'),
        modeToggleBtn: document.getElementById('modeToggleBtn'),
        modeText: document.getElementById('modeText'),
        footerHint: document.getElementById('footerHint'),
        toast: document.getElementById('toast')
    };

    let currentTabId = -1;
    let currentHostname = '';
    let currentWhitelistMode = false;
    let currentInWhitelist = false;
    let currentInExtraExclude = false;
    let currentInHardExclude = false;
    let currentHlsDisabled = false;
    let currentNativeHlsSuspect = false;
    let currentEnabled = true;
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

    function sendMessage(msg, timeoutMs) {
        return Promise.race([
            new Promise(function (resolve, reject) {
                try {
                    chrome.runtime.sendMessage(msg, function (resp) {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        resolve(resp);
                    });
                } catch (e) {
                    reject(e);
                }
            }),
            new Promise(function (_, reject) {
                setTimeout(function () { reject(new Error('timeout')); }, timeoutMs || 600);
            })
        ]);
    }

    function queryTabs(timeoutMs) {
        return Promise.race([
            new Promise(function (resolve, reject) {
                try {
                    chrome.tabs.query({ active: true, currentWindow: true }, function (result) {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        resolve(result);
                    });
                } catch (e) {
                    reject(e);
                }
            }),
            new Promise(function (_, reject) {
                setTimeout(function () { reject(new Error('tabs.query timeout')); }, timeoutMs || 800);
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
        setTimeout(function () {
            try {
                if (currentTabId >= 0) {
                    chrome.tabs.reload(currentTabId, function () {
                        if (chrome.runtime.lastError) {}
                    });
                }
            } catch (e) {}
            window.close();
        }, delayMs || 100);
    }

    async function refresh() {
        el.hostname.textContent = '加载中…';
        setStatus('加载中', false);

        try {
            let tabs;
            try {
                tabs = await queryTabs(800);
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
                resp = await sendMessage({ type: 'getTabState', tabId: tab.id }, 600);
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
            currentHlsDisabled = !!resp.hlsDisabled;
            currentNativeHlsSuspect = !!resp.nativeHlsSuspect;
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

            // ---- 广告片段状态 ----
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

            // HLS 按钮：硬排除站点隐藏
            if (currentInHardExclude) {
                el.hlsBtn.style.display = 'none';
            } else if (currentHlsDisabled) {
                el.hlsBtn.style.display = '';
                el.hlsBtn.disabled = false;
                el.hlsBtn.textContent = '恢复原生 HLS';
                el.hlsBtn.classList.remove('ghost');
                el.hlsBtn.classList.add('warn');
            } else if (currentNativeHlsSuspect) {
                el.hlsBtn.style.display = '';
                el.hlsBtn.disabled = false;
                el.hlsBtn.textContent = '禁用原生 HLS';
                el.hlsBtn.classList.remove('warn');
                el.hlsBtn.classList.add('ghost');
            } else {
                el.hlsBtn.style.display = 'none';
            }

            if (el.hlsBtn.style.display !== 'none') {
                el.footerHint.innerHTML =
                    '切换状态、模式、名单或 HLS 后，页面会自动刷新。<br>' +
                    '如遇到视频问题，请恢复原生 HLS。';
            } else {
                el.footerHint.textContent = '切换状态、模式或名单后，页面会自动刷新。';
            }

            // 白名单按钮
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

            // 排除名单按钮
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

            el.exportAdBtn.disabled = !resp.hasExport;
            el.exportCleanBtn.disabled = !resp.hasExport;

        } catch (e) {
            console.error('[AD-Popup] refresh 失败:', e);
            showError('读取状态失败');
        }
    }

    function lockAllButtons(lock) {
        el.powerBtn.disabled = lock;
        el.modeToggleBtn.disabled = lock;
        el.hlsBtn.disabled = lock;
        el.whitelistBtn.disabled = lock;
        el.excludeBtn.disabled = lock;
    }

    el.logBtn.addEventListener('click', function () {
        chrome.tabs.create({ url: chrome.runtime.getURL('log.html') });
        window.close();
    });

    el.optionsBtn.addEventListener('click', function () {
        chrome.runtime.openOptionsPage();
        window.close();
    });

    el.powerBtn.addEventListener('click', async function () {
        lockAllButtons(true);
        try {
            const r = await sendMessage({ type: 'toggleEnabled', value: !currentEnabled }, 2000);
            if (r && r.ok) {
                showToast(r.enabled ? '已启用，正在刷新…' : '已禁用，正在刷新…', 1500);
                await reloadAndClose(100);
            } else {
                showToast('操作失败');
                lockAllButtons(false);
            }
        } catch (e) {
            showToast('操作失败');
            lockAllButtons(false);
        }
    });

    el.modeToggleBtn.addEventListener('click', async function () {
        lockAllButtons(true);
        try {
            const next = !currentWhitelistMode;
            await new Promise(function (resolve, reject) {
                chrome.storage.local.set({ whitelist_mode: next }, function () {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve();
                });
            });
            showToast(next ? '已切换到白名单模式，正在刷新…' : '已切换到全匹配模式，正在刷新…', 1500);
            await reloadAndClose(100);
        } catch (e) {
            showToast('操作失败');
            lockAllButtons(false);
        }
    });

    el.hlsBtn.addEventListener('click', async function () {
        if (!currentHostname) return;
        lockAllButtons(true);
        try {
            const r = await sendMessage({
                type: 'toggleDisableHlsCurrent',
                host: currentHostname
            }, 2000);
            if (r && r.ok) {
                if (r.action === 'removed') {
                    if (r.removedHost === currentHostname) {
                        showToast('已恢复原生 HLS，正在刷新…', 1500);
                    } else {
                        showToast('已移除覆盖域名 ' + r.removedHost + '，正在刷新…', 1800);
                    }
                } else {
                    const n = (r.replacedHosts || []).length;
                    showToast(n > 0 ? '已禁用原生 HLS（取代 ' + n + ' 个子域），正在刷新…' : '已禁用原生 HLS，正在刷新…', 1800);
                }
                await reloadAndClose(100);
            } else {
                showToast('操作失败');
                lockAllButtons(false);
            }
        } catch (e) {
            showToast('操作失败');
            lockAllButtons(false);
        }
    });

    el.whitelistBtn.addEventListener('click', async function () {
        if (!currentHostname) return;
        lockAllButtons(true);
        try {
            const r = await sendMessage({
                type: 'toggleWhitelistCurrent',
                host: currentHostname
            }, 2000);
            if (r && r.ok) {
                if (r.action === 'removed') {
                    if (r.removedHost === currentHostname) {
                        showToast('已移出白名单，正在刷新…', 1500);
                    } else {
                        showToast('已移除覆盖域名 ' + r.removedHost + '，正在刷新…', 1800);
                    }
                } else {
                    const n = (r.replacedHosts || []).length;
                    showToast(n > 0 ? '已加入白名单（取代 ' + n + ' 个子域），正在刷新…' : '已加入白名单，正在刷新…', 1800);
                }
                await reloadAndClose(100);
            } else if (r && r.action === 'hard-excluded') {
                showToast('该域名在内置排除名单中，无法加入白名单', 3500);
                lockAllButtons(false);
            } else {
                showToast('操作失败');
                lockAllButtons(false);
            }
        } catch (e) {
            showToast('操作失败');
            lockAllButtons(false);
        }
    });

    el.excludeBtn.addEventListener('click', async function () {
        if (!currentHostname) return;
        lockAllButtons(true);
        try {
            const r = await sendMessage({
                type: 'toggleExcludeCurrent',
                host: currentHostname
            }, 2000);
            if (r && r.ok) {
                if (r.action === 'removed') {
                    if (r.removedHost === currentHostname) {
                        showToast('已移出排除名单，正在刷新…', 1500);
                    } else {
                        showToast('已移除覆盖域名 ' + r.removedHost + '，正在刷新…', 1800);
                    }
                } else {
                    const n = (r.replacedHosts || []).length;
                    showToast(n > 0 ? '已加入排除名单（取代 ' + n + ' 个子域），正在刷新…' : '已加入排除名单，正在刷新…', 1800);
                }
                await reloadAndClose(100);
            } else if (r && r.action === 'hard-excluded') {
                showToast('该域名已在内置排除名单中', 3000);
                lockAllButtons(false);
            } else {
                showToast('操作失败');
                lockAllButtons(false);
            }
        } catch (e) {
            showToast('操作失败');
            lockAllButtons(false);
        }
    });

    el.exportAdBtn.addEventListener('click', function () {
        if (currentTabId < 0) return;
        el.exportAdBtn.disabled = true;
        showToast('准备导出…', 60000);
        chrome.runtime.sendMessage({ type: 'exportAd', tabId: currentTabId }, function (r) {
            if (r && r.ok) {
                showToast('已开始下载：' + r.filename + '（' + r.count + ' 行）');
            } else {
                showToast('导出失败：' + ((r && r.error) || '未知错误'), 4000);
            }
            setTimeout(refresh, 600);
        });
    });

    el.exportCleanBtn.addEventListener('click', function () {
        if (currentTabId < 0) return;
        el.exportCleanBtn.disabled = true;
        showToast('准备导出…', 60000);
        chrome.runtime.sendMessage({ type: 'exportClean', tabId: currentTabId }, function (r) {
            if (r && r.ok) {
                showToast('已开始下载：' + r.filename);
            } else {
                showToast('导出失败：' + ((r && r.error) || '未知错误'), 4000);
            }
            setTimeout(refresh, 600);
        });
    });

    refresh();

})();