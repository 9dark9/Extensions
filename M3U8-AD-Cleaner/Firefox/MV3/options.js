// ============================================================
// M3U8 AD Cleaner - Options (Firefox)
// ============================================================

(function () {
    'use strict';

    const el = {
        whitelistChips: document.getElementById('whitelistChips'),
        whitelistInput: document.getElementById('whitelistInput'),
        whitelistAddBtn: document.getElementById('whitelistAddBtn'),
        excludeChips: document.getElementById('excludeChips'),
        excludeInput: document.getElementById('excludeInput'),
        excludeAddBtn: document.getElementById('excludeAddBtn'),
        currentModeText: document.getElementById('currentModeText'),
        resetAllBtn: document.getElementById('resetAllBtn'),
        importConfigBtn: document.getElementById('importConfigBtn'),
        exportConfigBtn: document.getElementById('exportConfigBtn'),
        importFileInput: document.getElementById('importFileInput'),
        savedTip: document.getElementById('savedTip')
    };

    let savedTipTimer = null;
    function flashSaved(text) {
        el.savedTip.textContent = text || '已保存';
        el.savedTip.classList.add('show');
        if (savedTipTimer) clearTimeout(savedTipTimer);
        savedTipTimer = setTimeout(function () {
            el.savedTip.classList.remove('show');
        }, 1500);
    }

    // ★ 判断是否为正则项
    function isRegexItem(item) {
        return typeof item === 'string' && item.startsWith('/') && item.lastIndexOf('/') > 0;
    }

    // ★ 兼容正则的输入归一化
    function normalizeHost(raw) {
        if (!raw) return '';
        let s = String(raw).trim();
        if (!s) return '';
        if (isRegexItem(s)) return s;

        s = s.toLowerCase();
        s = s.replace(/^[a-z]+:\/\//, '');
        s = s.replace(/[/?#].*$/, '');
        s = s.replace(/:\d+$/, '');
        return s;
    }

    // ★ 兼容正则的校验
    function isValidHost(h) {
        if (!h) return false;
        if (h === 'localhost') return true;
        if (isRegexItem(h)) {
            try {
                const lastSlash = h.lastIndexOf('/');
                const pattern = h.slice(1, lastSlash);
                const flags = h.slice(lastSlash + 1) || 'i';
                new RegExp(pattern, flags);
                return true;
            } catch (e) {
                return false;
            }
        }
        return /^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$/.test(h);
    }

    // 跳过正则，仅处理普通域名
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

    // 跳过正则，仅处理普通域名
    function findAllRelatedHosts(target, hostList) {
        if (!target || !hostList || hostList.length === 0) return [];
        const t = target.toLowerCase();
        return hostList.filter(function (x) {
            if (isRegexItem(x)) return false;
            return x === t || t.endsWith('.' + x) || x.endsWith('.' + t);
        });
    }

    async function isHardExcluded(h) {
        try {
            const r = await browser.runtime.sendMessage({
                type: 'checkHardExclude',
                host: h
            });
            return !!(r && r.isHardExcluded);
        } catch (e) {
            return false;
        }
    }

    const state = {
        whitelistMode: false,
        whitelistHosts: [],
        excludeHosts: []
    };

    async function load() {
        const data = await browser.storage.local.get({
            whitelist_mode: false,
            whitelist_hosts: [],
            extra_exclude_hosts: []
        });
        state.whitelistMode = !!data.whitelist_mode;
        state.whitelistHosts = Array.isArray(data.whitelist_hosts)
            ? data.whitelist_hosts.map(h => String(h).trim()).filter(Boolean) : [];
        state.excludeHosts = Array.isArray(data.extra_exclude_hosts)
            ? data.extra_exclude_hosts.map(h => String(h).trim()).filter(Boolean) : [];
        render();
    }

    function updateModeText() {
        if (el.currentModeText) {
            el.currentModeText.textContent = state.whitelistMode ? '白名单模式' : '全匹配模式';
        }
    }

    async function saveWhitelist() {
        await browser.storage.local.set({ whitelist_hosts: state.whitelistHosts });
    }

    async function saveExclude() {
        await browser.storage.local.set({ extra_exclude_hosts: state.excludeHosts });
    }

    function renderChips(container, hosts, onRemove) {
        container.innerHTML = '';
        if (hosts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '（列表为空）';
            container.appendChild(empty);
            return;
        }
        for (const h of hosts) {
            const chip = document.createElement('span');
            chip.className = 'chip';

            const hostSpan = document.createElement('span');
            hostSpan.className = 'host';
            hostSpan.textContent = h;
            hostSpan.title = h;

            const xBtn = document.createElement('button');
            xBtn.className = 'x';
            xBtn.type = 'button';
            xBtn.textContent = '×';
            xBtn.title = '删除 ' + h;
            xBtn.addEventListener('click', function () {
                onRemove(h);
            });

            chip.appendChild(hostSpan);
            chip.appendChild(xBtn);
            container.appendChild(chip);
        }
    }

    function render() {
        updateModeText();
        renderChips(el.whitelistChips, state.whitelistHosts, async function (h) {
            state.whitelistHosts = state.whitelistHosts.filter(x => x !== h);
            await saveWhitelist();
            flashSaved();
            render();
        });
        renderChips(el.excludeChips, state.excludeHosts, async function (h) {
            state.excludeHosts = state.excludeHosts.filter(x => x !== h);
            await saveExclude();
            flashSaved();
            render();
        });
    }

    function highlightChip(container, host) {
        let chips;
        try {
            chips = container.querySelectorAll('.chip');
        } catch (e) { return; }
        for (let i = 0; i < chips.length; i++) {
            const hostSpan = chips[i].querySelector('.host');
            if (hostSpan && hostSpan.textContent === host) {
                chips[i].classList.add('chip-new');
                (function (elChip) {
                    setTimeout(function () {
                        elChip.classList.remove('chip-new');
                    }, 2100);
                })(chips[i]);
                try {
                    chips[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                } catch (e) {}
                break;
            }
        }
    }

    function markChipsAsRemoving(container, hostList) {
        if (!container || !hostList || hostList.length === 0) return;
        const chips = container.querySelectorAll('.chip');
        for (let i = 0; i < chips.length; i++) {
            const hostSpan = chips[i].querySelector('.host');
            if (hostSpan && hostList.indexOf(hostSpan.textContent) !== -1) {
                chips[i].classList.add('chip-removing');
            }
        }
    }

    async function addWhitelist() {
        const raw = el.whitelistInput.value;
        const h = normalizeHost(raw);
        if (!h) return;
        if (!isValidHost(h)) {
            alert('格式无效：' + raw);
            return;
        }

        const isRegex = isRegexItem(h);

        // 硬排除只对普通域名判断
        if (!isRegex && await isHardExcluded(h)) {
            alert('“' + h + '” 在内置排除名单中，无法加入白名单。');
            el.whitelistInput.value = '';
            return;
        }

        const wasDuplicate = state.whitelistHosts.indexOf(h) !== -1;
        let related = [];
        let needsConfirm = [];
        let exToRemove = [];

        if (!isRegex) {
            related = findAllRelatedHosts(h, state.whitelistHosts);
            needsConfirm = related.filter(function (x) { return x !== h; });
            exToRemove = findAllRelatedHosts(h, state.excludeHosts);

            if (needsConfirm.length > 0) {
                const msg = '“' + h + '” 与以下域名冲突，将被取代：\n\n' +
                    needsConfirm.map(function (x) { return '· ' + x; }).join('\n') +
                    '\n\n确定继续吗？';
                if (!confirm(msg)) {
                    el.whitelistInput.value = '';
                    return;
                }
            }
        }

        const hasRemoval = related.length > 0 || exToRemove.length > 0;

        el.whitelistInput.disabled = true;
        el.whitelistAddBtn.disabled = true;

        if (related.length > 0) markChipsAsRemoving(el.whitelistChips, related);
        if (exToRemove.length > 0) markChipsAsRemoving(el.excludeChips, exToRemove);

        if (related.length > 0) {
            state.whitelistHosts = state.whitelistHosts.filter(function (x) {
                return related.indexOf(x) === -1;
            });
        }
        if (exToRemove.length > 0) {
            state.excludeHosts = state.excludeHosts.filter(function (x) {
                return exToRemove.indexOf(x) === -1;
            });
        }
        if (!wasDuplicate) {
            state.whitelistHosts.push(h);
        }

        try {
            await Promise.all([saveWhitelist(), saveExclude()]);
        } catch (e) {
            el.whitelistInput.disabled = false;
            el.whitelistAddBtn.disabled = false;
            alert('保存失败：' + e.message);
            return;
        }

        const delay = hasRemoval ? 600 : 0;
        setTimeout(function () {
            el.whitelistInput.disabled = false;
            el.whitelistAddBtn.disabled = false;
            el.whitelistInput.value = '';
            flashSaved(wasDuplicate ? '已存在' : '已保存');
            render();
            if (!wasDuplicate) highlightChip(el.whitelistChips, h);
        }, delay);
    }

    async function addExclude() {
        const raw = el.excludeInput.value;
        const h = normalizeHost(raw);
        if (!h) return;
        if (!isValidHost(h)) {
            alert('格式无效：' + raw);
            return;
        }

        const isRegex = isRegexItem(h);

        if (!isRegex && await isHardExcluded(h)) {
            alert('“' + h + '” 在内置排除名单中，无需重复添加。');
            el.excludeInput.value = '';
            return;
        }

        const wasDuplicate = state.excludeHosts.indexOf(h) !== -1;
        let related = [];
        let needsConfirm = [];
        let wlToRemove = [];

        if (!isRegex) {
            related = findAllRelatedHosts(h, state.excludeHosts);
            needsConfirm = related.filter(function (x) { return x !== h; });
            wlToRemove = findAllRelatedHosts(h, state.whitelistHosts);

            if (needsConfirm.length > 0) {
                const msg = '“' + h + '” 与以下域名冲突，将被取代：\n\n' +
                    needsConfirm.map(function (x) { return '· ' + x; }).join('\n') +
                    '\n\n确定继续吗？';
                if (!confirm(msg)) {
                    el.excludeInput.value = '';
                    return;
                }
            }
        }

        const hasRemoval = related.length > 0 || wlToRemove.length > 0;

        el.excludeInput.disabled = true;
        el.excludeAddBtn.disabled = true;

        if (related.length > 0) markChipsAsRemoving(el.excludeChips, related);
        if (wlToRemove.length > 0) markChipsAsRemoving(el.whitelistChips, wlToRemove);

        if (related.length > 0) {
            state.excludeHosts = state.excludeHosts.filter(function (x) {
                return related.indexOf(x) === -1;
            });
        }
        if (wlToRemove.length > 0) {
            state.whitelistHosts = state.whitelistHosts.filter(function (x) {
                return wlToRemove.indexOf(x) === -1;
            });
        }
        if (!wasDuplicate) {
            state.excludeHosts.push(h);
        }

        try {
            await Promise.all([saveExclude(), saveWhitelist()]);
        } catch (e) {
            el.excludeInput.disabled = false;
            el.excludeAddBtn.disabled = false;
            alert('保存失败：' + e.message);
            return;
        }

        const delay = hasRemoval ? 600 : 0;
        setTimeout(function () {
            el.excludeInput.disabled = false;
            el.excludeAddBtn.disabled = false;
            el.excludeInput.value = '';
            flashSaved(wasDuplicate ? '已存在' : '已保存');
            render();
            if (!wasDuplicate) highlightChip(el.excludeChips, h);
        }, delay);
    }

    el.whitelistAddBtn.addEventListener('click', addWhitelist);
    el.whitelistInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addWhitelist();
    });

    el.excludeAddBtn.addEventListener('click', addExclude);
    el.excludeInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addExclude();
    });

    // 导出配置
    el.exportConfigBtn.addEventListener('click', async function () {
        el.exportConfigBtn.disabled = true;
        try {
            const data = await browser.storage.local.get({
                whitelist_mode: false,
                whitelist_hosts: [],
                extra_exclude_hosts: []
            });
            const config = {
                version: 1,
                exportedAt: new Date().toISOString(),
                whitelist_mode: !!data.whitelist_mode,
                whitelist_hosts: Array.isArray(data.whitelist_hosts) ? data.whitelist_hosts : [],
                extra_exclude_hosts: Array.isArray(data.extra_exclude_hosts) ? data.extra_exclude_hosts : []
            };
            const json = JSON.stringify(config, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const now = new Date();
            const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            const filename = 'm3u8-ad-cleaner-config_' +
                now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
                pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '.json';

            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                a.remove();
                try { URL.revokeObjectURL(url); } catch (e) {}
            }, 500);

            flashSaved('已导出');
        } catch (e) {
            alert('导出失败：' + e.message);
        } finally {
            el.exportConfigBtn.disabled = false;
        }
    });

    // 导入配置
    el.importConfigBtn.addEventListener('click', function () {
        el.importFileInput.value = '';
        el.importFileInput.click();
    });

    el.importFileInput.addEventListener('change', function () {
        const file = el.importFileInput.files && el.importFileInput.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async function () {
            let config;
            try {
                config = JSON.parse(reader.result);
            } catch (e) {
                alert('导入失败：JSON 格式错误\n' + e.message);
                return;
            }

            if (!config || typeof config !== 'object') {
                alert('导入失败：配置文件内容无效');
                return;
            }

            const whitelistMode = !!config.whitelist_mode;
            const whitelistHosts = Array.isArray(config.whitelist_hosts)
                ? config.whitelist_hosts.map(h => String(h).trim()).filter(Boolean) : [];
            const excludeHosts = Array.isArray(config.extra_exclude_hosts)
                ? config.extra_exclude_hosts.map(h => String(h).trim()).filter(Boolean) : [];

            const summary =
                '即将导入以下配置，将覆盖当前的名单设置：\n\n' +
                '过滤模式：' + (whitelistMode ? '白名单模式' : '全匹配模式') + '\n' +
                '白名单：' + whitelistHosts.length + ' 项\n' +
                '额外排除：' + excludeHosts.length + ' 项\n\n' +
                '确定导入吗？';

            if (!confirm(summary)) return;

            try {
                await browser.storage.local.set({
                    whitelist_mode: whitelistMode,
                    whitelist_hosts: whitelistHosts,
                    extra_exclude_hosts: excludeHosts
                });
                await load();
                flashSaved('已导入');
            } catch (e) {
                alert('导入失败：' + e.message);
            }
        };
        reader.onerror = function () {
            alert('导入失败：无法读取文件');
        };
        reader.readAsText(file);
    });

    // 重置
    el.resetAllBtn.addEventListener('click', async function () {
        const summary =
            '即将清空以下内容：\n\n' +
            '· 白名单站点列表\n' +
            '· 额外排除站点列表\n' +
            '· 过滤模式恢复为「全匹配」\n\n' +
            '此操作不可撤销，确定重置吗？';

        if (!confirm(summary)) return;

        el.resetAllBtn.disabled = true;
        try {
            await browser.storage.local.set({
                whitelist_mode: false,
                whitelist_hosts: [],
                extra_exclude_hosts: []
            });
            await load();
            flashSaved('已重置');
        } catch (e) {
            alert('重置失败：' + e.message);
        } finally {
            el.resetAllBtn.disabled = false;
        }
    });

    // 外部改动同步
    const debugToggle = document.getElementById('debugToggle');

    (async function initDebug() {
        const data = await browser.storage.local.get({ debug: false });
        debugToggle.checked = !!data.debug;
    })();

    debugToggle.addEventListener('change', async function () {
        await browser.storage.local.set({ debug: debugToggle.checked });
        flashSaved(debugToggle.checked ? '调试已开启' : '调试已关闭');
    });

    browser.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.whitelist_mode) {
            state.whitelistMode = !!changes.whitelist_mode.newValue;
            updateModeText();
        }
        if (changes.whitelist_hosts) {
            state.whitelistHosts = Array.isArray(changes.whitelist_hosts.newValue)
                ? changes.whitelist_hosts.newValue : [];
            render();
        }
        if (changes.extra_exclude_hosts) {
            state.excludeHosts = Array.isArray(changes.extra_exclude_hosts.newValue)
                ? changes.extra_exclude_hosts.newValue : [];
            render();
        }
        if (changes.debug) {
            debugToggle.checked = !!changes.debug.newValue;
        }
    });

    load();

})();