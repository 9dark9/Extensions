// ============================================================
// M3U8 AD Cleaner - Background Script (Chrome MV3)
//
// Service Worker：非持久，空闲约 30 秒后终止。
// 跨事件状态写入 chrome.storage.session。
// ============================================================

'use strict';

// ============================================================
// 0. 同步加载 filter.js（SW 顶层必须）
// ============================================================
try {
    importScripts('filter.js');
} catch (e) {
    console.error('[AD-BG] filter.js 加载失败:', e);
}

let DEBUG = false;
function log(...args) { if (DEBUG) console.log('[AD-BG]', ...args); }
function warn(...args) { if (DEBUG) console.warn('[AD-BG]', ...args); }

const STATUS_DEDUP_WINDOW_MS = 5000;
const MAX_LOG_TEXT_LEN = 2000;
const MAX_LOG_ADS_LINES = 100;
const PERSIST_DEBOUNCE_MS = 200;
const HOST_STATUS_CACHE_MAX = 500;

// ============================================================
// 1. 日志缓冲区
// ============================================================
const LOG_MAX = 300;
const LOG_BUFFER = [];

function pushLog(type, text, extra) {
    const entry = {
        time: Date.now(),
        type: type,
        text: String(text).slice(0, MAX_LOG_TEXT_LEN)
    };
    if (extra) {
        if (extra.url) entry.url = String(extra.url);
        if (extra.ads && extra.ads.length) {
            entry.ads = extra.ads.length > MAX_LOG_ADS_LINES
                ? extra.ads.slice(0, MAX_LOG_ADS_LINES)
                    .concat(['...省略 ' + (extra.ads.length - MAX_LOG_ADS_LINES) + ' 行'])
                : extra.ads.slice();
        }
    }
    LOG_BUFFER.push(entry);
    if (LOG_BUFFER.length > LOG_MAX) {
        LOG_BUFFER.splice(0, LOG_BUFFER.length - LOG_MAX);
    }
    schedulePersist();
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

const HARD_EXCLUDE_REGEX = [
    /^https?:\/\/live\..+/i,
    /\/(pc)?live\d*(\/|\?)/i
];

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

// 配置是否已从 storage.local 加载完毕（用于事件门控）
let configLoaded = false;

// ============================================================
// 4. 状态容器（内存 + storage.session 持久化）
// ============================================================
const tabState = new Map();
const exportCache = new Map();
const pageStatusCache = new Map();

let __persistTimer = null;

function schedulePersist() {
    if (__persistTimer) return;
    __persistTimer = setTimeout(function () {
        __persistTimer = null;
        persistStateNow().catch(function (e) {
            console.error('[AD-BG] persist 失败:', e);
        });
    }, PERSIST_DEBOUNCE_MS);
}

async function persistStateNow() {
    const tabStateObj = {};
    tabState.forEach(function (v, k) { tabStateObj[k] = v; });

    const exportCacheObj = {};
    exportCache.forEach(function (v, k) { exportCacheObj[k] = v; });

    const recentLogs = LOG_BUFFER.slice(-100);

    try {
        await chrome.storage.session.set({
            tabState: tabStateObj,
            exportCache: exportCacheObj,
            logBuffer: recentLogs
        });
    } catch (e) {
        console.error('[AD-BG] storage.session.set 失败:', e);
    }
}

async function loadConfig() {
    try {
        const data = await chrome.storage.local.get({
            enabled: true,
            whitelist_mode: false,
            whitelist_hosts: [],
            extra_exclude_hosts: [],
            disable_hls_hosts: [],
            debug: false
        });
        config.enabled = data.enabled !== false;
        config.whitelistMode = !!data.whitelist_mode;
        config.whitelistHosts = Array.isArray(data.whitelist_hosts)
            ? data.whitelist_hosts.map(h => String(h).trim()).filter(Boolean) : [];
        config.extraExcludeHosts = Array.isArray(data.extra_exclude_hosts)
            ? data.extra_exclude_hosts.map(h => String(h).trim()).filter(Boolean) : [];
        config.disableHlsHosts = Array.isArray(data.disable_hls_hosts)
            ? data.disable_hls_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
        DEBUG = !!data.debug;

        configLoaded = true;

        // 关键：清空可能被旧 config 污染的缓存
        // SW 冷启动时 onUpdated 可能先于 loadConfig 完成触发 refreshTab，
        // 用默认 config 缓存了错误状态
        pageStatusCache.clear();

        updateGlobalDefaultIcon();
    } catch (e) {
        console.error('[AD-BG] loadConfig 失败:', e);
    }
}

// 按当前模式设置"全局默认图标"（不带 tabId），覆盖 manifest 的 default_icon
function updateGlobalDefaultIcon() {
    let prefix;
    if (!config.enabled) {
        prefix = 'icon-disabled';
    } else if (config.whitelistMode) {
        prefix = 'icon-off';
    } else {
        prefix = 'icon-on';
    }

    try {
        chrome.action.setIcon({
            path: {
                '16': chrome.runtime.getURL('icons/' + prefix + '-16.png'),
                '32': chrome.runtime.getURL('icons/' + prefix + '-32.png'),
                '48': chrome.runtime.getURL('icons/' + prefix + '-48.png'),
                '96': chrome.runtime.getURL('icons/' + prefix + '-96.png'),
                '128': chrome.runtime.getURL('icons/' + prefix + '-128.png')
            }
        });
    } catch (e) {
        console.error('[AD-BG] updateGlobalDefaultIcon 失败:', e);
    }
}

async function loadSessionState() {
    try {
        const data = await chrome.storage.session.get({
            tabState: {},
            exportCache: {},
            logBuffer: []
        });

        if (data.tabState) {
            for (const k in data.tabState) {
                const id = parseInt(k, 10);
                if (!isNaN(id)) tabState.set(id, data.tabState[k]);
            }
        }
        if (data.exportCache) {
            for (const k in data.exportCache) {
                const id = parseInt(k, 10);
                if (!isNaN(id)) exportCache.set(id, data.exportCache[k]);
            }
        }
        if (Array.isArray(data.logBuffer) && data.logBuffer.length) {
            LOG_BUFFER.push.apply(LOG_BUFFER, data.logBuffer);
        }
    } catch (e) {
        console.error('[AD-BG] loadSessionState 失败:', e);
    }
}

// ============================================================
// 4.1 初始化缓存
// ============================================================
let __initPromise = null;

function ensureInit() {
    if (!__initPromise) {
        __initPromise = (async function () {
            await loadConfig();
            await loadSessionState();
            await refreshAllTabs();
            if (LOG_BUFFER.length === 0) {
                pushLog('system', '扩展已启动，filter 版本 ' +
                    ((typeof M3U8Filter !== 'undefined' && M3U8Filter.version) || '?'));
            }
        })().catch(function (e) {
            console.error('[AD-BG] 初始化失败:', e);
            __initPromise = null;
            throw e;
        });
    }
    return __initPromise;
}

// ============================================================
// 5. 工具函数
// ============================================================
function getHostname(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
}

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

function hostMatches(host, domainList) {
    if (!host) return false;
    const h = host.toLowerCase();
    for (let i = 0; i < domainList.length; i++) {
        const d = domainList[i];
        if (h === d || h.endsWith('.' + d)) return true;
    }
    return false;
}

function isRegexItem(item) {
    return typeof item === 'string' && item.startsWith('/') && item.lastIndexOf('/') > 0;
}

const regexCache = new Map();
function getRegex(item) {
    if (regexCache.has(item)) return regexCache.get(item);
    try {
        const lastSlash = item.lastIndexOf('/');
        const pattern = item.slice(1, lastSlash);
        const flags = item.slice(lastSlash + 1) || 'i';
        const re = new RegExp(pattern, flags);
        regexCache.set(item, re);
        return re;
    } catch (e) {
        return null;
    }
}

function matchList(url, host, list) {
    if (!url || !list || list.length === 0) return null;

    const regexes = [];
    const domains = [];

    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (isRegexItem(item)) {
            regexes.push(item);
        } else {
            domains.push(item);
        }
    }

    for (let i = 0; i < regexes.length; i++) {
        const item = regexes[i];
        const re = getRegex(item);
        if (re && re.test(url)) {
            return item;
        }
    }

    if (host) {
        const h = host.toLowerCase();
        for (let i = 0; i < domains.length; i++) {
            const d = domains[i];
            if (h === d || h.endsWith('.' + d)) {
                return d;
            }
        }
    }

    return null;
}

function findCoveringHost(target, hostList) {
    if (!target || !hostList || hostList.length === 0) return null;
    const t = target.toLowerCase();
    for (let i = 0; i < hostList.length; i++) {
        const x = hostList[i];
        if (isRegexItem(x)) continue;
        if (x === t || t.endsWith('.' + x)) return x;
    }
    return null;
}

function findAllRelatedHosts(target, hostList) {
    if (!target || !hostList || hostList.length === 0) return [];
    const t = target.toLowerCase();
    return hostList.filter(function (x) {
        if (isRegexItem(x)) return false;
        return x === t || t.endsWith('.' + x) || x.endsWith('.' + t);
    });
}

function getPageStatus(url) {
    if (!url) {
        return config.whitelistMode ? 'not-in-whitelist' : 'active';
    }

    const cached = pageStatusCache.get(url);
    if (cached) return cached;

    const host = getHostname(url);
    let status = 'active';

    let isHard = hostMatches(host, HARD_EXCLUDE_HOSTS);
    if (!isHard) {
        for (let i = 0; i < HARD_EXCLUDE_REGEX.length; i++) {
            if (HARD_EXCLUDE_REGEX[i].test(url)) { isHard = true; break; }
        }
    }
    if (isHard) {
        status = 'hard-excluded';
    } else {
        if (matchList(url, host, config.extraExcludeHosts)) {
            status = 'extra-excluded';
        }
        else if (config.whitelistMode && !matchList(url, host, config.whitelistHosts)) {
            status = 'not-in-whitelist';
        }
    }

    if (pageStatusCache.size >= HOST_STATUS_CACHE_MAX) {
        let count = 0;
        for (const k of pageStatusCache.keys()) {
            pageStatusCache.delete(k);
            if (++count >= 100) break;
        }
    }

    pageStatusCache.set(url, status);
    return status;
}

// 沿 frame tree 向上遍历，返回所有祖先 frame 的 URL（从近到远）
async function getAncestorUrls(tabId, frameId) {
    const urls = [];
    if (tabId === undefined || tabId < 0) return urls;
    if (frameId === undefined || frameId <= 0) return urls;

    let cur = frameId;
    let depth = 0;
    while (cur > 0 && depth < 20) {
        try {
            const fr = await chrome.webNavigation.getFrame({ tabId: tabId, frameId: cur });
            if (!fr) break;
            const pid = fr.parentFrameId;
            if (pid === undefined || pid < 0) break;

            const pFr = await chrome.webNavigation.getFrame({ tabId: tabId, frameId: pid });
            if (!pFr) break;
            if (pFr.url) urls.push(pFr.url);

            cur = pid;
        } catch (e) {
            break;
        }
        depth++;
    }
    return urls;
}

function shouldProcessUrl(url) {
    if (!config.enabled) return false;
    if (!url) return false;
    return getPageStatus(url) === 'active';
}

function isInWhitelist(url) {
    if (!url) return false;
    return !!matchList(url, getHostname(url), config.whitelistHosts);
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
// 6. Tab 状态 / 图标
// ============================================================
function ensureTabState(tabId) {
    let s = tabState.get(tabId);
    if (!s) {
        s = {
            hostname: '',
            currentUrl: '',
            status: config.whitelistMode ? 'not-in-whitelist' : 'active',
            filterCount: 0,
            lastUrl: '',
            lastProcessedUrl: '',
            lastProcessedTime: 0,
            currentSourceKey: '',
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
    s.currentSourceKey = '';
    s.nativeHlsSuspect = false;
    s.seenM3U8 = false;
    s.outcome = 'none';
    s.parseError = '';
    exportCache.delete(tabId);
    schedulePersist();
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
    const isActive = s ? s.status === 'active' : !config.whitelistMode;

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

        chrome.action.setIcon({ path: path, tabId: tabId });

        const count = (config.enabled && s && s.filterCount) ? s.filterCount : 0;
        chrome.action.setBadgeText({
            text: count > 0 ? String(count) : '',
            tabId: tabId
        });
        chrome.action.setBadgeBackgroundColor({
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
    // O1 修复：新 tab 的 currentUrl 是 ''，不能短路，否则首次拿到真实 URL 不会 reset
    const changedUrl = s.currentUrl !== url;

    s.hostname = hostname;
    s.currentUrl = url;
    s.status = getPageStatus(url);

    if (changedHost || changedUrl) {
        resetTabResult(tabId);
    }

    updateIcon(tabId);
    schedulePersist();
}

async function refreshAllTabs() {
    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (tab.id === undefined) continue;
            const hostname = getHostname(tab.url || '');
            const s = ensureTabState(tab.id);
            s.hostname = hostname;
            s.currentUrl = tab.url || '';
            s.status = getPageStatus(tab.url || '');
            updateIcon(tab.id);
        }
        schedulePersist();
    } catch (e) {
        console.error('[AD-BG] refreshAllTabs 失败:', e);
    }
}

// ============================================================
// 7. 结果缓存
// ============================================================
function getActiveData(tabId) { return exportCache.get(tabId) || null; }

function setActiveData(tabId, data) {
    if (tabId >= 0) {
        exportCache.set(tabId, data);
        schedulePersist();
    }
}

// ============================================================
// 8. 生命周期监听器
// ============================================================
chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;

    // O4 修复：debug 变化不影响 tab 状态，无需重刷
    if (changes.debug) {
        DEBUG = !!changes.debug.newValue;
        if (!changes.enabled && !changes.whitelist_mode &&
            !changes.whitelist_hosts && !changes.extra_exclude_hosts &&
            !changes.disable_hls_hosts) {
            return;
        }
    }

    if (changes.enabled) {
        config.enabled = changes.enabled.newValue !== false;
    }
    if (changes.whitelist_mode) {
        config.whitelistMode = !!changes.whitelist_mode.newValue;
    }
    if (changes.whitelist_hosts) {
        config.whitelistHosts = Array.isArray(changes.whitelist_hosts.newValue)
            ? changes.whitelist_hosts.newValue.map(h => String(h).trim()).filter(Boolean) : [];
    }
    if (changes.extra_exclude_hosts) {
        config.extraExcludeHosts = Array.isArray(changes.extra_exclude_hosts.newValue)
            ? changes.extra_exclude_hosts.newValue.map(h => String(h).trim()).filter(Boolean) : [];
    }
    if (changes.disable_hls_hosts) {
        config.disableHlsHosts = Array.isArray(changes.disable_hls_hosts.newValue)
            ? changes.disable_hls_hosts.newValue.map(h => String(h).toLowerCase()).filter(Boolean) : [];
    }
    if (changes.enabled || changes.whitelist_mode) {
        updateGlobalDefaultIcon();
    }
    pageStatusCache.clear();
    refreshAllTabs();
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (!changeInfo.url && changeInfo.status !== 'loading') return;

    if (changeInfo.status === 'loading') {
        resetTabResult(tabId);
    }

    const url = changeInfo.url || (tab && tab.url) || '';

    if (!configLoaded) {
        ensureInit().then(function () {
            refreshTab(tabId, url);
        }).catch(function () {});
        return;
    }
    refreshTab(tabId, url);
});

chrome.tabs.onCreated.addListener(function (tab) {
    if (tab.id === undefined || tab.id < 0) return;

    const doRefresh = function () {
        refreshTab(tab.id, tab.url || '');
        setTimeout(function () {
            chrome.tabs.get(tab.id, function (t) {
                if (chrome.runtime.lastError || !t) return;
                refreshTab(tab.id, t.url || '');
            });
        }, 300);
    };

    if (!configLoaded) {
        ensureInit().then(doRefresh).catch(function () {});
    } else {
        doRefresh();
    }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
    tabState.delete(tabId);
    exportCache.delete(tabId);
    // B5 修复：清理 pending 的图标 timer，避免对已关闭 tab 调用 setIcon
    const t = __iconTimer.get(tabId);
    if (t) { clearTimeout(t); __iconTimer.delete(tabId); }
    schedulePersist();
});

// ============================================================
// 9. 消息处理
// ============================================================
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'checkHardExclude') {
        ensureInit().then(function () {
            const h = String(msg.host || '').toLowerCase();
            if (isRegexItem(h)) {
                sendResponse({ isHardExcluded: false });
                return;
            }
            sendResponse({
                isHardExcluded: !!h && hostMatches(h, HARD_EXCLUDE_HOSTS)
            });
        }).catch(function () {
            sendResponse({ isHardExcluded: false });
        });
        return true;
    }

    if (msg.type === 'getContentState') {
        ensureInit().then(async function () {
            const url = msg.url || '';
            let status = getPageStatus(url);
            let enabled = shouldProcessUrl(url);
            // B1 修复：whitelisted 也要受 config.enabled 约束
            let whitelisted = config.enabled && config.whitelistMode && isInWhitelist(url);

            // 白名单模式下，如果当前 URL 不 active，检查所有祖先 frame 是否命中白名单
            // B1 修复：祖先检查也要受 config.enabled 约束
            const senderTabId = sender.tab ? sender.tab.id : -1;
            const senderFrameId = (sender.frameId !== undefined) ? sender.frameId : -1;

            if (config.enabled && config.whitelistMode && !enabled &&
                senderTabId >= 0 && senderFrameId > 0) {
                try {
                    const ancestors = await getAncestorUrls(senderTabId, senderFrameId);
                    for (let i = 0; i < ancestors.length; i++) {
                        const aUrl = ancestors[i];
                        if (aUrl && isInWhitelist(aUrl)) {
                            enabled = true;
                            whitelisted = true;
                            status = 'active';
                            break;
                        }
                    }
                } catch (e) {
                    console.error('[AD-BG] ancestor 检查失败:', e);
                }
            }

            sendResponse({
                enabled: enabled,
                reason: status,
                whitelisted: whitelisted,
                hlsDisabled: isHlsDisabled(getHostname(url))
            });
        }).catch(function () {
            sendResponse({
                enabled: false, reason: 'init-error',
                whitelisted: false, hlsDisabled: false
            });
        });
        return true;
    }

    // B2 修复：以下消息都等 ensureInit 完成
    if (msg.type === 'checkFiltered') {
        ensureInit().then(function () {
            const tabId = sender.tab ? sender.tab.id : -1;
            const data = getActiveData(tabId);
            sendResponse({
                hasFiltered: !!(data && data.ads && data.ads.length > 0)
            });
        }).catch(function () {
            sendResponse({ hasFiltered: false });
        });
        return true;
    }

    if (msg.type === 'm3u8Pending') {
        ensureInit().then(function () {
            const tabId = sender.tab ? sender.tab.id : -1;
            if (tabId >= 0 && config.enabled) {
                const s = ensureTabState(tabId);

                if (s.filterCount === 0 && s.outcome !== 'pending') {
                    s.outcome = 'pending';
                    s.parseError = '';
                }

                s.seenM3U8 = true;
                s.lastM3U8Url = msg.url;
                schedulePersist();
            }
            sendResponse({ ok: true });
        }).catch(function () {
            sendResponse({ ok: false });
        });
        return true;
    }

    if (msg.type === 'm3u8Filtered') {
        ensureInit().then(function () {
            const tabId = sender.tab ? sender.tab.id : -1;
            if (tabId >= 0 && config.enabled) {
                const s = ensureTabState(tabId);
                const now = Date.now();
                const url = msg.url;

                s.seenM3U8 = true;
                s.lastM3U8Url = url;

                if (msg.adsCount > 0) {
                    const sameRecent = s.lastProcessedUrl === url &&
                        (now - s.lastProcessedTime) < STATUS_DEDUP_WINDOW_MS;

                    if (!sameRecent) {
                        s.lastProcessedUrl = url;
                        s.lastProcessedTime = now;
                        s.filterCount = msg.adsCount;
                        s.lastRule = (msg.rules || []).join('+');
                        s.lastUrl = url;
                        s.currentSourceKey = getSourceKey(url);
                        s.nativeHlsSuspect = false;
                        s.outcome = 'filtered';
                        s.parseError = '';
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
                schedulePersist();
            }
            sendResponse({ ok: true });
        }).catch(function () {
            sendResponse({ ok: false });
        });
        return true;
    }

    if (msg.type === 'm3u8Status') {
        ensureInit().then(function () {
            const tabId = sender.tab ? sender.tab.id : -1;
            if (tabId >= 0 && config.enabled) {
                const s = ensureTabState(tabId);
                const newSourceKey = getSourceKey(msg.url);
                const hasExistingAds = s.filterCount > 0;
                const sameLine = hasExistingAds && newSourceKey === s.currentSourceKey;

                s.seenM3U8 = true;
                s.lastM3U8Url = msg.url;

                if (msg.outcome === 'invalid' || msg.outcome === 'parse-error') {
                    s.outcome = msg.outcome;
                    s.parseError = msg.parseError || '';

                    if (!sameLine) {
                        if (hasExistingAds) {
                            exportCache.delete(tabId);
                            s.filterCount = 0;
                            s.lastUrl = '';
                            updateIcon(tabId);
                        }
                        s.currentSourceKey = newSourceKey;
                    }

                    const err = msg.parseError || '';

                    if (err === 'empty') {
                        pushLog('error', '响应为空 | ' + msg.url);
                    } else if (err === 'html') {
                        pushLog('error', '响应是 HTML（错误页或重定向） | ' + msg.url);
                    } else if (err === 'not-m3u8') {
                        pushLog('error', '响应不是 m3u8 内容 | ' + msg.url);
                    } else if (err === 'empty-playlist') {
                        pushLog('error', 'm3u8 无分片内容 | ' + msg.url);
                    } else {
                        pushLog('error', '解析失败: ' + err + ' | ' + msg.url);
                    }

                    schedulePersist();
                    sendResponse({ ok: true });
                    return;
                }

                if (msg.outcome === 'no-ads') {
                    if (sameLine) {
                        sendResponse({ ok: true });
                        return;
                    }

                    if (hasExistingAds) {
                        s.filterCount = 0;
                        s.lastUrl = '';
                        updateIcon(tabId);
                    }

                    if (msg.filtered) {
                        setActiveData(tabId, {
                            url: msg.url,
                            ads: [],
                            headLines: msg.headLines || [],
                            filtered: msg.filtered
                        });
                    } else {
                        exportCache.delete(tabId);
                    }

                    s.currentSourceKey = newSourceKey;
                    s.outcome = 'no-ads';
                    s.parseError = '';
                }

                schedulePersist();
            }
            sendResponse({ ok: true });
        }).catch(function () {
            sendResponse({ ok: false });
        });
        return true;
    }

    if (msg.type === 'm3u8NetworkError') {
        ensureInit().then(function () {
            const tabId = sender.tab ? sender.tab.id : -1;
            if (tabId >= 0 && config.enabled) {
                const s = ensureTabState(tabId);
                const newSourceKey = getSourceKey(msg.url);
                const hasExistingAds = s.filterCount > 0;
                const sameLine = hasExistingAds && newSourceKey === s.currentSourceKey;

                s.seenM3U8 = true;
                s.lastM3U8Url = msg.url;

                if (!sameLine && hasExistingAds) {
                    exportCache.delete(tabId);
                    s.filterCount = 0;
                    s.lastUrl = '';
                    s.currentSourceKey = newSourceKey;
                    s.outcome = 'parse-error';
                    s.parseError = 'network-error';
                    updateIcon(tabId);
                    pushLog('error', '换线路请求失败，状态已清空 | ' + msg.url);
                } else if (!hasExistingAds) {
                    s.currentSourceKey = newSourceKey;
                    s.outcome = 'parse-error';
                    s.parseError = 'network-error';
                }
                schedulePersist();
            }
            sendResponse({ ok: true });
        }).catch(function () {
            sendResponse({ ok: false });
        });
        return true;
    }

    if (msg.type === 'nativeHlsSuspect') {
        ensureInit().then(function () {
            const tabId = sender.tab ? sender.tab.id : -1;
            if (tabId >= 0) {
                const s = ensureTabState(tabId);
                s.nativeHlsSuspect = true;
                schedulePersist();
            }
            sendResponse({ ok: true });
        }).catch(function () {
            sendResponse({ ok: false });
        });
        return true;
    }

    if (msg.type === 'getTabState') {
        ensureInit().then(function () {
            const s = tabState.get(msg.tabId);
            const data = getActiveData(msg.tabId);
            const host = s ? s.hostname : '';
            const currentUrl = s ? s.currentUrl : '';

            let matchedRule = null;
            if (currentUrl) {
                const isHard = hostMatches(host, HARD_EXCLUDE_HOSTS) || HARD_EXCLUDE_REGEX.some(re => re.test(currentUrl));
                if (isHard) {
                    matchedRule = '内置排除名单';
                } else {
                    const hitExtra = matchList(currentUrl, host, config.extraExcludeHosts);
                    if (hitExtra) {
                        matchedRule = hitExtra;
                    } else if (config.whitelistMode) {
                        const hitWhite = matchList(currentUrl, host, config.whitelistHosts);
                        matchedRule = hitWhite || '未命中白名单';
                    } else {
                        matchedRule = '全匹配模式';
                    }
                }
            }

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
                inWhitelist: currentUrl ? isInWhitelist(currentUrl) : false,
                inExtraExclude: currentUrl ? !!matchList(currentUrl, host, config.extraExcludeHosts) : false,
                inHardExclude: currentUrl ? (hostMatches(host, HARD_EXCLUDE_HOSTS) || HARD_EXCLUDE_REGEX.some(re => re.test(currentUrl))) : false,
                hlsDisabled: host ? isHlsDisabled(host) : false,
                nativeHlsSuspect: !!(s && s.nativeHlsSuspect),
                matchedRule: matchedRule,
                detect: {
                    seen: s ? s.seenM3U8 : false,
                    outcome: s ? s.outcome : 'none',
                    parseError: s ? s.parseError : ''
                }
            });
        }).catch(function () {
            sendResponse({
                hostname: '', status: 'unknown', filterCount: 0, lastUrl: '',
                hasExportAd: false, hasExportClean: false, adLineCount: 0,
                whitelistMode: config.whitelistMode, enabled: config.enabled,
                inWhitelist: false, inExtraExclude: false, inHardExclude: false,
                hlsDisabled: false, nativeHlsSuspect: false, matchedRule: null,
                detect: { seen: false, outcome: 'none', parseError: '' }
            });
        });
        return true;
    }

    // B2 修复：toggleEnabled 也等 ensureInit
    if (msg.type === 'toggleEnabled') {
        ensureInit().then(function () {
            config.enabled = !!msg.value;
            return chrome.storage.local.set({ enabled: config.enabled });
        }).then(function () {
            return chrome.tabs.query({});
        }).then(function (tabs) {
            for (const t of tabs) {
                if (t.id < 0) continue;
                if (!config.enabled) {
                    resetTabResult(t.id);
                }
                updateIcon(t.id, true);
                chrome.tabs.sendMessage(t.id, {
                    type: 'extensionToggled',
                    enabled: config.enabled
                }).catch(function () {});
            }
            schedulePersist();
            sendResponse({ ok: true, enabled: config.enabled });
        }).catch(function (e) {
            sendResponse({ ok: false, error: String(e) });
        });
        return true;
    }

    if (msg.type === 'toggleDisableHlsCurrent') {
        ensureInit().then(function () {
            const host = msg.host;
            if (!host) { sendResponse({ ok: false }); return; }
            const h = String(host).toLowerCase();

            const covering = findCoveringHost(h, config.disableHlsHosts);

            if (covering) {
                config.disableHlsHosts = config.disableHlsHosts.filter(x => x !== covering);

                chrome.storage.local.set({ disable_hls_hosts: config.disableHlsHosts })
                    .then(() => sendResponse({
                        ok: true,
                        action: 'removed',
                        removedHost: covering,
                        hlsDisabled: isHlsDisabled(h)
                    }))
                    .catch(e => sendResponse({ ok: false, error: String(e) }));
                return;
            }

            const replacedHosts = config.disableHlsHosts.filter(x => x.endsWith('.' + h));
            if (replacedHosts.length > 0) {
                config.disableHlsHosts = config.disableHlsHosts.filter(x => replacedHosts.indexOf(x) === -1);
            }

            config.disableHlsHosts.push(h);

            chrome.storage.local.set({ disable_hls_hosts: config.disableHlsHosts })
                .then(() => sendResponse({
                    ok: true,
                    action: 'added',
                    replacedHosts: replacedHosts,
                    hlsDisabled: true
                }))
                .catch(e => sendResponse({ ok: false, error: String(e) }));
        }).catch(function (e) {
            sendResponse({ ok: false, error: String(e) });
        });
        return true;
    }

    if (msg.type === 'exportAd') {
        ensureInit().then(function () {
            return handleExportAd(msg.tabId);
        }).then(r => sendResponse(r))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
        return true;
    }

    if (msg.type === 'exportClean') {
        ensureInit().then(function () {
            return handleExportClean(msg.tabId);
        }).then(r => sendResponse(r))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
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
        schedulePersist();
        sendResponse({ ok: true });
        return;
    }
});

// ============================================================
// 10. 导出（只返回内容，由 popup 用 <a download> 下载）
// ============================================================
function handleExportAd(tabId) {
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

function handleExportClean(tabId) {
    const data = getActiveData(tabId);
    if (!data) return { ok: false, error: '当前标签页没有可导出的数据' };
    if (!data.filtered) return { ok: false, error: '没有可导出的无广告 m3u8 内容' };

    const lines = data.filtered.split('\n');
    const text = buildExportText(lines, data.url, false);
    const filename = timestampName('clean');
    pushLog('export', '准备导出无广告 m3u8: ' + filename);
    return { ok: true, filename: filename, text: text };
}

// ============================================================
// 11. 启动
// ============================================================
ensureInit().catch(function () {});