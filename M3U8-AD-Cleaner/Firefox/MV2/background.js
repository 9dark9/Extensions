// ============================================================
// M3U8 AD Cleaner - Background Script (Firefox MV2)
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

function diag(text) {
    if (!DEBUG) return;
    try { pushLog('diag', String(text)); } catch (e) {}
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
    extraExcludeHosts: []
};

async function loadConfig() {
    try {
        const data = await browser.storage.local.get({
            enabled: true,
            whitelist_mode: false,
            whitelist_hosts: [],
            extra_exclude_hosts: [],
            debug: false
        });
        config.enabled = data.enabled !== false;
        config.whitelistMode = !!data.whitelist_mode;
        config.whitelistHosts = Array.isArray(data.whitelist_hosts)
            ? data.whitelist_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
        config.extraExcludeHosts = Array.isArray(data.extra_exclude_hosts)
            ? data.extra_exclude_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
        DEBUG = !!data.debug;
    } catch (e) {
        console.error('[AD-BG] loadConfig 失败:', e);
    }
}

browser.storage.onChanged.addListener(function (changes, area) {
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
    if (changes.debug) {
        DEBUG = !!changes.debug.newValue;
    }
    hostStatusCache.clear();
    refreshAllTabs();
});

// ============================================================
// 4. 祖先链缓存
// ============================================================
const ancestorHostCache = new Map();

async function buildAncestorHosts(tabId, frameId) {
    const hosts = [];
    const seen = new Set();
    let cur = frameId;
    let depth = 0;
    while (cur !== -1 && depth < 20 && !seen.has(cur)) {
        seen.add(cur);
        let fr;
        try {
            fr = await browser.webNavigation.getFrame({ tabId: tabId, frameId: cur });
        } catch (e) {
            break;
        }
        if (!fr) break;
        const h = getHostname(fr.url || '');
        if (h) hosts.push(h);
        cur = fr.parentFrameId;
        depth++;
    }
    return hosts;
}

async function refreshAncestorCache(tabId, frameId) {
    const hosts = await buildAncestorHosts(tabId, frameId);
    ancestorHostCache.set(tabId + ':' + frameId, {
        hosts: hosts,
        expireAt: Date.now() + 300000
    });
}

function getAncestorHostsSync(tabId, frameId) {
    if (frameId <= 0) return null;
    const key = tabId + ':' + frameId;
    const item = ancestorHostCache.get(key);
    if (!item) return null;
    if (Date.now() >= item.expireAt) {
        ancestorHostCache.delete(key);
        return null;
    }
    return item.hosts;
}

browser.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId === 0) return;
    if (details.url === 'about:blank') return;
    refreshAncestorCache(details.tabId, details.frameId).catch(function () {});
});

// ============================================================
// 5. 工具函数
// ============================================================
function looksLikeM3U8(url) {
    if (!url || typeof url !== 'string') return false;
    let end = url.length;
    const q = url.indexOf('?');
    if (q !== -1 && q < end) end = q;
    const h = url.indexOf('#');
    if (h !== -1 && h < end) end = h;
    return /\.m3u8$/i.test(url.slice(0, end));
}

function getHostname(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
}

// ★ 核心：源标识 —— 提取 host + 目录路径（去掉文件名和 query）
function getSourceKey(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/');
        parts.pop();
        return u.host + '/' + parts.filter(Boolean).join('/');
    } catch (e) {
        return url;
    }
}

function getPageHost(details) {
    if (details.documentUrl) {
        const h = getHostname(details.documentUrl);
        if (h) return h;
    }
    if (details.initiator) {
        const h = getHostname(details.initiator);
        if (h) return h;
    }
    if (details.tabId >= 0) {
        const s = tabState.get(details.tabId);
        if (s && s.hostname) return s.hostname;
    }
    return '';
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

function shouldProcessWithAncestors(tabId, frameId, pageHost) {
    if (!config.enabled) return false;
    if (!pageHost) return false;

    const selfStatus = getHostStatus(pageHost);

    if (selfStatus === 'hard-excluded' || selfStatus === 'extra-excluded') {
        return false;
    }

    if (selfStatus === 'active') return true;

    if (frameId > 0) {
        const ancestors = getAncestorHostsSync(tabId, frameId);
        if (ancestors) {
            for (let i = 0; i < ancestors.length; i++) {
                const h = ancestors[i];
                if (h === pageHost) continue;
                if (getHostStatus(h) === 'active') {
                    diag('祖先继承放行: frame=' + frameId + ' self=' + pageHost + ' ancestor=' + h);
                    return true;
                }
            }
        }
    }

    return false;
}

function isInWhitelist(host) {
    return hostMatches(host, config.whitelistHosts);
}

function resolveUri(uri, baseUrl) {
    if (!uri) return uri;
    if (/^(https?:|data:|blob:)/i.test(uri)) return uri;
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
// 6. Tab 状态 / 图标
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
            currentSourceKey: '',
            seenM3U8: false,
            seenMedia: false,
            outcome: 'none',
            parseError: '',
            lastM3U8Url: ''
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
    s.currentSourceKey = '';
    s.seenM3U8 = false;
    s.seenMedia = false;
    s.outcome = 'none';
    s.parseError = '';
    s.lastM3U8Url = '';
    exportCache.delete(tabId);
    diag('resetTabResult: tab=' + tabId);
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
            '16': browser.runtime.getURL('icons/' + prefix + '-16.png'),
            '32': browser.runtime.getURL('icons/' + prefix + '-32.png'),
            '48': browser.runtime.getURL('icons/' + prefix + '-48.png'),
            '96': browser.runtime.getURL('icons/' + prefix + '-96.png'),
            '128': browser.runtime.getURL('icons/' + prefix + '-128.png')
        };

        browser.browserAction.setIcon({ path: path, tabId: tabId });

        const count = (config.enabled && s && s.filterCount) ? s.filterCount : 0;
        browser.browserAction.setBadgeText({
            text: count > 0 ? String(count) : '',
            tabId: tabId
        });
        browser.browserAction.setBadgeBackgroundColor({
            color: '#22c55e',
            tabId: tabId
        });
    } catch (e) {
        console.error('[AD-BG] updateIcon 失败:', e);
    }
}

async function refreshTab(tabId, url) {
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

async function refreshAllTabs() {
    try {
        const tabs = await browser.tabs.query({});
        for (const tab of tabs) {
            if (tab.id === undefined) continue;
            const hostname = getHostname(tab.url || '');
            const s = ensureTabState(tab.id);
            s.hostname = hostname;
            s.currentUrl = tab.url || '';
            s.status = getHostStatus(hostname);
            updateIcon(tab.id);
        }
    } catch (e) {
        console.error('[AD-BG] refreshAllTabs 失败:', e);
    }
}

// ============================================================
// 7. Tab 查找缓存
// ============================================================
const tabHostCache = new Map();
let tabQueryPending = null;

function findTabByHost(host) {
    const cached = tabHostCache.get(host);
    if (cached && Date.now() < cached.expireAt) {
        return Promise.resolve(cached.tabId);
    }

    if (!tabQueryPending) {
        tabQueryPending = browser.tabs.query({}).then(function (tabs) {
            tabQueryPending = null;
            return tabs;
        }).catch(function (e) {
            tabQueryPending = null;
            throw e;
        });
    }

    return tabQueryPending.then(function (tabs) {
        let found = -1;
        for (const t of tabs) {
            if (t.id >= 0 && t.active && getHostname(t.url || '') === host) {
                found = t.id;
                break;
            }
        }
        if (found < 0) {
            for (const t of tabs) {
                if (t.id >= 0 && getHostname(t.url || '') === host) {
                    found = t.id;
                    break;
                }
            }
        }
        if (found >= 0) {
            tabHostCache.set(host, { tabId: found, expireAt: Date.now() + 60000 });
        }
        return found;
    });
}

function clearTabHostCache() {
    tabHostCache.clear();
}

setInterval(function cleanTabHostCache() {
    const now = Date.now();
    for (const [host, item] of tabHostCache) {
        if (now >= item.expireAt) tabHostCache.delete(host);
    }
}, 120000);

// ============================================================
// 8. 结果缓存
// ============================================================
const exportCache = new Map();

function getActiveData(tabId) { return exportCache.get(tabId) || null; }

function setActiveData(tabId, data) {
    if (tabId >= 0) exportCache.set(tabId, data);
}

// ============================================================
// 9. Tab 生命周期
// ============================================================
browser.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    clearTabHostCache();
    if (!changeInfo.url && changeInfo.status !== 'loading') return;

    if (changeInfo.status === 'loading') {
        resetTabResult(tabId);
    }

    const url = changeInfo.url || (tab && tab.url) || '';
    refreshTab(tabId, url);
});

browser.tabs.onRemoved.addListener(function (tabId) {
    clearTabHostCache();
    tabState.delete(tabId);
    exportCache.delete(tabId);
    const prefix = tabId + ':';
    for (const key of ancestorHostCache.keys()) {
        if (key.indexOf(prefix) === 0) ancestorHostCache.delete(key);
    }
});

(async function initTabs() {
    await loadConfig();
    await refreshAllTabs();
})();

// ============================================================
// 10. 核心拦截
// ============================================================
browser.webRequest.onBeforeRequest.addListener(
    function (details) {
        const tabId = details.tabId;

        if (details.type === 'media' && tabId >= 0) {
            const s = ensureTabState(tabId);
            s.seenMedia = true;
        }

        if (!looksLikeM3U8(details.url)) return;

        const reqHost = getHostname(details.url);
        const pageHost = getPageHost(details) || reqHost;

        if (!shouldProcessWithAncestors(tabId, details.frameId, pageHost)) return;

        if (tabId >= 0) {
            const s = ensureTabState(tabId);
            if (!s.hostname) {
                s.hostname = pageHost;
                s.status = getHostStatus(pageHost);
            }
        }

        const filter = browser.webRequest.filterResponseData(details.requestId);
        const decoder = new TextDecoder('utf-8');
        const encoder = new TextEncoder();
        let buffer = '';

        filter.ondata = function (event) {
            buffer += decoder.decode(event.data, { stream: true });
        };

        filter.onstop = function () {
            let output = buffer;
            let changed = false;
            let stats = null;
            let headLines = [];
            let ads = [];
            let parseError = '';

            if (!buffer || buffer.slice(0, 64).indexOf('#EXTM3U') === -1) {
                warn('前128字符:', JSON.stringify(buffer.slice(0, 128)));
            }

            try {
                const result = M3U8Filter.filterM3U8(buffer, details.url);
                stats = result.stats;
                if (result.changed) {
                    output = result.modified;
                    changed = true;
                    headLines = result.headLines || [];
                    ads = result.ads || [];

                    if (stats.removedLines > 0) {
                        const shortUrl = details.url.length > 80
                            ? details.url.slice(0, 80) + '…'
                            : details.url;
                        pushLog(
                            'filter',
                            '移除 ' + stats.removedLines + ' 行 | 模式 ' + stats.modeName +
                            ' | 规则 ' + (stats.rules || []).join('+') +
                            ' | ' + shortUrl,
                            { url: details.url, ads: ads }
                        );
                    }
                }

                // 无论 changed 与否，都保存 headLines（供无广告时导出）
                if (!result.changed) {
                    headLines = result.headLines || [];
                }

                if (stats && stats.master) {
                    // master：不处理不提示
                } else if (stats && stats.error) {
                    parseError = stats.error;
                    if (parseError === 'empty') {
                        pushLog('error', '响应为空 | ' + details.url);
                    } else if (parseError === 'html') {
                        pushLog('error', '响应是 HTML（错误页或重定向） | ' + details.url);
                    } else if (parseError === 'not-m3u8') {
                        pushLog('error', '响应不是 m3u8 内容 | ' + details.url);
                    } else if (parseError === 'empty-playlist') {
                        pushLog('error', 'm3u8 无分片内容 | ' + details.url);
                    } else {
                        pushLog('error', '解析失败: ' + parseError + ' | ' + details.url);
                    }
                }
            } catch (e) {
                console.error('[AD-BG] 过滤失败:', e);
                parseError = String(e.message || e);
                pushLog('error', '解析失败: ' + parseError + ' | ' + details.url);
            }

            try {
                filter.write(encoder.encode(output));
                filter.close();
            } catch (e) {
                console.error('[AD-BG] 写回响应失败:', e);
            }

            const applyResult = function (effectiveTabId) {
                if (effectiveTabId === undefined || effectiveTabId === null || effectiveTabId < 0) {
                    diag('applyResult: tabId无效 ' + effectiveTabId);
                    return;
                }

                if (!config.enabled) return;
                if (stats && stats.master) return;

                const s = ensureTabState(effectiveTabId);
                const url = details.url;
                const now = Date.now();
                const hasNewAds = changed && ads.length > 0;
                const newSourceKey = getSourceKey(url);
                const hasExistingAds = s.filterCount > 0;
                const sameLine = hasExistingAds && newSourceKey === s.currentSourceKey;

                s.seenM3U8 = true;
                s.lastM3U8Url = url;

                diag('applyResult: tab=' + effectiveTabId +
                    ' changed=' + changed +
                    ' adsLen=' + ads.length +
                    ' parseError=' + (parseError || '') +
                    ' newSource=' + newSourceKey +
                    ' curSource=' + s.currentSourceKey +
                    ' sameLine=' + sameLine);

                // ============================================
                // 分支 A：解析错误
                // ============================================
                if (parseError) {
                    let outcomeType;
                    if (parseError === 'empty' || parseError === 'html' ||
                        parseError === 'not-m3u8' || parseError === 'empty-playlist') {
                        outcomeType = 'invalid';
                    } else {
                        outcomeType = 'parse-error';
                    }

                    s.outcome = outcomeType;
                    s.parseError = parseError;

                    // 不同源 + 有历史记录 → 清空
                    if (hasExistingAds && !sameLine) {
                        exportCache.delete(effectiveTabId);
                        s.filterCount = 0;
                        s.lastUrl = '';
                        s.currentSourceKey = newSourceKey;
                        updateIcon(effectiveTabId);
                        diag('  → 换源+错误：清空');
                    } else if (!hasExistingAds) {
                        s.currentSourceKey = newSourceKey;
                        diag('  → 无历史+错误：记录源');
                    } else {
                        diag('  → 同源错误：保持');
                    }
                    return;
                }

                // ============================================
                // 去重：同 URL 5 秒内
                // ============================================
                const sameRecent = s.lastProcessedUrl === url &&
                    (now - s.lastProcessedTime) < STATUS_DEDUP_WINDOW_MS;
                if (sameRecent && !hasNewAds) {
                    diag('  → 去重跳过');
                    return;
                }
                s.lastProcessedUrl = url;
                s.lastProcessedTime = now;

                // ============================================
                // 分支 B：有广告 → 无条件更新
                // ============================================
                if (hasNewAds) {
                    setActiveData(effectiveTabId, {
                        url: url,
                        ads: ads,
                        headLines: headLines,
                        filtered: output
                    });
                    s.filterCount = ads.length;
                    s.lastRule = (stats.rules || []).join('+');
                    s.lastUrl = url;
                    s.currentSourceKey = newSourceKey;
                    s.outcome = 'filtered';
                    s.parseError = '';
                    updateIcon(effectiveTabId);
                    diag('  → filtered (' + ads.length + ' 行)');
                    return;
                }

                // ============================================
                // 分支 C：无广告
                // ============================================
                if (sameLine) {
                    // 同源（音轨、切清晰度）→ 完全保留
                    diag('  → 同源无广告：保持 filtered');
                    return;
                }

                // 不同源（或无历史记录）
                // 1) 清 badge（若之前有 N）
                if (hasExistingAds) {
                    s.filterCount = 0;
                    s.lastUrl = '';
                    updateIcon(effectiveTabId);
                    diag('  → 换源无广告：清空 badge');
                }

                // 2) 保存当前 m3u8 内容（无广告版本）供导出
                //    ads 为空 → "导出广告片段"按钮禁用
                //    filtered 非空 → "导出无广告 m3u8"按钮可用
                setActiveData(effectiveTabId, {
                    url: url,
                    ads: [],
                    headLines: headLines,
                    filtered: output
                });
                s.currentSourceKey = newSourceKey;
                s.outcome = 'no-ads';
                s.parseError = '';
                diag('  → no-ads（保留 m3u8 供导出）');
            };

            if (tabId >= 0) {
                applyResult(tabId);
            } else {
                const initiator = details.initiator || details.originUrl || details.documentUrl || '';
                const initHost = getHostname(initiator);

                if (initHost) {
                    findTabByHost(initHost).then(function (id) {
                        if (id >= 0) applyResult(id);
                        else diag('tabId<0，未找到 tab, initiator=' + initHost);
                    }).catch(function (e) {
                        diag('findTabByHost 失败: ' + e.message);
                    });
                } else {
                    diag('tabId<0 且无 initiator');
                }
            }
        };

        filter.onerror = function () {
            const err = filter.error || '';
            if (err.indexOf('redirected') !== -1) return;
            console.error('[AD-BG] StreamFilter 错误:', filter.error);
            pushLog('error', 'StreamFilter 错误: ' + err);

            if (tabId < 0 || !config.enabled) return;

            const s = ensureTabState(tabId);
            if (s.filterCount === 0) return;

            const failedSourceKey = getSourceKey(details.url);
            if (failedSourceKey !== s.currentSourceKey) {
                exportCache.delete(tabId);
                s.filterCount = 0;
                s.lastUrl = '';
                s.currentSourceKey = failedSourceKey;
                s.outcome = 'parse-error';
                s.parseError = 'network-error';
                updateIcon(tabId);
                pushLog('error', '换线路请求失败，状态已清空 | ' + details.url);
                diag('filter.onerror: 换源失败清空 tab=' + tabId);
            } else {
                diag('filter.onerror: 同源失败，保持 tab=' + tabId);
            }
        };
    },
    {
        urls: ['<all_urls>'],
        types: ['media', 'xmlhttprequest']
    },
    ['blocking']
);

// ============================================================
// 11. 消息处理
// ============================================================
browser.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
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
            reason: getHostStatus(host)
        });
        return;
    }

    if (msg.type === 'checkSeen') {
        const tabId = sender.tab ? sender.tab.id : -1;
        const s = tabId >= 0 ? tabState.get(tabId) : null;
        sendResponse({
            seen: !!(s && s.seenM3U8),
            seenMedia: !!(s && s.seenMedia),
            outcome: s ? s.outcome : 'none',
            parseError: s ? s.parseError : ''
        });
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
            hasExportAd: !!(data && data.ads && data.ads.length > 0),
            hasExportClean: !!(data && data.filtered && data.filtered.length > 0),
            adLineCount: data && data.ads ? data.ads.length : 0,
            lastRule: s ? s.lastRule : '',
            whitelistMode: config.whitelistMode,
            enabled: config.enabled,
            inWhitelist: host ? isInWhitelist(host) : false,
            inExtraExclude: host ? hostMatches(host, config.extraExcludeHosts) : false,
            inHardExclude: host ? hostMatches(host, HARD_EXCLUDE_HOSTS) : false,
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
        browser.storage.local.set({ enabled: config.enabled })
            .then(function () {
                return browser.tabs.query({});
            })
            .then(function (tabs) {
                for (const t of tabs) {
                    if (t.id < 0) continue;
                    if (!config.enabled) {
                        resetTabResult(t.id);
                    }
                    updateIcon(t.id, true);
                }
                sendResponse({ ok: true, enabled: config.enabled });
            })
            .catch(function (e) {
                sendResponse({ ok: false, error: String(e) });
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

            browser.storage.local.set({ whitelist_hosts: config.whitelistHosts })
                .then(() => sendResponse({
                    ok: true,
                    action: 'removed',
                    removedHost: covering
                }))
                .catch(e => sendResponse({ ok: false, error: String(e) }));
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

        browser.storage.local.set({
            whitelist_hosts: config.whitelistHosts,
            extra_exclude_hosts: config.extraExcludeHosts
        })
            .then(() => sendResponse({
                ok: true,
                action: 'added',
                replacedHosts: replacedHosts
            }))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
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

            browser.storage.local.set({ extra_exclude_hosts: config.extraExcludeHosts })
                .then(() => sendResponse({
                    ok: true,
                    action: 'removed',
                    removedHost: covering
                }))
                .catch(e => sendResponse({ ok: false, error: String(e) }));
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

        browser.storage.local.set({
            extra_exclude_hosts: config.extraExcludeHosts,
            whitelist_hosts: config.whitelistHosts
        })
            .then(() => sendResponse({
                ok: true,
                action: 'added',
                replacedHosts: replacedHosts
            }))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
        return true;
    }

    if (msg.type === 'exportAd') {
        handleExportAd(msg.tabId).then(r => sendResponse(r))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
        return true;
    }

    if (msg.type === 'exportClean') {
        handleExportClean(msg.tabId).then(r => sendResponse(r))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
        return true;
    }

    if (msg.type === 'downloadSaveAs') {
        downloadText(msg.text || '', msg.filename || 'm3u8_export.m3u8')
            .then(function () { sendResponse({ ok: true }); })
            .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
        return true;
    }

    if (msg.type === 'getLogs') {
        sendResponse({ logs: LOG_BUFFER.slice(), version: M3U8Filter.version });
        return;
    }

    if (msg.type === 'clearLogs') {
        LOG_BUFFER.length = 0;
        sendResponse({ ok: true });
        return;
    }
});

// ============================================================
// 12. 导出
// ============================================================
async function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'application/vnd.apple.mpegurl' });
    const blobUrl = URL.createObjectURL(blob);
    try {
        await browser.downloads.download({
            url: blobUrl,
            filename: filename,
            saveAs: true
        });
    } finally {
        setTimeout(function () {
            try { URL.revokeObjectURL(blobUrl); } catch (e) {}
        }, 60000);
    }
}

async function handleExportAd(tabId) {
    const data = getActiveData(tabId);
    if (!data) return { ok: false, error: '当前标签页没有可导出的数据' };
    if (!data.ads || data.ads.length === 0) return { ok: false, error: '本次未发现广告片段' };

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
    pushLog('export', '准备导出广告片段: ' + filename + ' (' + data.ads.length + ' 行)');
    return { ok: true, filename: filename, text: text, count: data.ads.length };
}

async function handleExportClean(tabId) {
    const data = getActiveData(tabId);
    if (!data) return { ok: false, error: '当前标签页没有可导出的数据' };
    if (!data.filtered) return { ok: false, error: '没有可导出的 m3u8 内容' };

    const lines = data.filtered.split('\n');
    const text = buildExportText(lines, data.url, false);
    const filename = timestampName('clean');
    pushLog('export', '准备导出无广告 m3u8: ' + filename);
    return { ok: true, filename: filename, text: text };
}

// ============================================================
// 13. 启动
// ============================================================
pushLog('system', '扩展已启动，filter 版本 ' + M3U8Filter.version);