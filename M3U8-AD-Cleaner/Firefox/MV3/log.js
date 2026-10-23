// ============================================================
// M3U8 AD Cleaner - Log Viewer (Firefox MV3)
//
// 直接读 browser.storage.session 的 logBuffer，
// 监听 storage.session.onChanged 实现零轮询自动刷新。
// ============================================================

(function () {
    'use strict';

    const el = {
        meta: document.getElementById('meta'),
        content: document.getElementById('content'),
        refreshBtn: document.getElementById('refreshBtn'),
        clearBtn: document.getElementById('clearBtn'),
        closeBtn: document.getElementById('closeBtn'),
        autoRefresh: document.getElementById('autoRefresh'),
        copyAllBtn: document.getElementById('copyAllBtn'),
        exportBtn: document.getElementById('exportBtn')
    };

    let autoRefreshBound = false;
    let lastLogs = [];
    let lastRenderedCount = 0;
    let lastFirstLogTime = 0;

    function formatTime(ts) {
        const d = new Date(ts);
        const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function typeLabel(t) {
        switch (t) {
            case 'filter': return '过滤';
            case 'error': return '错误';
            case 'export': return '导出';
            case 'system': return '系统';
            case 'diag': return '诊断';
            default: return t || '—';
        }
    }

    function renderAdsBlock(entry) {
        if (!entry.ads || entry.ads.length === 0) return null;

        const content = entry.ads
            .filter(function (l) { return l && l.length > 0; })
            .join('\n');

        const blockDiv = document.createElement('div');
        blockDiv.className = 'ad-block';

        const labelDiv = document.createElement('div');
        labelDiv.className = 'ad-label';
        const total = entry.removedLines || entry.ads.length;
        if (total > entry.ads.length) {
            labelDiv.textContent = '被删内容 ' + total + ' 行（下方仅显示前 ' + entry.ads.length + ' 行）：';
        } else {
            labelDiv.textContent = '被删内容 ' + entry.ads.length + ' 行：';
        }

        const preEl = document.createElement('pre');
        preEl.className = 'ad-pre';
        preEl.textContent = content;

        blockDiv.appendChild(labelDiv);
        blockDiv.appendChild(preEl);
        return blockDiv;
    }

    function renderLogCard(entry) {
        const cls = entry.type || 'system';

        const cardDiv = document.createElement('div');
        cardDiv.className = 'log-card';

        const headerDiv = document.createElement('div');
        headerDiv.className = 'log-header';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-time';
        timeSpan.textContent = formatTime(entry.time);

        const typeSpan = document.createElement('span');
        typeSpan.className = 'log-type ' + cls;
        typeSpan.textContent = typeLabel(entry.type);

        headerDiv.appendChild(timeSpan);
        headerDiv.appendChild(typeSpan);

        const textDiv = document.createElement('div');
        textDiv.className = 'log-text';
        textDiv.textContent = entry.text;

        cardDiv.appendChild(headerDiv);
        cardDiv.appendChild(textDiv);

        if (entry.type === 'filter') {
            const adsBlock = renderAdsBlock(entry);
            if (adsBlock) cardDiv.appendChild(adsBlock);
        }

        return cardDiv;
    }

    async function load(force) {
        try {
            const data = await browser.storage.session.get({ logBuffer: [] });
            const logs = data.logBuffer || [];
            lastLogs = logs;

            const version = browser.runtime.getManifest().version;
            el.meta.textContent = '当前共 ' + logs.length + ' 条日志 | 扩展版本 ' + version;

            const firstTime = logs.length > 0 ? logs[0].time : 0;

            if (!force &&
                lastRenderedCount > 0 &&
                logs.length === lastRenderedCount &&
                firstTime === lastFirstLogTime) {
                return;
            }

            const needFullRender =
                force ||
                lastRenderedCount === 0 ||
                !document.getElementById('logList') ||
                logs.length < lastRenderedCount ||
                (lastFirstLogTime !== 0 && firstTime !== lastFirstLogTime);

            if (logs.length === 0) {
                if (needFullRender || lastRenderedCount !== 0) {
                    el.content.textContent = '';
                    const emptyDiv = document.createElement('div');
                    emptyDiv.className = 'empty';
                    emptyDiv.textContent = '暂无日志。开启一个视频页并播放，过滤记录会出现在这里。';
                    el.content.appendChild(emptyDiv);
                }
                lastRenderedCount = 0;
                lastFirstLogTime = 0;
                return;
            }

            if (needFullRender) {
                const list = document.createElement('div');
                list.className = 'log-list';
                list.id = 'logList';

                const reversed = logs.slice().reverse();
                for (let i = 0; i < reversed.length; i++) {
                    list.appendChild(renderLogCard(reversed[i]));
                }

                el.content.textContent = '';
                el.content.appendChild(list);
            } else if (logs.length > lastRenderedCount) {
                const newLogs = logs.slice(lastRenderedCount);
                const list = document.getElementById('logList');
                if (list) {
                    const reversed = newLogs.slice().reverse();
                    for (let i = 0; i < reversed.length; i++) {
                        list.insertBefore(renderLogCard(reversed[i]), list.firstChild);
                    }
                }
            }

            lastRenderedCount = logs.length;
            lastFirstLogTime = firstTime;

        } catch (e) {
            console.error('[AD-Log] load 失败:', e);
            el.meta.textContent = '加载失败';
            el.content.textContent = '';
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'empty';
            emptyDiv.textContent = '无法读取日志：' + e.message;
            el.content.appendChild(emptyDiv);
        }
    }

    function onSessionChanged(changes, area) {
        if (area !== 'session') return;
        if (!changes.logBuffer) return;
        // 只触发一次 load（storage.session 变化 => background 刚 persist 过）
        load(false);
    }

    function startAutoRefresh() {
        if (autoRefreshBound) return;
        autoRefreshBound = true;
        browser.storage.session.onChanged.addListener(onSessionChanged);
    }

    function stopAutoRefresh() {
        if (!autoRefreshBound) return;
        autoRefreshBound = false;
        browser.storage.session.onChanged.removeListener(onSessionChanged);
    }

    function formatLogsText() {
        return lastLogs.map(function (l) {
            const t = new Date(l.time);
            const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            const timeStr = t.getFullYear() + '-' +
                pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + ' ' +
                pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
            let line = '[' + timeStr + '] [' + (l.type || 'system') + '] ' + l.text;
            if (l.ads && l.ads.length > 0) {
                const total = l.removedLines || l.ads.length;
                if (total > l.ads.length) {
                    line += '\n  --- 被删内容（' + total + ' 行，下方仅显示前 ' + l.ads.length + ' 行）---\n  ' +
                        l.ads.join('\n  ');
                } else {
                    line += '\n  --- 被删内容（' + l.ads.length + ' 行）---\n  ' +
                        l.ads.join('\n  ');
                }
            }
            return line;
        }).join('\n\n');
    }

    el.refreshBtn.addEventListener('click', function () {
        load(true);
    });

    el.clearBtn.addEventListener('click', async function () {
        if (!confirm('确定清空所有日志？')) return;
        try {
            // 通知 background 清空 LOG_BUFFER 并写入 storage.session
            await browser.runtime.sendMessage({ type: 'clearLogs' });
            // 立即本地清空，不等 onChanged 回来
            lastRenderedCount = 0;
            lastFirstLogTime = 0;
            await load(true);
        } catch (e) {
            console.error('[AD-Log] clear 失败:', e);
        }
    });

    el.closeBtn.addEventListener('click', function () {
        window.close();
    });

    el.autoRefresh.addEventListener('change', function () {
        if (el.autoRefresh.checked) startAutoRefresh();
        else stopAutoRefresh();
    });

    if (el.copyAllBtn) {
        el.copyAllBtn.addEventListener('click', async function () {
            if (lastLogs.length === 0) {
                alert('当前没有日志可复制');
                return;
            }
            const text = formatLogsText();
            try {
                await navigator.clipboard.writeText(text);
                alert('已复制 ' + lastLogs.length + ' 条日志到剪贴板');
            } catch (e) {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                try {
                    document.execCommand('copy');
                    alert('已复制 ' + lastLogs.length + ' 条日志到剪贴板');
                } catch (e2) {
                    alert('复制失败，请长按手动选择');
                }
                ta.remove();
            }
        });
    }

    if (el.exportBtn) {
        el.exportBtn.addEventListener('click', function () {
            if (lastLogs.length === 0) {
                alert('当前没有日志可导出');
                return;
            }
            const text = formatLogsText();
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const now = new Date();
            const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            a.download = 'm3u8ar-log-' +
                now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
                pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) +
                '.txt';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        });
    }

    load(true);
    startAutoRefresh();

})();