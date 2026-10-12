// ============================================================
// M3U8 AD Cleaner - Background Script (Chrome MV2)
// ============================================================

'use strict';

let DEBUG = false;
function log(...args) { if (DEBUG) console.log('[AD-BG]', ...args); }
function warn(...args) { if (DEBUG) console.warn('[AD-BG]', ...args); }

const STATUS_DEDUP_WINDOW_MS = 5000;

// ============================================================
// 1. 日志缓冲区
// ============================================================
const LOG_MAX = 300;
const LOG_BUFFER = [];

function pushLog(type, text, extra) {
    const entry = { time: Date.now(), type: type, text: String(text) };
    if (extra) {
        if (extra.url) entry.url = String(extra.url);
        if (extra.ads && extra.ads.length) entry.ads = extra.ads.slice();
    }
    LOG_BUFFER.push(entry);
    if (LOG_BUFFER.length > LOG_MAX) {
        LOG_BUFFER.splice(0, LOG_BUFFER.length - LOG_MAX);
    }
}

// ============================================================
// 2. 硬排除名单
// ============================================================
const HARD_EXCLUDE_GROUPS = {
    videoIntl: [
        'youtube.com', 'youtu.be', 'ytimg.com',
        'netflix.com', 'hulu.com',
        'disneyplus.com', 'disney-plus.net',
        'hbomax.com', 'max.com',
        'primevideo.com', 'amazonvideo.com',
        'twitch.tv', 'vimeo.com', 'vhx.tv', 'vimeocdn.com',
        'dailymotion.com', 'dmcdn.net', 'crunchyroll.com',
        'peacocktv.com', 'paramountplus.com', 'tubitv.com', 'pluto.tv',
        'tv.apple.com', 'soundcloud.com', 'spotify.com',
        'rumble.com', 'tiktok.com', 'tiktokcdn.com',
        'facebook.com', 'fbcdn.net',
        'reddit.com', 'redd.it', 'v.redd.it',
        'x.com', 'twitter.com', 'twimg.com',
    ],
    videoCn: [
        'youku.com', 'ykimg.com',
        'iqiyi.com', 'qiyipic.com', 'qy.net',
        'v.qq.com', 'mgtv.com',
        'bilibili.com', 'b23.tv', 'hdslb.com', 'bilivideo.com',
        'sohu.com', 'sohucs.com',
        'le.com', 'letv.com', 'letvimg.com',
        'pptv.com', 'pplive.com',
        'acfun.cn', 'acfun.com', 'acfun.tv',
        'douyin.com', 'iesdouyin.com', 'douyincdn.com', 'douyinpic.com',
        'kuaishou.com', 'kwaicdn.com', 'gifshow.com',
        'ixigua.com', '1905.com', 'cctv.com', 'cntv.cn',
        'weibo.com', 'weibo.cn', 'weibocdn.com', 'sinaimg.cn',
        'xiaohongshu.com', 'xhscdn.com',
    ],
    liveIntl: [
        'kick.com', 'trovo.live', 'dlive.tv',
        'bigo.tv', 'bigo.sg', 'younow.com',
    ],
    liveSports: [
        'espn.com', 'espncdn.com', 'espn.co.uk', 'dazn.com',
        'skysports.com', 'sky.com', 'skygo.com',
        'beinsports.com', 'beinsports.net',
        'nba.com', 'nba.tv', 'nfl.com', 'mlb.com', 'nhl.com',
        'fifa.com', 'uefa.com',
    ],
    liveCn: [
        'douyu.com', 'douyucdn.cn', 'douyucdn2.cn',
        'huya.com', 'huyacdn.com', 'huya.com.cn',
        'yy.com', 'quanmin.tv', 'qmcdn.com',
        'zhanqi.tv', 'longzhu.com',
        'live.qq.com', 'cc.163.com',
    ],
};

const HARD_EXCLUDE_HOSTS = (() => {
    const out = [];
    const seen = new Set();
    for (const k in HARD_EXCLUDE_GROUPS) {
        const arr = HARD_EXCLUDE_GROUPS[k];
        for (let i = 0; i < arr.length; i++) {
            const v = String(arr[i]).toLowerCase();
            if (!seen.has(v)) { seen.add(v); out.push(v); }
        }
    }
    return out;
})();

// ============================================================
// 3. 运行时配置
// ============================================================
const config = {
    enabled: true,
    whitelistMode: false,
    whitelistHosts: [],
    extraExcludeHosts: [],
    disableHlsHosts: []
};

function loadConfig(cb) {
    chrome.storage.local.get(
        {
            enabled: true,
            whitelist_mode: false,
            whitelist_hosts: [],
            extra_exclude_hosts: [],
            disable_hls_hosts: [],
            debug: false
        },
        function (data) {
            config.enabled = data.enabled !== false;
            config.whitelistMode = !!data.whitelist_mode;
            config.whitelistHosts = Array.isArray(data.whitelist_hosts)
                ? data.whitelist_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
            config.extraExcludeHosts = Array.isArray(data.extra_exclude_hosts)
                ? data.extra_exclude_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
            config.disableHlsHosts = Array.isArray(data.disable_hls_hosts)
                ? data.disable_hls_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
            DEBUG = !!data.debug;
            if (cb) cb();
        }
    );
}

chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.enabled) {
        config.enabled = changes.enabled.newValue !== false;
    }
    if (changes.whitelist_mode) {
        config.whitelistMode = !!changes.whitelist_mode.newValue;
    }
    if (changes.whitelist_hosts) {
        config.whitelistHosts = Array.isArray(changes.whitelist_hosts.newValue)
            ? changes.whitelist_hosts.newValue.map(h => String(h).toLowerCase()).filter(Boolean) : [];
    }
    if (changes.extra_exclude_hosts) {
        config.extraExcludeHosts = Array.isArray(changes.extra_exclude_hosts.newValue)
            ? changes.extra_exclude_hosts.newValue.map(h => String(h).toLowerCase()).filter(Boolean) : [];
    }
    if (changes.disable_hls_hosts) {
        config.disableHlsHosts = Array.isArray(changes.disable_hls_hosts.newValue)
            ? changes.disable_hls_hosts.newValue.map(h => String(h).toLowerCase()).filter(Boolean) : [];
    }
    if (changes.debug) {
        DEBUG = !!changes.debug.newValue;
    }
    hostStatusCache.clear();
    refreshAllTabs();
});

// ============================================================
// 4. 工具函数
// ============================================================
function getHostname(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
}

function hostMatches(host, domainList) {
    if (!host) return false;
    const h = host.toLowerCase();
    for (let i = 0; i < domainList.length; i++) {
        const d = domainList[i];
        if (h === d || h.endsWith('.' + d)) return true;
    }
    return false;
}

function findCoveringHost(target, hostList) {
    if (!target || !hostList || hostList.length === 0) return null;
    const t = target.toLowerCase();
    for (let i = 0; i < hostList.length; i++) {
        const x = hostList[i];
        if (x === t || t.endsWith('.' + x)) return x;
    }
    return null;
}

function findAllRelatedHosts(target, hostList) {
    if (!target || !hostList || hostList.length === 0) return [];
    const t = target.toLowerCase();
    return hostList.filter(function (x) {
        return x === t || t.endsWith('.' + x) || x.endsWith('.' + t);
    });
}

const hostStatusCache = new Map();

function getHostStatus(host) {
    if (!host) return 'unknown';
    const cached = hostStatusCache.get(host);
    if (cached) return cached;

    let status;
    if (hostMatches(host, HARD_EXCLUDE_HOSTS)) status = 'hard-excluded';
    else if (hostMatches(host, config.extraExcludeHosts)) status = 'extra-excluded';
    else if (config.whitelistMode && !hostMatches(host, config.whitelistHosts)) status = 'not-in-whitelist';
    else status = 'active';

    hostStatusCache.set(host, status);
    return status;
}

function shouldProcessHost(host) {
    if (!config.enabled) return false;
    if (!host) return false;
    return getHostStatus(host) === 'active';
}

function isInWhitelist(host) {
    return hostMatches(host, config.whitelistHosts);
}

function isHlsDisabled(host) {
    return hostMatches(host, config.disableHlsHosts);
}

function resolveUri(uri, baseUrl) {
    if (!uri) return uri;
    if (/^(https?:|data:|blob:|skd:)/i.test(uri)) return uri;
    try { return new URL(uri, baseUrl).href; } catch (e) { return uri; }
}

function absolutizeAttrUri(line, m3u8Url) {
    if (!m3u8Url) return line;
    if (!line.startsWith('#EXT-X-KEY') && !line.startsWith('#EXT-X-MAP')) return line;
    return line.replace(/URI="([^"]*)"/g, function (m, uri) {
        if (!uri) return m;
        return 'URI="' + resolveUri(uri, m3u8Url) + '"';
    });
}

function buildExportText(lines, m3u8Url, ensureEndList) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) { out.push(line); continue; }
        if (line.startsWith('#')) out.push(absolutizeAttrUri(line, m3u8Url));
        else out.push(resolveUri(line, m3u8Url));
    }
    if (ensureEndList && out.indexOf('#EXT-X-ENDLIST') === -1) out.push('#EXT-X-ENDLIST');
    return out.join('\n');
}

function timestampName(prefix) {
    const d = new Date();
    const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return prefix + '_' +
        d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
        pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.m3u8';
}

// ============================================================
// 5. Tab 状态 / 图标
// ============================================================
const tabState = new Map();

function ensureTabState(tabId) {
    let s = tabState.get(tabId);
    if (!s) {
        s = {
            hostname: '',
            currentUrl: '',
            status: 'active',
            filterCount: 0,
            lastUrl: '',
            lastProcessedUrl: '',
            lastProcessedTime: 0,
            nativeHlsSuspect: false,
            seenM3U8: false,
            outcome: 'none',
            parseError: ''
        };
        tabState.set(tabId, s);
    }
    return s;
}

function resetTabResult(tabId) {
    const s = ensureTabState(tabId);
    s.filterCount = 0;
    s.lastUrl = '';
    s.lastProcessedUrl = '';
    s.lastProcessedTime = 0;
    s.nativeHlsSuspect = false;
    s.seenM3U8 = false;
    s.outcome = 'none';
    s.parseError = '';
    exportCache.delete(tabId);
}

const __iconTimer = new Map();

function updateIcon(tabId, immediate) {
    if (tabId === undefined || tabId === null || tabId < 0) return;

    if (!immediate) {
        const existing = __iconTimer.get(tabId);
        if (existing) clearTimeout(existing);
        __iconTimer.set(tabId, setTimeout(function () {
            __iconTimer.delete(tabId);
            doUpdateIcon(tabId);
        }, 100));
        return;
    }
    doUpdateIcon(tabId);
}

function doUpdateIcon(tabId) {
    if (tabId === undefined || tabId === null || tabId < 0) return;
    const s = tabState.get(tabId);
    const isActive = !s || s.status === 'active';

    let prefix;
    if (!config.enabled) {
        prefix = 'icon-disabled';
    } else if (isActive) {
        prefix = 'icon-on';
    } else {
        prefix = 'icon-off';
    }

    try {
        const path = {
            '16': chrome.runtime.getURL('icons/' + prefix + '-16.png'),
            '32': chrome.runtime.getURL('icons/' + prefix + '-32.png'),
            '48': chrome.runtime.getURL('icons/' + prefix + '-48.png'),
            '96': chrome.runtime.getURL('icons/' + prefix + '-96.png'),
            '128': chrome.runtime.getURL('icons/' + prefix + '-128.png')
        };

        chrome.browserAction.setIcon({ path: path, tabId: tabId });

        const count = (config.enabled && s && s.filterCount) ? s.filterCount : 0;
        chrome.browserAction.setBadgeText({
            text: count > 0 ? String(count) : '',
            tabId: tabId
        });
        chrome.browserAction.setBadgeBackgroundColor({
            color: '#22c55e',
            tabId: tabId
        });
    } catch (e) {
        console.error('[AD-BG] updateIcon 失败:', e);
    }
}

function refreshTab(tabId, url) {
    const hostname = getHostname(url || '');
    const s = ensureTabState(tabId);
    const changedHost = s.hostname !== hostname;
    const changedUrl = s.currentUrl && s.currentUrl !== url;

    s.hostname = hostname;
    s.currentUrl = url;
    s.status = getHostStatus(hostname);

    if (changedHost || changedUrl) {
        resetTabResult(tabId);
    }

    updateIcon(tabId);
}

function refreshAllTabs() {
    chrome.tabs.query({}, function (tabs) {
        if (!tabs) return;
        for (const tab of tabs) {
            if (tab.id === undefined) continue;
            const hostname = getHostname(tab.url || '');
            const s = ensureTabState(tab.id);
            s.hostname = hostname;
            s.currentUrl = tab.url || '';
            s.status = getHostStatus(hostname);
            updateIcon(tab.id);
        }
    });
}

// ============================================================
// 6. 结果缓存
// ============================================================
const exportCache = new Map();

function getActiveData(tabId) { return exportCache.get(tabId) || null; }

function setActiveData(tabId, data) {
    if (tabId >= 0) exportCache.set(tabId, data);
}

// ============================================================
// 7. Tab 生命周期
// ============================================================
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (!changeInfo.url && changeInfo.status !== 'loading') return;

    if (changeInfo.status === 'loading') {
        resetTabResult(tabId);
    }

    const url = changeInfo.url || (tab && tab.url) || '';
    refreshTab(tabId, url);
});

chrome.tabs.onRemoved.addListener(function (tabId) {
    tabState.delete(tabId);
    exportCache.delete(tabId);
    for (const key of __injectedFrames) {
        if (key.startsWith(tabId + ':')) __injectedFrames.delete(key);
    }
});

// ============================================================
// 7.1 主动注入：兜底 content_scripts 静态匹配的遗漏
// ============================================================
const __injectedFrames = new Set();

function tryInjectContentScript(tabId, frameId, url) {
    if (!url) return;
    if (!/^https?:/i.test(url)) return;

    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return; }
    if (!host) return;

    if (hostMatches(host, HARD_EXCLUDE_HOSTS)) return;

    const key = tabId + ':' + frameId + ':' + url;
    if (__injectedFrames.has(key)) return;
    __injectedFrames.add(key);

    try {
        chrome.tabs.executeScript(tabId, {
            file: 'content.js',
            frameId: frameId
        }, function () {
            if (chrome.runtime.lastError) {
                log('主动注入失败:', chrome.runtime.lastError.message, url);
            } else {
                log('主动注入 content.js:', url, 'frameId=', frameId);
            }
        });
    } catch (e) {
        log('主动注入异常:', e);
    }
}

chrome.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId === 0) return;
    tryInjectContentScript(details.tabId, details.frameId, details.url);
});

// ============================================================
// 8. 消息处理
// ============================================================
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'checkHardExclude') {
        const h = String(msg.host || '').toLowerCase();
        sendResponse({
            isHardExcluded: !!h && hostMatches(h, HARD_EXCLUDE_HOSTS)
        });
        return;
    }

    if (msg.type === 'getContentState') {
        const host = msg.host || '';
        sendResponse({
            enabled: shouldProcessHost(host),
            reason: getHostStatus(host),
            hlsDisabled: isHlsDisabled(host)
        });
        return;
    }

    if (msg.type === 'checkFiltered') {
        const tabId = sender.tab ? sender.tab.id : -1;
        const data = getActiveData(tabId);
        sendResponse({
            hasFiltered: !!(data && data.ads && data.ads.length > 0)
        });
        return;
    }

    // ---- content 上报 inject.js 的过滤结果 ----
    if (msg.type === 'm3u8Pending') {
        const tabId = sender.tab ? sender.tab.id : -1;
        if (tabId >= 0 && config.enabled) {
            const s = ensureTabState(tabId);
            const prevData = getActiveData(tabId);

            const urlChanged = !prevData || prevData.url !== msg.url;

            if (urlChanged) {
                setActiveData(tabId, {
                    url: msg.url,
                    ads: [],
                    headLines: [],
                    filtered: ''
                });
                s.filterCount = 0;
                s.lastUrl = '';
                s.outcome = 'pending';
                s.parseError = '';
                updateIcon(tabId);
            } else if (s.outcome !== 'pending') {
                s.outcome = 'pending';
                s.parseError = '';
            }

            s.seenM3U8 = true;
            s.lastM3U8Url = msg.url;
        }
        sendResponse({ ok: true });
        return;
    }

    if (msg.type === 'm3u8Filtered') {
        const tabId = sender.tab ? sender.tab.id : -1;
        if (tabId >= 0 && config.enabled) {
            const s = ensureTabState(tabId);
            const now = Date.now();
            const url = msg.url;

            s.seenM3U8 = true;
            s.lastM3U8Url = url;
            s.outcome = 'filtered';
            s.parseError = '';

            if (msg.adsCount > 0) {
                const urlChanged = s.lastProcessedUrl && s.lastProcessedUrl !== url;

                if (urlChanged ||
                    s.lastProcessedUrl !== url ||
                    (now - s.lastProcessedTime) >= STATUS_DEDUP_WINDOW_MS) {
                    s.lastProcessedUrl = url;
                    s.lastProcessedTime = now;
                    s.filterCount = msg.adsCount;
                    s.lastUrl = url;
                    s.nativeHlsSuspect = false;
                    setActiveData(tabId, {
                        url: url,
                        ads: msg.ads || [],
                        headLines: msg.headLines || [],
                        filtered: msg.filtered || ''
                    });
                    updateIcon(tabId);

                    const shortUrl = url.length > 80 ? url.slice(0, 80) + '…' : url;
                    pushLog(
                        'filter',
                        '移除 ' + msg.adsCount + ' 行 | 模式 ' + (msg.modeName || '') +
                        ' | 规则 ' + ((msg.rules || []).join('+')) +
                        ' | ' + shortUrl,
                        { url: url, ads: msg.ads }
                    );
                }
            }
        }
        sendResponse({ ok: true });
        return;
    }

    // ---- content 上报 inject.js 的状态（no-ads / invalid / parse-error） ----
    if (msg.type === 'm3u8Status') {
        const tabId = sender.tab ? sender.tab.id : -1;
        if (tabId >= 0 && config.enabled) {
            const s = ensureTabState(tabId);

            // 同 URL 已有 filtered 时，no-ads 不覆盖
            if (msg.outcome === 'no-ads' &&
                s.outcome === 'filtered' &&
                s.lastM3U8Url === msg.url) {
                sendResponse({ ok: true });
                return;
            }

            s.seenM3U8 = true;
            s.lastM3U8Url = msg.url;
            s.outcome = msg.outcome;
            s.parseError = msg.parseError || '';

            const prevData = getActiveData(tabId);
            if (prevData && prevData.url !== msg.url) {
                setActiveData(tabId, {
                    url: msg.url,
                    ads: [],
                    headLines: [],
                    filtered: ''
                });
                s.filterCount = 0;
                s.lastUrl = '';
                updateIcon(tabId);
            }

            if (msg.outcome === 'invalid' || msg.outcome === 'parse-error') {
                const err = msg.parseError || '';
                if (err === 'empty') pushLog('error', '响应为空 | ' + msg.url);
                else if (err === 'html') pushLog('error', '响应是 HTML（错误页或重定向） | ' + msg.url);
                else if (err === 'not-m3u8') pushLog('error', '响应不是 m3u8 内容 | ' + msg.url);
                else if (err === 'empty-playlist') pushLog('error', 'm3u8 无分片内容 | ' + msg.url);
                else if (err) pushLog('error', '解析失败: ' + err + ' | ' + msg.url);
            }
        }
        sendResponse({ ok: true });
        return;
    }

    if (msg.type === 'nativeHlsSuspect') {
        const tabId = sender.tab ? sender.tab.id : -1;
        if (tabId >= 0) {
            const s = ensureTabState(tabId);
            s.nativeHlsSuspect = true;
        }
        sendResponse({ ok: true });
        return;
    }

    if (msg.type === 'getTabState') {
        const s = tabState.get(msg.tabId);
        const data = getActiveData(msg.tabId);
        const host = s ? s.hostname : '';
        sendResponse({
            hostname: host,
            status: s ? s.status : 'unknown',
            filterCount: s ? s.filterCount : 0,
            lastUrl: s ? s.lastUrl : '',
            hasExport: !!(data && data.ads && data.ads.length > 0),
            adLineCount: data && data.ads ? data.ads.length : 0,
            whitelistMode: config.whitelistMode,
            enabled: config.enabled,
            inWhitelist: host ? isInWhitelist(host) : false,
            inExtraExclude: host ? hostMatches(host, config.extraExcludeHosts) : false,
            inHardExclude: host ? hostMatches(host, HARD_EXCLUDE_HOSTS) : false,
            hlsDisabled: host ? isHlsDisabled(host) : false,
            nativeHlsSuspect: !!(s && s.nativeHlsSuspect),
            detect: {
                seen: s ? s.seenM3U8 : false,
                outcome: s ? s.outcome : 'none',
                parseError: s ? s.parseError : ''
            }
        });
        return;
    }

    if (msg.type === 'toggleEnabled') {
        config.enabled = !!msg.value;
        chrome.storage.local.set({ enabled: config.enabled }, function () {
            chrome.tabs.query({}, function (tabs) {
                for (const t of tabs) {
                    if (t.id < 0) continue;
                    if (!config.enabled) {
                        resetTabResult(t.id);
                    }
                    updateIcon(t.id, true);
                    try {
                        chrome.tabs.sendMessage(t.id, {
                            type: 'extensionToggled',
                            enabled: config.enabled
                        }, function () {
                            if (chrome.runtime.lastError) {}
                        });
                    } catch (e) {}
                }
                sendResponse({ ok: true, enabled: config.enabled });
            });
        });
        return true;
    }

    if (msg.type === 'toggleWhitelistCurrent') {
        const host = msg.host;
        if (!host) { sendResponse({ ok: false }); return; }
        const h = String(host).toLowerCase();

        if (hostMatches(h, HARD_EXCLUDE_HOSTS)) {
            sendResponse({
                ok: false,
                action: 'hard-excluded',
                error: '该域名在内置排除名单中，无法加入白名单'
            });
            return true;
        }

        const covering = findCoveringHost(h, config.whitelistHosts);

        if (covering) {
            config.whitelistHosts = config.whitelistHosts.filter(x => x !== covering);

            chrome.storage.local.set({ whitelist_hosts: config.whitelistHosts }, function () {
                if (chrome.runtime.lastError) {
                    sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                sendResponse({
                    ok: true,
                    action: 'removed',
                    removedHost: covering
                });
            });
            return true;
        }

        const replacedHosts = config.whitelistHosts.filter(x => x.endsWith('.' + h));
        if (replacedHosts.length > 0) {
            config.whitelistHosts = config.whitelistHosts.filter(x => replacedHosts.indexOf(x) === -1);
        }

        const exToRemove = findAllRelatedHosts(h, config.extraExcludeHosts);
        if (exToRemove.length > 0) {
            config.extraExcludeHosts = config.extraExcludeHosts.filter(x => exToRemove.indexOf(x) === -1);
        }

        config.whitelistHosts.push(h);

        chrome.storage.local.set({
            whitelist_hosts: config.whitelistHosts,
            extra_exclude_hosts: config.extraExcludeHosts
        }, function () {
            if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                return;
            }
            sendResponse({
                ok: true,
                action: 'added',
                replacedHosts: replacedHosts
            });
        });
        return true;
    }

    if (msg.type === 'toggleExcludeCurrent') {
        const host = msg.host;
        if (!host) { sendResponse({ ok: false }); return; }
        const h = String(host).toLowerCase();

        if (hostMatches(h, HARD_EXCLUDE_HOSTS)) {
            sendResponse({
                ok: false,
                action: 'hard-excluded',
                error: '该域名已在内置排除名单中'
            });
            return true;
        }

        const covering = findCoveringHost(h, config.extraExcludeHosts);

        if (covering) {
            config.extraExcludeHosts = config.extraExcludeHosts.filter(x => x !== covering);

            chrome.storage.local.set({ extra_exclude_hosts: config.extraExcludeHosts }, function () {
                if (chrome.runtime.lastError) {
                    sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                sendResponse({
                    ok: true,
                    action: 'removed',
                    removedHost: covering
                });
            });
            return true;
        }

        const replacedHosts = config.extraExcludeHosts.filter(x => x.endsWith('.' + h));
        if (replacedHosts.length > 0) {
            config.extraExcludeHosts = config.extraExcludeHosts.filter(x => replacedHosts.indexOf(x) === -1);
        }

        const wlToRemove = findAllRelatedHosts(h, config.whitelistHosts);
        if (wlToRemove.length > 0) {
            config.whitelistHosts = config.whitelistHosts.filter(x => wlToRemove.indexOf(x) === -1);
        }

        config.extraExcludeHosts.push(h);

        chrome.storage.local.set({
            extra_exclude_hosts: config.extraExcludeHosts,
            whitelist_hosts: config.whitelistHosts
        }, function () {
            if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                return;
            }
            sendResponse({
                ok: true,
                action: 'added',
                replacedHosts: replacedHosts
            });
        });
        return true;
    }

    if (msg.type === 'toggleDisableHlsCurrent') {
        const host = msg.host;
        if (!host) { sendResponse({ ok: false }); return; }
        const h = String(host).toLowerCase();

        const covering = findCoveringHost(h, config.disableHlsHosts);

        if (covering) {
            config.disableHlsHosts = config.disableHlsHosts.filter(x => x !== covering);

            chrome.storage.local.set({ disable_hls_hosts: config.disableHlsHosts }, function () {
                if (chrome.runtime.lastError) {
                    sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                sendResponse({
                    ok: true,
                    action: 'removed',
                    removedHost: covering,
                    hlsDisabled: isHlsDisabled(h)
                });
            });
            return true;
        }

        const replacedHosts = config.disableHlsHosts.filter(x => x.endsWith('.' + h));
        if (replacedHosts.length > 0) {
            config.disableHlsHosts = config.disableHlsHosts.filter(x => replacedHosts.indexOf(x) === -1);
        }

        config.disableHlsHosts.push(h);

        chrome.storage.local.set({ disable_hls_hosts: config.disableHlsHosts }, function () {
            if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                return;
            }
            sendResponse({
                ok: true,
                action: 'added',
                replacedHosts: replacedHosts,
                hlsDisabled: true
            });
        });
        return true;
    }

    if (msg.type === 'exportAd') {
        handleExportAd(msg.tabId, sendResponse);
        return true;
    }

    if (msg.type === 'exportClean') {
        handleExportClean(msg.tabId, sendResponse);
        return true;
    }

    if (msg.type === 'getLogs') {
        sendResponse({
            logs: LOG_BUFFER.slice(),
            version: (typeof M3U8Filter !== 'undefined' && M3U8Filter.version) || '?'
        });
        return;
    }

    if (msg.type === 'clearLogs') {
        LOG_BUFFER.length = 0;
        sendResponse({ ok: true });
        return;
    }
});

// ============================================================
// 9. 导出
// ============================================================
let __pendingDownloadFilename = null;

chrome.downloads.onDeterminingFilename.addListener(function (item, suggest) {
    if (item.byExtensionId === chrome.runtime.id && __pendingDownloadFilename) {
        const name = __pendingDownloadFilename;
        __pendingDownloadFilename = null;
        suggest({ filename: name, conflictAction: 'uniquify' });
        return;
    }
});

function downloadText(text, filename, callback) {
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);
    __pendingDownloadFilename = filename;

    chrome.downloads.download({
        url: blobUrl,
        filename: filename,
        saveAs: true,
        conflictAction: 'uniquify'
    }, function (downloadId) {
        if (chrome.runtime.lastError) {
            console.error('[AD-BG] 下载失败:', chrome.runtime.lastError.message);
            __pendingDownloadFilename = null;
        }
        setTimeout(function () {
            try { URL.revokeObjectURL(blobUrl); } catch (e) {}
        }, 60000);
        if (callback) callback(downloadId);
    });
}

function handleExportAd(tabId, sendResponse) {
    const data = getActiveData(tabId);
    if (!data) { sendResponse({ ok: false, error: '当前标签页没有可导出的数据' }); return; }
    if (!data.ads || data.ads.length === 0) { sendResponse({ ok: false, error: '本次未发现广告片段' }); return; }

    const lines = [];
    if (data.headLines && data.headLines.length > 0) {
        for (const h of data.headLines) lines.push(h);
    } else {
        lines.push('#EXTM3U');
    }
    if (lines[0] !== '#EXTM3U') lines.unshift('#EXTM3U');
    for (const a of data.ads) lines.push(a);

    const text = buildExportText(lines, data.url, true);
    const filename = timestampName('ad_segments');
    downloadText(text, filename, function () {
        pushLog('export', '导出广告片段: ' + filename + ' (' + data.ads.length + ' 行)');
        sendResponse({ ok: true, filename: filename, count: data.ads.length });
    });
}

function handleExportClean(tabId, sendResponse) {
    const data = getActiveData(tabId);
    if (!data) { sendResponse({ ok: false, error: '当前标签页没有可导出的数据' }); return; }
    if (!data.filtered) { sendResponse({ ok: false, error: '没有可导出的无广告 m3u8 内容' }); return; }

    const lines = data.filtered.split('\n');
    const text = buildExportText(lines, data.url, false);
    const filename = timestampName('clean');
    downloadText(text, filename, function () {
        pushLog('export', '导出无广告 m3u8: ' + filename);
        sendResponse({ ok: true, filename: filename });
    });
}

// ============================================================
// 10. 启动
// ============================================================
loadConfig(function () {
    refreshAllTabs();
});

pushLog('system', '扩展已启动，filter 版本 ' +
    ((typeof M3U8Filter !== 'undefined' && M3U8Filter.version) || '?'));