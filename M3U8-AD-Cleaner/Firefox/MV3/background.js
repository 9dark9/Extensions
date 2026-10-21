// ============================================================
// M3U8 AD Cleaner - Background Script (Firefox MV3)
//
// MV3 事件页面：非持久，空闲 ~30s 后卸载。
// 所有跨事件状态写入 browser.storage.session。
// ============================================================

'use strict';

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
    extraExcludeHosts: []
};

// 配置是否已从 storage.local 加载完毕（用于事件门控）
let configLoaded = false;

// ============================================================
// 4. 状态容器（内存 + storage.session 持久化）
// ============================================================
const tabState = new Map();
const exportCache = new Map();
const ancestorUrlCache = new Map();   // 存祖先 frame 的 URL 列表（支持正则判定）
const tabHostCache = new Map();
const pageStatusCache = new Map();    // key = URL

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
        await browser.storage.session.set({
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
        const data = await browser.storage.local.get({
            enabled: true,
            whitelist_mode: false,
            whitelist_hosts: [],
            extra_exclude_hosts: [],
            debug: false
        });
        config.enabled = data.enabled !== false;
        config.whitelistMode = !!data.whitelist_mode;
        // 注意：正则项保持原样，普通域名小写化
        config.whitelistHosts = Array.isArray(data.whitelist_hosts)
            ? data.whitelist_hosts.map(h => String(h).trim()).filter(Boolean) : [];
        config.extraExcludeHosts = Array.isArray(data.extra_exclude_hosts)
            ? data.extra_exclude_hosts.map(h => String(h).trim()).filter(Boolean) : [];
        DEBUG = !!data.debug;

        configLoaded = true;

        // 关键：清空可能被旧 config 污染的缓存
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
        browser.action.setIcon({
            path: {
                '16': browser.runtime.getURL('icons/' + prefix + '-16.png'),
                '32': browser.runtime.getURL('icons/' + prefix + '-32.png'),
                '48': browser.runtime.getURL('icons/' + prefix + '-48.png'),
                '96': browser.runtime.getURL('icons/' + prefix + '-96.png'),
                '128': browser.runtime.getURL('icons/' + prefix + '-128.png')
            }
        });
    } catch (e) {
        console.error('[AD-BG] updateGlobalDefaultIcon 失败:', e);
    }
}

async function loadSessionState() {
    try {
        const data = await browser.storage.session.get({
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
                pushLog('system', '扩展已启动，filter 版本 ' + M3U8Filter.version);
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

// 源标识：host + 目录路径（去掉文件名和 query）
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

// 拿发起请求的 frame 的页面 URL（用于正则判定）
function getPageUrl(details) {
    if (details.documentUrl) return details.documentUrl;
    if (details.originUrl) return details.originUrl;
    if (details.initiator) {
        try { return new URL(details.initiator).href; } catch (e) {}
    }
    if (details.tabId >= 0) {
        const s = tabState.get(details.tabId);
        if (s && s.currentUrl) return s.currentUrl;
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

// ★ 判断是否为正则项
function isRegexItem(item) {
    return typeof item === 'string' && item.startsWith('/') && item.lastIndexOf('/') > 0;
}

// ★ 正则编译缓存
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

// ★ 统一名单匹配：正则按数组原顺序优先，其次域名
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

// ★ 页面状态判定（基于完整 URL，支持内置硬排除正则 + 用户正则名单）
function getPageStatus(url) {
    if (!url) {
        // 空白页 / 新标签页等无 URL 场景：按当前模式给默认状态
        return config.whitelistMode ? 'not-in-whitelist' : 'active';
    }

    const cached = pageStatusCache.get(url);
    if (cached) return cached;

    const host = getHostname(url);
    let status = 'active';

    // 1. 内置硬排除
    let isHard = hostMatches(host, HARD_EXCLUDE_HOSTS);
    if (!isHard) {
        for (let i = 0; i < HARD_EXCLUDE_REGEX.length; i++) {
            if (HARD_EXCLUDE_REGEX[i].test(url)) { isHard = true; break; }
        }
    }
    if (isHard) {
        status = 'hard-excluded';
    } else {
        // 2. 用户额外排除
        if (matchList(url, host, config.extraExcludeHosts)) {
            status = 'extra-excluded';
        }
        // 3. 白名单模式
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

function shouldProcessUrl(url) {
    if (!config.enabled) return false;
    if (!url) return false;
    return getPageStatus(url) === 'active';
}

// ★ 祖先白名单继承判定
// 只对白名单模式 + not-in-whitelist 的 frame 生效
// 硬排除 / 额外排除优先级最高，不受继承影响
function shouldProcessWithAncestors(tabId, frameId, pageUrl, originUrl) {
    if (!config.enabled) return false;
    if (!pageUrl) return false;

    const selfStatus = getPageStatus(pageUrl);

    if (selfStatus === 'hard-excluded' || selfStatus === 'extra-excluded') {
        return false;
    }
    if (selfStatus === 'active') return true;

    // 白名单模式下，自身不命中时查祖先
    if (config.whitelistMode && frameId > 0) {
        const ancestors = getAncestorUrlsSync(tabId, frameId);
        if (ancestors) {
            for (let i = 0; i < ancestors.length; i++) {
                const aUrl = ancestors[i];
                if (aUrl && isInWhitelist(aUrl)) {
                    log('祖先白名单继承: frame=' + frameId + ' self=' + pageUrl + ' ancestor=' + aUrl);
                    return true;
                }
            }
        }
        // fallback：祖先缓存未建立时，直接用顶层页面 URL 判定
        if (originUrl && originUrl !== pageUrl && isInWhitelist(originUrl)) {
            log('originUrl 白名单继承: frame=' + frameId + ' origin=' + originUrl);
            return true;
        }
    }

    return false;
}

function isInWhitelist(url) {
    if (!url) return false;
    return !!matchList(url, getHostname(url), config.whitelistHosts);
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
    // 无状态记录时按当前模式决定默认是否激活：
    // 白名单模式默认灰（命中白名单才亮），全匹配模式默认亮
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
            '16': browser.runtime.getURL('icons/' + prefix + '-16.png'),
            '32': browser.runtime.getURL('icons/' + prefix + '-32.png'),
            '48': browser.runtime.getURL('icons/' + prefix + '-48.png'),
            '96': browser.runtime.getURL('icons/' + prefix + '-96.png'),
            '128': browser.runtime.getURL('icons/' + prefix + '-128.png')
        };

        browser.action.setIcon({ path: path, tabId: tabId });

        const count = (config.enabled && s && s.filterCount) ? s.filterCount : 0;
        browser.action.setBadgeText({
            text: count > 0 ? String(count) : '',
            tabId: tabId
        });
        browser.action.setBadgeBackgroundColor({
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
    // 修正：新 tab 的 currentUrl 是 ''，不能短路，否则首次拿到真实 URL 不会 reset
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
        const tabs = await browser.tabs.query({});
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
// 7. Tab 查找缓存（tabId < 0 时用于反查 tab）
// ============================================================
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
// 8. 祖先链缓存（URL 版，支持正则判定）
// ============================================================
async function buildAncestorUrls(tabId, frameId) {
    const urls = [];
    if (tabId < 0 || frameId <= 0) return urls;

    let cur = frameId;
    let depth = 0;
    while (cur > 0 && depth < 20) {
        try {
            const fr = await browser.webNavigation.getFrame({ tabId: tabId, frameId: cur });
            if (!fr) break;
            const pid = fr.parentFrameId;
            if (pid === undefined || pid < 0) break;

            const pFr = await browser.webNavigation.getFrame({ tabId: tabId, frameId: pid });
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

async function refreshAncestorUrlCache(tabId, frameId) {
    const urls = await buildAncestorUrls(tabId, frameId);
    ancestorUrlCache.set(tabId + ':' + frameId, {
        urls: urls,
        expireAt: Date.now() + 300000
    });
}

function getAncestorUrlsSync(tabId, frameId) {
    if (frameId <= 0) return null;
    const key = tabId + ':' + frameId;
    const item = ancestorUrlCache.get(key);
    if (!item) return null;
    if (Date.now() >= item.expireAt) {
        ancestorUrlCache.delete(key);
        return null;
    }
    return item.urls;
}

// ============================================================
// 9. 结果缓存
// ============================================================
function getActiveData(tabId) { return exportCache.get(tabId) || null; }

function setActiveData(tabId, data) {
    if (tabId >= 0) {
        exportCache.set(tabId, data);
        schedulePersist();
    }
}

// ============================================================
// 10. 生命周期监听器（顶层同步注册）
// ============================================================
browser.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;

    // debug 变化不影响 tab 状态，无需重刷
    if (changes.debug) {
        DEBUG = !!changes.debug.newValue;
        if (!changes.enabled && !changes.whitelist_mode &&
            !changes.whitelist_hosts && !changes.extra_exclude_hosts) {
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

    if (changes.enabled || changes.whitelist_mode) {
        updateGlobalDefaultIcon();
    }

    pageStatusCache.clear();
    refreshAllTabs();
});

browser.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId === 0) return;
    if (details.url === 'about:blank') return;
    refreshAncestorUrlCache(details.tabId, details.frameId).catch(function () {});
});

browser.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    clearTabHostCache();
    if (!changeInfo.url && changeInfo.status !== 'loading') return;

    if (changeInfo.status === 'loading') {
        resetTabResult(tabId);
    }

    const url = changeInfo.url || (tab && tab.url) || '';

    // 配置未加载完时先 ensureInit，避免用默认 config 误判
    if (!configLoaded) {
        ensureInit().then(function () {
            refreshTab(tabId, url);
        }).catch(function () {});
        return;
    }
    refreshTab(tabId, url);
});

browser.tabs.onCreated.addListener(function (tab) {
    if (tab.id === undefined || tab.id < 0) return;

    const doRefresh = function () {
        refreshTab(tab.id, tab.url || '');
        // onCreated 时 url 可能还没就绪，稍后补一次
        setTimeout(function () {
            browser.tabs.get(tab.id).then(function (t) {
                if (!t) return;
                refreshTab(tab.id, t.url || '');
            }).catch(function () {});
        }, 300);
    };

    if (!configLoaded) {
        ensureInit().then(doRefresh).catch(function () {});
    } else {
        doRefresh();
    }
});

browser.tabs.onRemoved.addListener(function (tabId) {
    clearTabHostCache();
    tabState.delete(tabId);
    exportCache.delete(tabId);
    // 清理 pending 的图标 timer，避免对已关闭 tab 调用 setIcon
    const t = __iconTimer.get(tabId);
    if (t) { clearTimeout(t); __iconTimer.delete(tabId); }
    const prefix = tabId + ':';
    for (const key of ancestorUrlCache.keys()) {
        if (key.indexOf(prefix) === 0) ancestorUrlCache.delete(key);
    }
    schedulePersist();
});

// ============================================================
// 11. 核心拦截（webRequest.filterResponseData）
// ============================================================
browser.webRequest.onBeforeRequest.addListener(
    function (details) {
        ensureInit().catch(function () {});

        const tabId = details.tabId;

        if (details.type === 'media' && tabId >= 0) {
            const s = ensureTabState(tabId);
            if (!s.seenMedia) {
                s.seenMedia = true;
                schedulePersist();
            }
        }

        if (!looksLikeM3U8(details.url)) return;

        const pageUrl = getPageUrl(details);
        const originUrl = details.originUrl || details.documentUrl || '';

        if (!shouldProcessWithAncestors(tabId, details.frameId, pageUrl, originUrl)) return;

        if (tabId >= 0) {
            const s = ensureTabState(tabId);
            if (!s.hostname && pageUrl) {
                s.hostname = getHostname(pageUrl);
                s.status = getPageStatus(pageUrl);
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
                } else {
                    headLines = result.headLines || [];
                }

                if (stats && stats.master) {
                    // master：静默跳过
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
                    log('applyResult: tabId无效 ' + effectiveTabId);
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

                // 分支 A：解析错误
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

                    if (hasExistingAds && !sameLine) {
                        exportCache.delete(effectiveTabId);
                        s.filterCount = 0;
                        s.lastUrl = '';
                        s.currentSourceKey = newSourceKey;
                        updateIcon(effectiveTabId);
                        schedulePersist();
                    } else if (!hasExistingAds) {
                        s.currentSourceKey = newSourceKey;
                        schedulePersist();
                    } else {
                        schedulePersist();
                    }
                    return;
                }

                // 去重：同 URL 5 秒内
                const sameRecent = s.lastProcessedUrl === url &&
                    (now - s.lastProcessedTime) < STATUS_DEDUP_WINDOW_MS;
                if (sameRecent && !hasNewAds) {
                    schedulePersist();
                    return;
                }
                s.lastProcessedUrl = url;
                s.lastProcessedTime = now;

                // 分支 B：有广告
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
                    schedulePersist();
                    return;
                }

                // 分支 C：无广告
                if (sameLine) {
                    schedulePersist();
                    return;
                }

                if (hasExistingAds) {
                    s.filterCount = 0;
                    s.lastUrl = '';
                    updateIcon(effectiveTabId);
                }

                setActiveData(effectiveTabId, {
                    url: url,
                    ads: [],
                    headLines: headLines,
                    filtered: output
                });
                s.currentSourceKey = newSourceKey;
                s.outcome = 'no-ads';
                s.parseError = '';
                schedulePersist();
            };

            if (tabId >= 0) {
                applyResult(tabId);
            } else {
                const fallbackUrl = details.initiator || details.originUrl || details.documentUrl || '';
                const initHost = getHostname(fallbackUrl);

                if (initHost) {
                    findTabByHost(initHost).then(function (id) {
                        if (id >= 0) applyResult(id);
                        else log('tabId<0，未找到 tab, initiator=' + initHost);
                    }).catch(function (e) {
                        log('findTabByHost 失败: ' + e.message);
                    });
                } else {
                    log('tabId<0 且无 initiator');
                }
            }
        };

        filter.onerror = function () {
            const err = filter.error || '';
            if (err.indexOf('redirected') !== -1) return;
            console.error('[AD-BG] StreamFilter 错误:', filter.error);
            pushLog('error', 'StreamFilter 错误: ' + err);

            if (tabId < 0 || !config.enabled) return;

            ensureInit().then(function () {
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
                    schedulePersist();
                }
            }).catch(function (e) {
                console.error('[AD-BG] filter.onerror ensureInit 失败:', e);
            });
        };
    },
    {
        urls: ['<all_urls>'],
        types: ['media', 'xmlhttprequest']
    },
    ['blocking']
);

// ============================================================
// 12. 消息处理
// ============================================================
browser.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
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
            let whitelisted = config.enabled && config.whitelistMode && isInWhitelist(url);

            // 白名单模式下，自身不 active 时检查祖先 frame 是否命中白名单
            const senderTabId = sender.tab ? sender.tab.id : -1;
            const senderFrameId = (sender.frameId !== undefined) ? sender.frameId : -1;

            if (config.enabled && config.whitelistMode && !enabled &&
                senderTabId >= 0 && senderFrameId > 0) {
                try {
                    const ancestors = await buildAncestorUrls(senderTabId, senderFrameId);
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
                whitelisted: whitelisted
            });
        }).catch(function () {
            sendResponse({ enabled: false, reason: 'init-error', whitelisted: false });
        });
        return true;
    }

    if (msg.type === 'checkSeen') {
        ensureInit().then(function () {
            const tabId = sender.tab ? sender.tab.id : -1;
            const s = tabId >= 0 ? tabState.get(tabId) : null;
            sendResponse({
                seen: !!(s && s.seenM3U8),
                seenMedia: !!(s && s.seenMedia),
                outcome: s ? s.outcome : 'none',
                parseError: s ? s.parseError : ''
            });
        }).catch(function () {
            sendResponse({ seen: false, seenMedia: false, outcome: 'none', parseError: '' });
        });
        return true;
    }

    if (msg.type === 'getTabState') {
        ensureInit().then(function () {
            const s = tabState.get(msg.tabId);
            const data = getActiveData(msg.tabId);
            const host = s ? s.hostname : '';
            const currentUrl = s ? s.currentUrl : '';

            // 命中规则（用于弹窗展示）
            let matchedRule = null;
            if (currentUrl) {
                const isHard = hostMatches(host, HARD_EXCLUDE_HOSTS) ||
                    HARD_EXCLUDE_REGEX.some(re => re.test(currentUrl));
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
                matchedRule: null,
                detect: { seen: false, outcome: 'none', parseError: '' }
            });
        });
        return true;
    }

    if (msg.type === 'toggleEnabled') {
        ensureInit().then(function () {
            config.enabled = !!msg.value;
            return browser.storage.local.set({ enabled: config.enabled });
        }).then(function () {
            return browser.tabs.query({});
        }).then(function (tabs) {
            for (const t of tabs) {
                if (t.id < 0) continue;
                if (!config.enabled) {
                    resetTabResult(t.id);
                }
                updateIcon(t.id, true);
            }
            schedulePersist();
            sendResponse({ ok: true, enabled: config.enabled });
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

    if (msg.type === 'downloadSaveAs') {
        downloadText(msg.text || '', msg.filename || 'm3u8_export.m3u8')
            .then(function () { sendResponse({ ok: true }); })
            .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
        return true;
    }

    if (msg.type === 'getLogs') {
        ensureInit().then(function () {
            sendResponse({ logs: LOG_BUFFER.slice(), version: M3U8Filter.version });
        }).catch(function () {
            sendResponse({ logs: [], version: M3U8Filter.version });
        });
        return true;
    }

    if (msg.type === 'clearLogs') {
        LOG_BUFFER.length = 0;
        schedulePersist();
        sendResponse({ ok: true });
        return;
    }
});

// ============================================================
// 13. 导出
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
// 14. 启动
// ============================================================
ensureInit().catch(function () {});