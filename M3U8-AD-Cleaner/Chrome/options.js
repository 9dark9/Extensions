// ============================================================
// M3U8 AD Cleaner - Options (Chrome MV2)
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
        disableHlsChips: document.getElementById('disableHlsChips'),
        disableHlsInput: document.getElementById('disableHlsInput'),
        disableHlsAddBtn: document.getElementById('disableHlsAddBtn'),
        currentModeText: document.getElementById('currentModeText'),
        resetAllBtn: document.getElementById('resetAllBtn'),
        importConfigBtn: document.getElementById('importConfigBtn'),
        exportConfigBtn: document.getElementById('exportConfigBtn'),
        importFileInput: document.getElementById('importFileInput'),
        debugToggle: document.getElementById('debugToggle'),
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

    function normalizeHost(raw) {
        if (!raw) return '';
        let s = String(raw).trim().toLowerCase();
        if (!s) return '';
        s = s.replace(/^[a-z]+:\/\//, '');
        s = s.replace(/[/?#].*$/, '');
        s = s.replace(/:\d+$/, '');
        return s;
    }

    function isValidHost(h) {
        if (!h) return false;
        if (h === 'localhost') return true;
        return /^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$/.test(h);
    }

    function findAllRelatedHosts(target, hostList) {
        if (!target || !hostList || hostList.length === 0) return [];
        const t = target.toLowerCase();
        return hostList.filter(function (x) {
            return x === t || t.endsWith('.' + x) || x.endsWith('.' + t);
        });
    }

    function isHardExcluded(h) {
        return new Promise(function (resolve) {
            try {
                chrome.runtime.sendMessage({ type: 'checkHardExclude', host: h }, function (r) {
                    if (chrome.runtime.lastError) { resolve(false); return; }
                    resolve(!!(r && r.isHardExcluded));
                });
            } catch (e) {
                resolve(false);
            }
        });
    }

    function saveKeys(obj) {
        return new Promise(function (resolve, reject) {
            chrome.storage.local.set(obj, function () {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve();
            });
        });
    }

    const state = {
        whitelistMode: false,
        whitelistHosts: [],
        excludeHosts: [],
        disableHlsHosts: []
    };

    function load(cb) {
        chrome.storage.local.get(
            {
                whitelist_mode: false,
                whitelist_hosts: [],
                extra_exclude_hosts: [],
                disable_hls_hosts: []
            },
            function (data) {
                if (chrome.runtime.lastError) return;
                state.whitelistMode = !!data.whitelist_mode;
                state.whitelistHosts = Array.isArray(data.whitelist_hosts)
                    ? data.whitelist_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
                state.excludeHosts = Array.isArray(data.extra_exclude_hosts)
                    ? data.extra_exclude_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
                state.disableHlsHosts = Array.isArray(data.disable_hls_hosts)
                    ? data.disable_hls_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
                render();
                if (cb) cb();
            }
        );
    }

    function updateModeText() {
        if (el.currentModeText) {
            el.currentModeText.textContent = state.whitelistMode ? '白名单模式' : '全匹配模式';
        }
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
        renderChips(el.whitelistChips, state.whitelistHosts, function (h) {
            state.whitelistHosts = state.whitelistHosts.filter(x => x !== h);
            saveKeys({ whitelist_hosts: state.whitelistHosts }).then(function () {
                flashSaved();
                render();
            });
        });
        renderChips(el.excludeChips, state.excludeHosts, function (h) {
            state.excludeHosts = state.excludeHosts.filter(x => x !== h);
            saveKeys({ extra_exclude_hosts: state.excludeHosts }).then(function () {
                flashSaved();
                render();
            });
        });
        renderChips(el.disableHlsChips, state.disableHlsHosts, function (h) {
            state.disableHlsHosts = state.disableHlsHosts.filter(x => x !== h);
            saveKeys({ disable_hls_hosts: state.disableHlsHosts }).then(function () {
                flashSaved();
                render();
            });
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

    // ============================================================
    // 三个 add 函数
    // ============================================================

    async function addWhitelist() {
        const raw = el.whitelistInput.value;
        const h = normalizeHost(raw);
        if (!h) return;
        if (!isValidHost(h)) { alert('域名格式无效：' + raw); return; }

        if (await isHardExcluded(h)) {
            alert('“' + h + '” 在内置排除名单中，无法加入白名单。');
            el.whitelistInput.value = '';
            return;
        }

        const wasDuplicate = state.whitelistHosts.indexOf(h) !== -1;
        const related = findAllRelatedHosts(h, state.whitelistHosts);
        const needsConfirm = related.filter(function (x) { return x !== h; });

        if (needsConfirm.length > 0) {
            const msg = '“' + h + '” 与以下域名冲突，将被取代：\n\n' +
                needsConfirm.map(function (x) { return '· ' + x; }).join('\n') +
                '\n\n确定继续吗？';
            if (!confirm(msg)) {
                el.whitelistInput.value = '';
                return;
            }
        }

        const exToRemove = findAllRelatedHosts(h, state.excludeHosts);
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
        state.whitelistHosts.push(h);

        try {
            await saveKeys({
                whitelist_hosts: state.whitelistHosts,
                extra_exclude_hosts: state.excludeHosts
            });
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
            flashSaved(wasDuplicate ? '已更新位置' : '已保存');
            render();
            highlightChip(el.whitelistChips, h);
        }, delay);
    }

    async function addExclude() {
        const raw = el.excludeInput.value;
        const h = normalizeHost(raw);
        if (!h) return;
        if (!isValidHost(h)) { alert('域名格式无效：' + raw); return; }

        if (await isHardExcluded(h)) {
            alert('“' + h + '” 在内置排除名单中，无需重复添加。');
            el.excludeInput.value = '';
            return;
        }

        const wasDuplicate = state.excludeHosts.indexOf(h) !== -1;
        const related = findAllRelatedHosts(h, state.excludeHosts);
        const needsConfirm = related.filter(function (x) { return x !== h; });

        if (needsConfirm.length > 0) {
            const msg = '“' + h + '” 与以下域名冲突，将被取代：\n\n' +
                needsConfirm.map(function (x) { return '· ' + x; }).join('\n') +
                '\n\n确定继续吗？';
            if (!confirm(msg)) {
                el.excludeInput.value = '';
                return;
            }
        }

        const wlToRemove = findAllRelatedHosts(h, state.whitelistHosts);
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
        state.excludeHosts.push(h);

        try {
            await saveKeys({
                extra_exclude_hosts: state.excludeHosts,
                whitelist_hosts: state.whitelistHosts
            });
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
            flashSaved(wasDuplicate ? '已更新位置' : '已保存');
            render();
            highlightChip(el.excludeChips, h);
        }, delay);
    }

    async function addDisableHls() {
        const raw = el.disableHlsInput.value;
        const h = normalizeHost(raw);
        if (!h) return;
        if (!isValidHost(h)) { alert('域名格式无效：' + raw); return; }

        const wasDuplicate = state.disableHlsHosts.indexOf(h) !== -1;
        const related = findAllRelatedHosts(h, state.disableHlsHosts);
        const needsConfirm = related.filter(function (x) { return x !== h; });

        if (needsConfirm.length > 0) {
            const msg = '“' + h + '” 与以下域名冲突，将被取代：\n\n' +
                needsConfirm.map(function (x) { return '· ' + x; }).join('\n') +
                '\n\n确定继续吗？';
            if (!confirm(msg)) {
                el.disableHlsInput.value = '';
                return;
            }
        }

        const hasRemoval = related.length > 0;

        el.disableHlsInput.disabled = true;
        el.disableHlsAddBtn.disabled = true;

        if (related.length > 0) markChipsAsRemoving(el.disableHlsChips, related);

        if (related.length > 0) {
            state.disableHlsHosts = state.disableHlsHosts.filter(function (x) {
                return related.indexOf(x) === -1;
            });
        }
        state.disableHlsHosts.push(h);

        try {
            await saveKeys({ disable_hls_hosts: state.disableHlsHosts });
        } catch (e) {
            el.disableHlsInput.disabled = false;
            el.disableHlsAddBtn.disabled = false;
            alert('保存失败：' + e.message);
            return;
        }

        const delay = hasRemoval ? 600 : 0;
        setTimeout(function () {
            el.disableHlsInput.disabled = false;
            el.disableHlsAddBtn.disabled = false;
            el.disableHlsInput.value = '';
            flashSaved(wasDuplicate ? '已更新位置' : '已保存');
            render();
            highlightChip(el.disableHlsChips, h);
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

    el.disableHlsAddBtn.addEventListener('click', addDisableHls);
    el.disableHlsInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addDisableHls();
    });

    // ============================================================
    // 导出配置
    // ============================================================
    el.exportConfigBtn.addEventListener('click', function () {
        el.exportConfigBtn.disabled = true;
        chrome.storage.local.get(
            {
                whitelist_mode: false,
                whitelist_hosts: [],
                extra_exclude_hosts: [],
                disable_hls_hosts: []
            },
            function (data) {
                if (chrome.runtime.lastError) {
                    alert('导出失败：' + chrome.runtime.lastError.message);
                    el.exportConfigBtn.disabled = false;
                    return;
                }
                const config = {
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    whitelist_mode: !!data.whitelist_mode,
                    whitelist_hosts: Array.isArray(data.whitelist_hosts) ? data.whitelist_hosts : [],
                    extra_exclude_hosts: Array.isArray(data.extra_exclude_hosts) ? data.extra_exclude_hosts : [],
                    disable_hls_hosts: Array.isArray(data.disable_hls_hosts) ? data.disable_hls_hosts : []
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

                el.exportConfigBtn.disabled = false;
                flashSaved('已导出');
            }
        );
    });

    // ============================================================
    // 导入配置
    // ============================================================
    el.importConfigBtn.addEventListener('click', function () {
        el.importFileInput.value = '';
        el.importFileInput.click();
    });

    el.importFileInput.addEventListener('change', function () {
        const file = el.importFileInput.files && el.importFileInput.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function () {
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
                ? config.whitelist_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
            const excludeHosts = Array.isArray(config.extra_exclude_hosts)
                ? config.extra_exclude_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];
            const disableHlsHosts = Array.isArray(config.disable_hls_hosts)
                ? config.disable_hls_hosts.map(h => String(h).toLowerCase()).filter(Boolean) : [];

            const hasHlsField = ('disable_hls_hosts' in config);

            const summaryLines = [
                '即将导入以下配置，将覆盖当前的名单设置：',
                '',
                '过滤模式：' + (whitelistMode ? '白名单模式' : '全匹配模式'),
                '白名单：' + whitelistHosts.length + ' 项',
                '额外排除：' + excludeHosts.length + ' 项'
            ];
            if (hasHlsField) {
                summaryLines.push('禁用原生 HLS：' + disableHlsHosts.length + ' 项');
            } else {
                summaryLines.push('禁用原生 HLS：（文件中无此字段，保留当前设置）');
            }
            summaryLines.push('', '确定导入吗？');

            if (!confirm(summaryLines.join('\n'))) return;

            const toSave = {
                whitelist_mode: whitelistMode,
                whitelist_hosts: whitelistHosts,
                extra_exclude_hosts: excludeHosts
            };

            if (hasHlsField) {
                toSave.disable_hls_hosts = disableHlsHosts;
            }

            chrome.storage.local.set(toSave, function () {
                if (chrome.runtime.lastError) {
                    alert('导入失败：' + chrome.runtime.lastError.message);
                    return;
                }
                load();
                flashSaved('已导入');
            });
        };
        reader.onerror = function () {
            alert('导入失败：无法读取文件');
        };
        reader.readAsText(file);
    });

    // ============================================================
    // 重置所有名单
    // ============================================================
    el.resetAllBtn.addEventListener('click', function () {
        const summary =
            '即将清空以下内容：\n\n' +
            '· 白名单站点列表\n' +
            '· 额外排除站点列表\n' +
            '· 禁用原生 HLS 的站点列表\n' +
            '· 过滤模式恢复为「全匹配」\n\n' +
            '此操作不可撤销，确定重置吗？';

        if (!confirm(summary)) return;

        el.resetAllBtn.disabled = true;
        chrome.storage.local.set({
            whitelist_mode: false,
            whitelist_hosts: [],
            extra_exclude_hosts: [],
            disable_hls_hosts: []
        }, function () {
            el.resetAllBtn.disabled = false;
            if (chrome.runtime.lastError) {
                alert('重置失败：' + chrome.runtime.lastError.message);
                return;
            }
            load();
            flashSaved('已重置');
        });
    });

    // ============================================================
    // 外部改动同步
    // ============================================================
    chrome.storage.onChanged.addListener(function (changes, area) {
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
        if (changes.disable_hls_hosts) {
            state.disableHlsHosts = Array.isArray(changes.disable_hls_hosts.newValue)
                ? changes.disable_hls_hosts.newValue : [];
            render();
        }
        if (changes.debug) {
            el.debugToggle.checked = !!changes.debug.newValue;
        }
    });

    // ============================================================
    // 调试开关
    // ============================================================
    chrome.storage.local.get({ debug: false }, function (data) {
        el.debugToggle.checked = !!data.debug;
    });

    el.debugToggle.addEventListener('change', function () {
        chrome.storage.local.set({ debug: el.debugToggle.checked }, function () {
            if (chrome.runtime.lastError) return;
            flashSaved(el.debugToggle.checked ? '调试已开启' : '调试已关闭');
        });
    });

    load();

})();