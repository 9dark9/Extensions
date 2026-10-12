// ============================================================
// M3U8 AD Cleaner - Filter Core
// 版本：1.1.0
//
// 架构：Parse once → filter (只设 seg.removed) → serialize once
//
// 关键词类广告（HIGH 或 LOW）在 parse 时一并标删，命中即短路：
//   - 只跑 parse + serialize，跳过 extractNumbers / detectMode / 各 filter
//
// 索引都在 parse 阶段一并建好：
//   - segments: 一次扫 lines 建成，含 path/prefix/name/strippedName
//   - groups:   按 DISCONTINUITY/ENDLIST 切，含 count/integerCount/
//               totalDuration/totalLength/prefixCount/dominantPrefix
//               names/strippedNames
//   - lengthIndex: Map<length, count> 全局长度分布
//   - hasKeyword: 关键词命中（HIGH 或 LOW）
//   - hasAdTag:   出现 #EXT-X-KEY:METHOD=NONE
// ============================================================

(function (global) {
    'use strict';

    const FILTER_VERSION = '1.1.0';

    const PARAMS = {
        MAX_LINES: 50000,
        NUMERIC_MAX_STEP: 10,
        STEP_SAMPLE_COUNT: 32,
        MIN_TS_COUNT_FOR_PATH_ANALYSIS: 8,
        MAIN_PREFIX_RATIO_THRESHOLD: 0.7,
        MAIN_LENGTH_RATIO_THRESHOLD: 0.7,
        LENGTH_ANOMALY_RATIO: 0.3,
        SHORT_MAX_COUNT: 5,
        SHORT_MODE_THRESHOLD: 5,
        SHORT_FREQ_MAX: 5,
        PROTECT_FREQ: 5,
        PROTECT_RATIO: 0.2,
        SHORT_AD_MAX_INTERVALS: 5,
        SHORT_AD_FRAGMENT_THRESHOLD: 3,
    };

    // ============================================================
    // 广告关键词
    // ============================================================
    const AD_PATH_HIGH = [
        'adjump',
        'adform', 'admaster', 'adsage', 'adwords',
        'atm.youku', 'cupid.iqiyi', 'gtimg.com/qqlive',
        'smartclip', 'samsungads', 'lgsmartad',
        'p1ayer', 'ssai', 'promo', 'sponsor', 'commercial'
    ];

    const AD_PATH_LOW = ['ad', 'ads', 'adx'];

    const AD_LOW_REGEX = new RegExp(
        '(?:^|[/_\\-\.?&=])(?:' + AD_PATH_LOW.join('|') + ')(?=[/_\\-\.?&=]|$)',
        'i'
    );

    const AD_TAG_SOFT = [
        '#EXT-X-KEY:METHOD=NONE',
    ];

    const HEADER_TAGS = [
        '#EXTM3U',
        '#EXT-X-VERSION:',
        '#EXT-X-TARGETDURATION:',
        '#EXT-X-MEDIA-SEQUENCE:',
        '#EXT-X-DISCONTINUITY-SEQUENCE:',
        '#EXT-X-PLAYLIST-TYPE:',
        '#EXT-X-I-FRAMES-ONLY',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-START:',
        '#EXT-X-SERVER-CONTROL:',
        '#EXT-X-PART-INF:',
    ];

    function isHeaderTag(line) {
        for (let i = 0; i < HEADER_TAGS.length; i++) {
            if (line.startsWith(HEADER_TAGS[i])) return true;
        }
        return false;
    }

    const DOMAIN_RULES = [
        {
            name: 'ryplay',
            test: /^(?:[-\w]+\.)*ryplay\d*\.com$/i,
            strategies: ['short', 'integer'],
            options: {
                integerRatioNum: 1,
                integerRatioDen: 3,
                minDuration: 19,
                maxDuration: 23,
            },
        },
        {
            name: 'default',
            test: /.*/,
            strategies: ['short'],
            options: {},
        },
    ];

    const MODE = { NUMERIC: 0, FEATURE: 1, SHORT_INTERVAL: 2, NONE: 3 };
    const MODE_NAME = { 0: '数字异常', 1: '特征识别', 2: '短区间', 3: '无' };

    // ============================================================
    // 基础工具
    // ============================================================
    function cleanUri(uri) {
        let s = uri;
        const schemeIdx = s.indexOf('://');
        if (schemeIdx !== -1) {
            const pathStart = s.indexOf('/', schemeIdx + 3);
            s = pathStart === -1 ? '/' : s.slice(pathStart);
        }
        let end = s.length;
        const q = s.indexOf('?');
        if (q !== -1 && q < end) end = q;
        const h = s.indexOf('#');
        if (h !== -1 && h < end) end = h;
        return s.slice(0, end);
    }

    function extractPathPrefix(uri) {
        if (!uri) return '';
        let end = uri.length;
        const q = uri.indexOf('?');
        if (q !== -1 && q < end) end = q;
        const h = uri.indexOf('#');
        if (h !== -1 && h < end) end = h;
        if (end === 0) return '';
        const idx = uri.lastIndexOf('/', end - 1);
        return idx < 0 ? '' : uri.slice(0, idx + 1);
    }

    function parseExtinfDuration(line) {
        if (!line || line.charCodeAt(0) !== 35) return null;
        if (!line.startsWith('#EXTINF:')) return null;
        const v = parseFloat(line.slice(8));
        return isNaN(v) ? null : v;
    }

    function matchAdPath(uri) {
        if (!uri) return null;
        for (let i = 0; i < AD_PATH_HIGH.length; i++) {
            if (uri.indexOf(AD_PATH_HIGH[i]) !== -1) {
                return { level: 'high', keyword: AD_PATH_HIGH[i] };
            }
        }
        if (AD_LOW_REGEX.test(uri)) {
            return { level: 'low', keyword: null };
        }
        return null;
    }

    function matchAdTag(line) {
        if (!line || typeof line !== 'string') return null;
        for (let i = 0; i < AD_TAG_SOFT.length; i++) {
            if (line.startsWith(AD_TAG_SOFT[i])) return AD_TAG_SOFT[i];
        }
        return null;
    }

    // ============================================================
    // LCP/LCS 骨架探测
    //
    // 退化规则：只要骨架（LCP + LCS）里还有字符，并且边界是数字，
    // 就继续往里缩。因为末尾/头部的数字属于"编号"，不应视为骨架。
    // 直到骨架两端都非数字，或者骨架把整串覆盖（无内容可提取）。
    // ============================================================
    function trySkeleton(strings) {
        if (strings.length < 3) return { ok: false };

        const first = strings[0];
        const firstLen = first.length;
        let lcpLen = firstLen;
        let lcsLen = firstLen;

        for (let i = 1; i < strings.length; i++) {
            const b = strings[i];
            const bLen = b.length;

            let p = 0;
            const maxP = Math.min(lcpLen, bLen);
            while (p < maxP && first[p] === b[p]) p++;
            lcpLen = p;

            let s = 0;
            const maxS = Math.min(lcsLen, bLen);
            while (s < maxS && first[firstLen - 1 - s] === b[bLen - 1 - s]) s++;
            lcsLen = s;
        }

        while (lcpLen + lcsLen > 0) {
            const lcpLast = lcpLen > 0 ? first[lcpLen - 1] : '';
            const lcsFirst = lcsLen > 0 ? first[firstLen - lcsLen] : '';

            const lcpIsDigit = lcpLen > 0 && lcpLast >= '0' && lcpLast <= '9';
            const lcsIsDigit = lcsLen > 0 && lcsFirst >= '0' && lcsFirst <= '9';

            if (lcpIsDigit) lcpLen--;
            else if (lcsIsDigit) lcsLen--;
            else break;
        }

        if (lcpLen + lcsLen >= firstLen) return { ok: false };

        const lcp = lcpLen === 0 ? '' : first.slice(0, lcpLen);
        const lcs = lcsLen === 0 ? '' : first.slice(firstLen - lcsLen);
        return { ok: true, lcp: lcp, lcs: lcs };
    }

    // ============================================================
    // Parse
    // ============================================================
    function parsePlaylist(rawLines) {
        const lines = [];
        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i];
            if (!line) continue;
            if (line.startsWith('#') && !line.startsWith('#EXT')) continue;

            if (line.startsWith('#EXT-X-DISCONTINUITY')) {
                if (lines.length > 0 && lines[lines.length - 1].startsWith('#EXT-X-DISCONTINUITY')) continue;
                if (i + 1 < rawLines.length && rawLines[i + 1].startsWith('#EXT-X-ENDLIST')) continue;
            }
            lines.push(line);
        }

        let firstExtinf = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXTINF:')) { firstExtinf = i; break; }
        }

        if (firstExtinf === -1) {
            return {
                header: lines,
                segments: [],
                groups: [],
                lengthIndex: new Map(),
                hasAdTag: false,
                hasKeyword: false,
                empty: true,
                mode: MODE.NONE,
                tail: [],
            };
        }

        const header = [];
        const segments = [];
        const groups = [];
        const lengthIndex = new Map();
        const tail = [];
        let pendingPreLines = [];
        let groupId = 0;
        let hasAdTag = false;
        let hasKeyword = false;
        let curGroup = null;

        for (let i = 0; i < firstExtinf; i++) {
            const line = lines[i];
            if (isHeaderTag(line)) {
                header.push(line);
            } else {
                if (line.startsWith('#EXT-X-DISCONTINUITY')) groupId++;
                pendingPreLines.push(line);
            }
        }

        function startGroup() {
            curGroup = {
                groupId: groupId,
                segments: [],
                count: 0,
                integerCount: 0,
                totalDuration: 0,
                totalLength: 0,
                prefixCount: new Map(),
                dominantPrefix: '',
                names: [],
                strippedNames: [],
            };
        }

        function endGroup() {
            if (!curGroup) return;
            if (curGroup.count === 0) { curGroup = null; return; }

            let best = 0, bestP = '';
            curGroup.prefixCount.forEach(function (c, p) {
                if (c > best) { best = c; bestP = p; }
            });
            curGroup.dominantPrefix = bestP;
            groups.push(curGroup);
            curGroup = null;
        }

        let i = firstExtinf;
        while (i < lines.length) {
            const line = lines[i];

            if (line.startsWith('#EXTINF:')) {
                if (i + 1 >= lines.length || lines[i + 1].startsWith('#')) {
                    for (const pl of pendingPreLines) tail.push(pl);
                    pendingPreLines = [];
                    tail.push(line);
                    i++;
                    continue;
                }

                if (!curGroup) startGroup();

                const extinfLine = line;
                const mediaLine = lines[i + 1];
                const duration = parseExtinfDuration(extinfLine);
                const path = cleanUri(mediaLine);
                const prefix = extractPathPrefix(mediaLine);
                const len = mediaLine.length;
                const isIntDur = duration !== null && Number.isInteger(duration);

                const lastSlash = path.lastIndexOf('/');
                const name = lastSlash < 0 ? path : path.slice(lastSlash + 1);
                const strippedName = name.replace(/\.[a-z0-9]{1,8}$/i, '');

                const seg = {
                    preLines: pendingPreLines,
                    extinfLine: extinfLine,
                    mediaLine: mediaLine,
                    path: path,
                    prefix: prefix,
                    num: null,
                    duration: duration,
                    isIntegerDuration: isIntDur,
                    groupId: groupId,
                    removed: false,
                };

                segments.push(seg);
                curGroup.segments.push(seg);
                curGroup.count++;
                if (isIntDur) curGroup.integerCount++;
                if (duration !== null) curGroup.totalDuration += duration;
                curGroup.totalLength += len;
                curGroup.prefixCount.set(prefix, (curGroup.prefixCount.get(prefix) || 0) + 1);

                curGroup.names.push(name);
                curGroup.strippedNames.push(strippedName);

                lengthIndex.set(len, (lengthIndex.get(len) || 0) + 1);

                // 关键词类：HIGH 或 LOW 命中即标删
                if (matchAdPath(mediaLine)) {
                    hasKeyword = true;
                    seg.removed = true;
                }

                pendingPreLines = [];
                i += 2;
                continue;
            }

            if (line.startsWith('#EXT-X-DISCONTINUITY')) {
                endGroup();
                groupId++;
                pendingPreLines.push(line);
                i++;
                continue;
            }

            if (line.startsWith('#EXT-X-ENDLIST')) {
                endGroup();
                for (const pl of pendingPreLines) tail.push(pl);
                pendingPreLines = [];
                while (i < lines.length) { tail.push(lines[i]); i++; }
                break;
            }

            if (line.startsWith('#')) {
                if (matchAdTag(line)) hasAdTag = true;
                pendingPreLines.push(line);
                i++;
                continue;
            }

            i++;
        }

        endGroup();
        for (const pl of pendingPreLines) tail.push(pl);

        return {
            header: header,
            segments: segments,
            groups: groups,
            lengthIndex: lengthIndex,
            hasAdTag: hasAdTag,
            hasKeyword: hasKeyword,
            empty: false,
            mode: MODE.NONE,
            tail: tail,
        };
    }

    // ============================================================
    // 按组提取数字 + 按 LCP/LCS 分组共享基准值
    //
    // 退化时边界数字会被挤进 mid（如 "8000000" 里的前导 8）。
    // 同一个视频源（LCP/LCS 相同）的多个组偏移量必然一致，应共享
    // 同一个 base —— 取该 key 下第一个组的第一个数字。
    // 正片跨 DISCONTINUITY 仍保持数字连续，广告组各自归一。
    //
    // 组内任意一个段提取失败 → allValid=false → 整组 num=null
    // ============================================================
    function extractNumbers(groups) {
        let numCount = 0;
        const first32Nums = [];
        const limit = PARAMS.STEP_SAMPLE_COUNT;

        const groupData = [];
        const baseMap = new Map();

        // 第一阶段：提取原始数字
        for (let g = 0; g < groups.length; g++) {
            const grp = groups[g];
            if (grp.count < 3) { groupData.push(null); continue; }

            let version, lcp, lcs;

            const rA = trySkeleton(grp.strippedNames);
            if (rA.ok) {
                version = 'A'; lcp = rA.lcp; lcs = rA.lcs;
            } else {
                const rB = trySkeleton(grp.names);
                if (!rB.ok) { groupData.push(null); continue; }
                version = 'B'; lcp = rB.lcp; lcs = rB.lcs;
            }

            const useStripped = (version === 'A');
            const source = useStripped ? grp.strippedNames : grp.names;
            const nums = [];
            let allValid = true;

            const lcpLen = lcp.length;
            const lcsLen = lcs.length;

            for (let i = 0; i < source.length; i++) {
                const s = source[i];
                if (!s.startsWith(lcp) || (lcs && !s.endsWith(lcs))) {
                    allValid = false; break;
                }
                const mid = s.slice(lcpLen, s.length - lcsLen);
                if (!/^\d+$/.test(mid)) { allValid = false; break; }
                nums.push(parseInt(mid, 10));
            }

            if (!allValid) { groupData.push(null); continue; }

            const key = version + '\u0001' + lcp + '\u0001' + lcs;
            groupData.push({ nums: nums, segs: grp.segments, key: key });
        }

        // 第二阶段：每个 key 取第一个组的第一个数字作为 base
        for (let g = 0; g < groupData.length; g++) {
            const d = groupData[g];
            if (!d) continue;
            if (!baseMap.has(d.key)) {
                baseMap.set(d.key, d.nums[0]);
            }
        }

        // 第三阶段：应用
        for (let g = 0; g < groupData.length; g++) {
            const d = groupData[g];
            if (!d) continue;
            const base = baseMap.get(d.key);
            for (let i = 0; i < d.nums.length; i++) {
                const adjusted = d.nums[i] - base;
                d.segs[i].num = adjusted;
                numCount++;
                if (first32Nums.length < limit) first32Nums.push(adjusted);
            }
        }

        return { numCount: numCount, first32Nums: first32Nums };
    }

    // ============================================================
    // step：前 N 个 num 的众数差
    // ============================================================
    function computeStep(nums) {
        const limit = Math.min(nums.length, PARAMS.STEP_SAMPLE_COUNT);
        if (limit < 2) return 0;

        const diffFreq = new Map();
        for (let i = 1; i < limit; i++) {
            const d = nums[i] - nums[i - 1];
            diffFreq.set(d, (diffFreq.get(d) || 0) + 1);
        }

        let step = 0;
        let bestCount = 0;
        diffFreq.forEach(function (c, d) {
            if (c > bestCount || (c === bestCount && d > 0)) {
                bestCount = c;
                step = d;
            }
        });

        if (step <= 0 || step > PARAMS.NUMERIC_MAX_STEP) return 0;
        return step;
    }

    // ============================================================
    // 少数派 / 长度异常分析（读 groups + lengthIndex）
    // ============================================================
    function analyzePathPrefixes(playlist) {
        const groups = playlist.groups;
        const lengthIndex = playlist.lengthIndex;

        const prefixTotal = new Map();
        let total = 0;
        for (let i = 0; i < groups.length; i++) {
            const grp = groups[i];
            grp.prefixCount.forEach(function (c, p) {
                prefixTotal.set(p, (prefixTotal.get(p) || 0) + c);
                total += c;
            });
        }

        if (total < PARAMS.MIN_TS_COUNT_FOR_PATH_ANALYSIS) {
            return { hasMinority: false, hasLengthAnomaly: false };
        }

        let mainPrefix = '', mainCount = 0;
        prefixTotal.forEach(function (c, p) {
            if (c > mainCount) { mainCount = c; mainPrefix = p; }
        });
        const hasMinority = (mainCount / total) >= PARAMS.MAIN_PREFIX_RATIO_THRESHOLD && prefixTotal.size > 1;

        let mainLen = 0, mainLenCount = 0;
        lengthIndex.forEach(function (c, l) {
            if (c > mainLenCount) { mainLenCount = c; mainLen = l; }
        });
        const hasLengthAnomaly = (mainLenCount / total) >= PARAMS.MAIN_LENGTH_RATIO_THRESHOLD && lengthIndex.size > 1;

        return {
            hasMinority: hasMinority,
            hasLengthAnomaly: hasLengthAnomaly,
            mainPrefix: mainPrefix,
            mainLen: mainLen,
            prefixTotal: prefixTotal,
        };
    }

    // ============================================================
    // 模式判定（关键词已在 parse 处理，短路后不进入此函数）
    // ============================================================
    function detectMode(playlist, numStats) {
        const pathInfo = analyzePathPrefixes(playlist);

        if (playlist.hasAdTag && (pathInfo.hasMinority || pathInfo.hasLengthAnomaly)) {
            return { mode: MODE.FEATURE, pathInfo: pathInfo };
        }

        if (numStats.numCount >= 3) {
            const step = computeStep(numStats.first32Nums);
            if (step > 0) {
                return { mode: MODE.NUMERIC, step: step };
            }
        }

        if (pathInfo.hasMinority || pathInfo.hasLengthAnomaly) {
            return { mode: MODE.FEATURE, pathInfo: pathInfo };
        }

        return { mode: MODE.SHORT_INTERVAL };
    }

    // ============================================================
    // 特征模式过滤（关键词已在 parse 处理，这里只管少数派/长度异常）
    // ============================================================
    function filterFeature(playlist, ctx) {
        const rules = new Set();
        const pathInfo = ctx.pathInfo;
        if (!pathInfo || (!pathInfo.hasMinority && !pathInfo.hasLengthAnomaly)) {
            return [];
        }

        const groups = playlist.groups;

        for (let g = 0; g < groups.length; g++) {
            const grp = groups[g];
            if (grp.count === 0) continue;

            let hasTagInGroup = false;
            for (let i = 0; i < grp.segments.length; i++) {
                const pre = grp.segments[i].preLines;
                for (let j = 0; j < pre.length; j++) {
                    if (matchAdTag(pre[j])) { hasTagInGroup = true; break; }
                }
                if (hasTagInGroup) break;
            }

            if (grp.prefixCount.size === 1) {
                const hitMinority = pathInfo.hasMinority && grp.dominantPrefix !== pathInfo.mainPrefix;
                const avgLen = grp.totalLength / grp.count;
                const hitLength = pathInfo.hasLengthAnomaly &&
                    Math.abs(avgLen - pathInfo.mainLen) / pathInfo.mainLen > PARAMS.LENGTH_ANOMALY_RATIO;

                if (hitMinority || hitLength) {
                    let reason;
                    if (hasTagInGroup) reason = '标签标识';
                    else if (hitMinority) reason = '少数派';
                    else reason = '长度异常';

                    for (let i = 0; i < grp.segments.length; i++) {
                        grp.segments[i].removed = true;
                    }
                    rules.add(reason);
                }
            } else {
                const groupMain = grp.dominantPrefix;
                let removedAny = false;
                for (let i = 0; i < grp.segments.length; i++) {
                    const seg = grp.segments[i];
                    if (seg.removed) continue;
                    if (seg.prefix !== groupMain) {
                        seg.removed = true;
                        removedAny = true;
                    }
                }
                if (removedAny) rules.add('少数派');
            }
        }

        return Array.from(rules);
    }

    // ============================================================
    // 数字递增模式过滤
    //
    // A/B 交替规则：
    //   - 匹配当前链（cur === prevNum + step）→ 累加
    //   - 数字跳变 且 存在 DISCONTINUITY → 交替 active
    //       · 首次进入另一链 → 初始化 posB / prevNumB / countB
    //       · 能接上另一链 → 延续计数
    //       · 接不上 → 保持不动（不重置数据）
    //   - 其余情况 → 什么都不做
    //
    // 无 num 的段：
    //   - 计数循环中跳过（continue）
    //   - 删除循环中因 seg.num === null 走 else → 被删除
    // ============================================================
    function filterNumeric(playlist, step) {
        const segments = playlist.segments;
        const n = segments.length;

        if (!step || step <= 0 || n < 3) return [];

        let firstIdx = -1;
        for (let i = 0; i < n; i++) {
            if (segments[i].num !== null) { firstIdx = i; break; }
        }
        if (firstIdx < 0) return [];

        function hasDisc(seg) {
            for (let j = 0; j < seg.preLines.length; j++) {
                if (seg.preLines[j].startsWith('#EXT-X-DISCONTINUITY')) return true;
            }
            return false;
        }

        let prevNumA = segments[firstIdx].num;
        let countA = 0;
        let posB = -1;
        let prevNumB = 0;
        let countB = 0;
        let active = 'A';

        for (let i = firstIdx + 1; i < n; i++) {
            const seg = segments[i];
            if (seg.num === null) continue;
            const cur = seg.num;

            if (active === 'A') {
                if (cur === prevNumA + step) {
                    // 匹配 A 链 → 累加
                    countA++;
                    prevNumA = cur;
                } else if (hasDisc(seg)) {
                    // 数字跳变 且 存在 DISCONTINUITY → 交替到 B
                    if (posB < 0) {
                        // 首次进入 B：初始化
                        posB = i;
                        prevNumB = cur;
                        countB = 0;
                    } else if (cur === prevNumB + step) {
                        // 接得上 B：延续
                        countB++;
                        prevNumB = cur;
                    }
                    // 接不上：B 状态保持不动
                    active = 'B';
                }
                // 跳变但无 disc：什么都不做

            } else { // active === 'B'
                if (cur === prevNumB + step) {
                    // 匹配 B 链 → 累加
                    countB++;
                    prevNumB = cur;
                } else if (hasDisc(seg)) {
                    // 数字跳变 且 存在 DISCONTINUITY → 交替到 A
                    if (cur === prevNumA + step) {
                        countA++;
                        prevNumA = cur;
                    }
                    // 接不上：A 状态保持不动
                    active = 'A';
                }
                // 跳变但无 disc：什么都不做
            }
        }

        let pos, firstNum;
        if (countA >= countB) {
            pos = firstIdx;
            firstNum = segments[firstIdx].num;
        } else {
            pos = posB;
            firstNum = segments[posB].num;
        }

        let prevNum = firstNum;
        let seenPos = false;
        let removedAny = false;

        for (let i = 0; i < n; i++) {
            const seg = segments[i];

            if (i < pos) { seg.removed = true; removedAny = true; continue; }
            if (!seenPos) { seenPos = true; prevNum = firstNum; continue; }

            if (seg.num !== null && seg.num === prevNum + step) {
                prevNum = seg.num;
            } else {
                seg.removed = true;
                removedAny = true;
            }
        }

        return removedAny ? ['数字异常'] : [];
    }

    // ============================================================
    // 短区间模式过滤
    // ============================================================
    function matchDomainRule(host) {
        const h = host || '';
        for (let i = 0; i < DOMAIN_RULES.length; i++) {
            if (DOMAIN_RULES[i].test.test(h)) return DOMAIN_RULES[i];
        }
        return DOMAIN_RULES[DOMAIN_RULES.length - 1];
    }

    function strategyInteger(intervals, options) {
        const result = new Set();
        const integerRatioNum = (options && options.integerRatioNum) || 1;
        const integerRatioDen = (options && options.integerRatioDen) || 1;
        const minDuration = (options && options.minDuration !== undefined) ? options.minDuration : null;
        const maxDuration = (options && options.maxDuration !== undefined) ? options.maxDuration : null;

        for (let i = 0; i < intervals.length; i++) {
            const it = intervals[i];
            if (it.count === 0) continue;
            if (it.integerCount * integerRatioDen < it.count * integerRatioNum) continue;
            if (!Number.isInteger(it.totalDuration)) continue;
            if (minDuration !== null && it.totalDuration < minDuration) continue;
            if (maxDuration !== null && it.totalDuration > maxDuration) continue;
            result.add(it);
        }
        return result;
    }

    function strategyShort(intervals) {
        const result = new Set();
        const valid = [];
        for (let i = 0; i < intervals.length; i++) {
            if (intervals[i].count > 0) valid.push(intervals[i]);
        }
        if (valid.length === 0) return result;

        const freq = new Map();
        for (let i = 0; i < valid.length; i++) {
            const c = valid[i].count;
            freq.set(c, (freq.get(c) || 0) + 1);
        }

        let modeCount = 0, modeValue = 0;
        freq.forEach(function (f, cnt) {
            if (f > modeCount || (f === modeCount && cnt > modeValue)) {
                modeCount = f;
                modeValue = cnt;
            }
        });
        const modeRatio = modeCount / valid.length;

        let short;
        if (modeRatio >= 0.5) {
            short = valid.filter(function (it) {
                if (modeValue > PARAMS.SHORT_MODE_THRESHOLD) {
                    return it.count <= PARAMS.SHORT_MAX_COUNT;
                }
                return it.count < modeValue;
            });
        } else {
            short = valid.filter(function (it) {
                const f = freq.get(it.count) || 0;
                return it.count <= PARAMS.SHORT_MAX_COUNT && f <= PARAMS.SHORT_FREQ_MAX;
            });
            short = short.filter(function (it) {
                const f = freq.get(it.count) || 0;
                const ratio = f / valid.length;
                if (f >= PARAMS.PROTECT_FREQ && ratio >= PARAMS.PROTECT_RATIO) return false;
                return true;
            });
        }

        for (let i = 0; i < short.length; i++) result.add(short[i]);
        return result;
    }

    function filterShortInterval(playlist, host) {
        const rule = matchDomainRule(host);
        const groups = playlist.groups;
        if (groups.length === 0) return [];

        const intervals = groups.map(function (grp) {
            return {
                group: grp,
                count: grp.count,
                integerCount: grp.integerCount,
                totalDuration: grp.totalDuration,
            };
        });

        const toDelete = new Set();
        const rules = new Set();

        for (let i = 0; i < rule.strategies.length; i++) {
            const name = rule.strategies[i];
            let partial;
            if (name === 'short') {
                partial = strategyShort(intervals);
                if (partial.size > 0) rules.add('短区间');
            } else if (name === 'integer') {
                partial = strategyInteger(intervals, rule.options);
                if (partial.size > 0) rules.add('整数时长');
            } else continue;
            partial.forEach(function (it) { toDelete.add(it); });
        }

        if (toDelete.size > PARAMS.SHORT_AD_MAX_INTERVALS) {
            const kept = new Set();
            toDelete.forEach(function (it) {
                if (it.count <= PARAMS.SHORT_AD_FRAGMENT_THRESHOLD) kept.add(it);
            });
            toDelete.clear();
            kept.forEach(function (it) { toDelete.add(it); });
        }

        toDelete.forEach(function (it) {
            for (let i = 0; i < it.group.segments.length; i++) {
                it.group.segments[i].removed = true;
            }
        });

        return Array.from(rules);
    }

    // ============================================================
    // 序列化
    // ============================================================
    function serialize(playlist) {
        const out = [];
        const ads = [];
        let removedCount = 0;
        // 主要解决短区间误过滤正常片段导致音画不同步的问题，其他模式全删
        const keepRearDisc = (playlist.mode === MODE.SHORT_INTERVAL);

        for (let i = 0; i < playlist.header.length; i++) {
            out.push(playlist.header[i]);
        }

        let prevWasKept = null;

        for (let i = 0; i < playlist.segments.length; i++) {
            const seg = playlist.segments[i];

            if (seg.removed) {
                for (let j = 0; j < seg.preLines.length; j++) {
                    ads.push(seg.preLines[j]);
                    removedCount++;
                }
                ads.push(seg.extinfLine);
                removedCount++;
                ads.push(seg.mediaLine);
                removedCount++;
                prevWasKept = false;
                continue;
            }

            let discCount = 0;
            for (let j = 0; j < seg.preLines.length; j++) {
                const pl = seg.preLines[j];
                if (pl.startsWith('#EXT-X-DISCONTINUITY')) {
                    discCount++;
                } else {
                    out.push(pl);
                }
            }

            if (discCount > 0) {
                if (prevWasKept === false && !keepRearDisc) {
                    for (let k = 0; k < discCount; k++) ads.push('#EXT-X-DISCONTINUITY');
                    removedCount += discCount;
                } else {
                    out.push('#EXT-X-DISCONTINUITY');
                    removedCount += discCount - 1;
                    for (let k = 1; k < discCount; k++) ads.push('#EXT-X-DISCONTINUITY');
                }
            }

            out.push(seg.extinfLine);
            out.push(seg.mediaLine);
            prevWasKept = true;
        }

        for (let i = 0; i < playlist.tail.length; i++) {
            out.push(playlist.tail[i]);
        }

        return { lines: out, ads: ads, removedCount: removedCount };
    }

    // ============================================================
    // 主入口
    // ============================================================
    function filterM3U8(text, url) {
        const stats = {
            originalLines: 0,
            removedLines: 0,
            mode: MODE.NONE,
            modeName: MODE_NAME[MODE.NONE],
            ruleName: '',
            rules: [],
            error: null,
            master: false,
        };

        const emptyResult = function (mod, changed) {
            return { modified: mod, changed: changed, stats: stats, headLines: [], ads: [] };
        };

        // ---- 空响应 ----
        if (!text || typeof text !== 'string' || text.length === 0) {
            stats.error = 'empty';
            return emptyResult(text, false);
        }

        // ---- 剥 BOM 和前置空白，判断响应类型 ----
        const trimmed = text.replace(/^\uFEFF/, '').replace(/^\s+/, '');

        if (trimmed.length === 0) {
            stats.error = 'empty';
            return emptyResult(text, false);
        }

        // HTML 响应（错误页/重定向页）
        if (trimmed.charCodeAt(0) === 0x3C) {
            stats.error = 'html';
            return emptyResult(text, false);
        }

        // 非 m3u8 内容
        if (trimmed.slice(0, 64).indexOf('#EXTM3U') === -1) {
            stats.error = 'not-m3u8';
            return emptyResult(text, false);
        }

        // ---- master playlist：有变体流声明，静默跳过 ----
        if (text.indexOf('#EXT-X-STREAM-INF') !== -1) {
            stats.master = true;
            return emptyResult(text, false);
        }

        let rawLines;
        try { rawLines = text.split('\n'); }
        catch (e) { stats.error = 'split failed'; return emptyResult(text, false); }

        stats.originalLines = rawLines.length;

        if (rawLines.length > PARAMS.MAX_LINES) {
            stats.error = 'too many lines';
            return emptyResult(text, false);
        }

        let playlist;
        try { playlist = parsePlaylist(rawLines); }
        catch (e) { stats.error = String(e); return emptyResult(text, false); }

        // 有 #EXTM3U 但无任何分片：异常
        if (playlist.empty) {
            stats.error = 'empty-playlist';
            return emptyResult(text, false);
        }

        // ---- 关键词短路：命中即 serialize ----
        if (playlist.hasKeyword) {
            playlist.mode = MODE.FEATURE;
            stats.mode = playlist.mode;
            stats.modeName = MODE_NAME[playlist.mode];
            stats.rules = ['关键词'];

            const ser = serialize(playlist);
            stats.removedLines = ser.removedCount;

            const headLines = playlist.header.slice();
            if (headLines.length === 0 || headLines[0] !== '#EXTM3U') headLines.unshift('#EXTM3U');

            if (ser.removedCount === 0) {
                return { modified: text, changed: false, stats: stats, headLines: headLines, ads: [] };
            }
            return {
                modified: ser.lines.join('\n'),
                changed: true, stats: stats, headLines: headLines, ads: ser.ads
            };
        }

        // ---- 提取数字 + numStats ----
        let numStats = { numCount: 0, first32Nums: [] };
        try { numStats = extractNumbers(playlist.groups); }
        catch (e) { /* 不致命 */ }

        // ---- 模式判定 ----
        const ctx = detectMode(playlist, numStats);
        playlist.mode = ctx.mode;
        stats.mode = playlist.mode;
        stats.modeName = MODE_NAME[playlist.mode] || MODE_NAME[MODE.NONE];

        // ---- 过滤 ----
        let rules;
        try {
            switch (ctx.mode) {
                case MODE.FEATURE:
                    rules = filterFeature(playlist, ctx);
                    break;
                case MODE.NUMERIC:
                    rules = filterNumeric(playlist, ctx.step);
                    break;
                case MODE.SHORT_INTERVAL: {
                    let host = '';
                    try { host = new URL(url).hostname; } catch (e) {}
                    stats.ruleName = matchDomainRule(host).name;
                    rules = filterShortInterval(playlist, host);
                    break;
                }
                default:
                    rules = [];
            }
        } catch (e) {
            stats.error = String(e);
            return emptyResult(text, false);
        }

        stats.rules = rules || [];

        // ---- 序列化 ----
        const ser = serialize(playlist);
        stats.removedLines = ser.removedCount;

        const headLines = playlist.header.slice();
        if (headLines.length === 0 || headLines[0] !== '#EXTM3U') headLines.unshift('#EXTM3U');

        if (ser.removedCount === 0) {
            return { modified: text, changed: false, stats: stats, headLines: headLines, ads: [] };
        }
        return {
            modified: ser.lines.join('\n'),
            changed: true, stats: stats, headLines: headLines, ads: ser.ads
        };
    }

    global.M3U8Filter = {
        version: FILTER_VERSION,
        params: PARAMS,
        filterM3U8: filterM3U8,
        _internal: {
            MODE: MODE,
            MODE_NAME: MODE_NAME,
            DOMAIN_RULES: DOMAIN_RULES,
            AD_PATH_HIGH: AD_PATH_HIGH,
            AD_PATH_LOW: AD_PATH_LOW,
            AD_TAG_SOFT: AD_TAG_SOFT,
            HEADER_TAGS: HEADER_TAGS,
            parsePlaylist: parsePlaylist,
            extractNumbers: extractNumbers,
            detectMode: detectMode,
            filterFeature: filterFeature,
            filterNumeric: filterNumeric,
            filterShortInterval: filterShortInterval,
            serialize: serialize,
            trySkeleton: trySkeleton,
            cleanUri: cleanUri,
            extractPathPrefix: extractPathPrefix,
            analyzePathPrefixes: analyzePathPrefixes,
            computeStep: computeStep,
            matchDomainRule: matchDomainRule,
            matchAdPath: matchAdPath,
            matchAdTag: matchAdTag,
        }
    };

})(typeof window !== 'undefined' ? window : self);