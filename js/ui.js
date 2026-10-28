/* L5 界面层 | ui：DOM 面板与交互
 * 允许依赖：core、MV.app（回调）
 * 禁止依赖：GL 细节、算法实现
 * 导出：MV.ui（树 / 属性 / 视图设置 / 弹窗 / 拖放）
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    /* ==================== 界面（原 ui.js） ==================== */

    var app = null;

    var SLOT_INFO = {
        A: { title: '左侧', badge: 'A' },
        B: { title: '右侧', badge: 'B' },
        S: { title: '公共', badge: 'S' }
    };

    var collapsed = { A: false, B: false, S: false };

    function $(id)
    {
        return document.getElementById(id);
    }

    function hexToRgb(hex)
    {
        var s = hex.replace('#', '');
        if (s.length === 3)
        {
            s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
        }
        var v = parseInt(s, 16);
        return [
            ((v >> 16) & 255) / 255,
            ((v >> 8) & 255) / 255,
            (v & 255) / 255
        ];
    }

    function rgbToHex(rgb)
    {
        var out = '#';
        for (var i = 0; i < 3; i++)
        {
            var v = Math.max(0, Math.min(255, Math.round(rgb[i] * 255)));
            out += (v < 16 ? '0' : '') + v.toString(16);
        }
        return out;
    }

    function fmtNum(v)
    {
        var a = Math.abs(v);
        if (a === 0) { return '0'; }
        if (a >= 10000 || a < 0.001) { return v.toExponential(2); }
        if (a >= 100) { return v.toFixed(1); }
        return v.toFixed(3);
    }

    function formatBytes(n)
    {
        if (!(n > 0))
        {
            return '0 B';
        }
        var u = ['B', 'KB', 'MB', 'GB'];
        var i = 0;
        while (n >= 1024 && i < u.length - 1)
        {
            n /= 1024;
            i++;
        }
        return n.toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
    }

    function fmtTime(ms)
    {
        if (!ms)
        {
            return '-';
        }
        var d = new Date(ms);
        var p = function (v) { return (v < 10 ? '0' : '') + v; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
            p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function slotLabel(slot)
    {
        if (slot === 'A') { return '左侧 (A)'; }
        if (slot === 'B') { return '右侧 (B)'; }
        return '公共图层 (S)';
    }

    /* 场景树节点的悬停提示：文件来源、大小、修改时间、归属等 */
    function layerTooltip(layer)
    {
        var d = layer.data || {};
        var lines = [];

        lines.push('名称：' + layer.name);
        lines.push('类型：' + (d.format || (layer.kind === 'mesh' ? 'MESH' : 'POINTS')));

        if (layer.kind === 'mesh')
        {
            var tri = d.positions ? Math.floor(d.positions.length / 9) : (d.count || 0);
            lines.push('面数：' + formatCount(tri) + ' 三角形');
        }
        else
        {
            lines.push('点数：' + formatCount(d.count || 0));
        }

        if (layer.sourceFile)
        {
            lines.push('文件：' + layer.sourceFile.name);
            lines.push('大小：' + formatBytes(layer.sourceFile.size));
            if (layer.sourceFile.lastModified)
            {
                lines.push('修改时间：' + fmtTime(layer.sourceFile.lastModified));
            }
        }

        if (layer.absPath)
        {
            lines.push('路径：' + layer.absPath);
        }
        else if (layer.sourceUrl)
        {
            lines.push('来源：' + layer.sourceUrl);
        }
        else
        {
            lines.push('路径：（未解析）浏览器不向网页暴露本地绝对路径；' +
                '把文件放在 HoleOptimize\\data 下，' +
                '或用环境变量 HOLEOPT_SEARCH 指定额外搜索目录后重启 serve.bat');
        }

        lines.push('归属：' + slotLabel(layer.slot) + (layer.visible ? ' · 显示中' : ' · 已隐藏'));

        if (layer.isResult)
        {
            lines.push('说明：孔位优化产物');
        }
        return lines.join('\n');
    }

    function formatCount(n)
    {
        if (n >= 1e6)
        {
            return (n / 1e6).toFixed(2) + 'M';
        }
        if (n >= 1e3)
        {
            return (n / 1e3).toFixed(1) + 'k';
        }
        return String(n);
    }

    function el(tag, cls, text)
    {
        var e = document.createElement(tag);
        if (cls)
        {
            e.className = cls;
        }
        if (text !== undefined)
        {
            e.textContent = text;
        }
        return e;
    }


    /* ---------------- 场景树右键菜单 ---------------- */
    function hideCtxMenu()
    {
        var m = $('ctx-menu');
        if (m)
        {
            m.classList.add('hidden');
        }
    }

    function ctxItem(menu, text, fn)
    {
        var b = document.createElement('button');
        b.className = 'ctx-item';
        b.textContent = text;
        b.addEventListener('click', function (ev)
        {
            ev.stopPropagation();
            hideCtxMenu();
            fn();
        });
        menu.appendChild(b);
    }

    function showCtxMenu(x, y, layer)
    {
        var menu = $('ctx-menu');
        if (!menu)
        {
            return;
        }
        menu.innerHTML = '';

        var head = document.createElement('div');
        head.className = 'ctx-head';
        head.textContent = layer.name;
        menu.appendChild(head);

        var targets = layer.slot === 'A' ? ['B'] : (layer.slot === 'B' ? ['A'] : ['A', 'B']);
        targets.forEach(function (slot)
        {
            var label = slot === 'A' ? '左侧 (A)' : '右侧 (B)';
            ctxItem(menu, '移动到 ' + label, function ()
            {
                app.moveLayerToSlot(layer.id, slot);
            });
        });

        var sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);

        targets.forEach(function (slot)
        {
            var label = slot === 'A' ? '左侧 (A)' : '右侧 (B)';
            ctxItem(menu, '拷贝到 ' + label, function ()
            {
                app.copyLayerToSlot(layer.id, slot);
            });
        });

        menu.classList.remove('hidden');
        var w = menu.offsetWidth || 160;
        var h = menu.offsetHeight || 96;
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';
    }

    /* ---------------- 场景树 ---------------- */
    function renderTree()
    {
        if (!app)
        {
            return;
        }
        var root = $('tree');
        root.innerHTML = '';

        var total = app.layers.length;

        ['A', 'B', 'S'].forEach(function (slot)
        {
            var list = app.layers.filter(function (l) { return l.slot === slot; });
            var info = SLOT_INFO[slot];

            var header = el('div', 'tree-group-header slot-' + slot);
            var caret = el('span', 'caret', collapsed[slot] ? '\u25B8' : '\u25BE');
            var badge = el('span', 'slot-badge', info.badge);
            var title = el('span', '', info.title);
            var cnt = el('span', 'gcount', list.length + ' 层');
            header.appendChild(caret);
            header.appendChild(badge);
            header.appendChild(title);
            header.appendChild(cnt);

            header.addEventListener('click', function ()
            {
                collapsed[slot] = !collapsed[slot];
                renderTree();
            });

            root.appendChild(header);

            var children = el('div', 'tree-children' + (collapsed[slot] ? ' collapsed' : ''));
            if (list.length === 0)
            {
                children.appendChild(el('div', 'tree-empty', '空 — 按钮载入或拖放文件'));
            }

            var visibleGroup = list.length > 0;
            var allVisible = list.every(function (l) { return l.visible; });

            if (visibleGroup)
            {
                var groupToggle = el('div', 'tree-item');
                var chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.checked = allVisible;
                chk.addEventListener('change', function (ev)
                {
                    ev.stopPropagation();
                    var now = Date.now();
                    list.forEach(function (l)
                    {
                        l.visible = chk.checked;
                        if (chk.checked)
                        {
                            l.shownAt = now;
                        }
                    });
                    app.markDirty();
                    renderTree();
                });
                chk.addEventListener('click', function (ev) { ev.stopPropagation(); });
                groupToggle.appendChild(chk);
                groupToggle.appendChild(el('span', 'lname', '全选 / 全不选'));
                children.appendChild(groupToggle);
            }

            // 父子层级：parentId 指向本组内图层时，作为其子项缩进显示
            var ids = {};
            var byParent = {};
            var roots = [];
            list.forEach(function (l) { ids[l.id] = true; });
            list.forEach(function (l)
            {
                if (l.parentId && ids[l.parentId])
                {
                    if (!byParent[l.parentId]) { byParent[l.parentId] = []; }
                    byParent[l.parentId].push(l);
                }
                else
                {
                    roots.push(l);
                }
            });

            function emitRow(layer, depth)
            {
                var row = el('div', 'tree-item' + (layer.id === app.selectedId ? ' selected' : ''));
                if (depth > 0)
                {
                    row.classList.add('child');
                    row.style.paddingLeft = (10 + depth * 14) + 'px';
                }

                var chk2 = document.createElement('input');
                chk2.type = 'checkbox';
                chk2.checked = layer.visible;
                chk2.addEventListener('click', function (ev) { ev.stopPropagation(); });
                chk2.addEventListener('change', function ()
                {
                    layer.visible = chk2.checked;
                    if (chk2.checked)
                    {
                        layer.shownAt = Date.now();   // 记为“最新启用”，孔位优化优先用它
                    }
                    app.markDirty();
                });

                var dot = el('span', 'dot');
                dot.style.background = layer.color;

                var tip = layerTooltip(layer);
                var name = el('span', 'lname', layer.name);
                name.title = tip;
                row.title = tip;

                var meta = el('span', 'lmeta',
                    layer.kind === 'mesh' ? formatCount(layer.data.count) + ' tri' :
                        formatCount(layer.data.count) + ' pts');

                var del = el('button', 'del', '\u00D7');
                del.title = layer.parentId ? '删除该结果图层' : '删除图层（连同其下的结果）';
                del.addEventListener('click', function (ev)
                {
                    ev.stopPropagation();
                    app.removeLayer(layer.id);
                });

                row.appendChild(chk2);
                row.appendChild(dot);
                row.appendChild(name);
                row.appendChild(meta);
                row.appendChild(del);

                row.addEventListener('click', function ()
                {
                    app.selectLayer(layer.id);
                });
                row.addEventListener('dblclick', function ()
                {
                    app.focusLayer(layer.id);
                });
                row.addEventListener('contextmenu', function (ev)
                {
                    ev.preventDefault();
                    ev.stopPropagation();
                    showCtxMenu(ev.clientX, ev.clientY, layer);
                });

                children.appendChild(row);

                var kids = byParent[layer.id];
                if (kids)
                {
                    kids.forEach(function (k) { emitRow(k, depth + 1); });
                }
            }

            roots.forEach(function (l) { emitRow(l, 0); });

            root.appendChild(children);
        });

        if (total === 0)
        {
            var tip = el('div', 'tree-empty',
                '尚无图层。使用顶部「载入」按钮，或把文件拖进窗口。');
            root.appendChild(tip);
        }
    }

    /* ---------------- 属性面板 ---------------- */
    function renderProps()
    {
        if (!app)
        {
            return;
        }
        var layer = app.getSelected();
        var rows = document.querySelectorAll('#props .prop-row');
        var hint = document.querySelector('#props .empty-hint');

        if (!layer)
        {
            hint.style.display = '';
            rows.forEach(function (r) { r.classList.remove('show'); });
            Array.prototype.forEach.call(document.querySelectorAll('#props .prop-group'), function (g)
            {
                g.classList.add('empty');
            });
            return;
        }

        hint.style.display = 'none';

        rows.forEach(function (r)
        {
            var kind = r.getAttribute('data-prop');
            var show = (kind === 'base') ||
                       (kind === 'mesh' && layer.kind === 'mesh') ||
                       (kind === 'points' && layer.kind === 'points');
            r.classList.toggle('show', !!show);
        });

        $('p-name').value = layer.name;
        $('p-slot').value = layer.slot;
        $('p-color-k').textContent = layer.kind === 'mesh' ? '面片颜色' : '点颜色';
        $('p-color').value = layer.color;
        if ($('btn-colors-dot'))
        {
            $('btn-colors-dot').style.background = layer.color;
        }
        $('p-backcolor').value = rgbToHex(layer.backColorRgb || [0.69, 0.23, 0.19]);
        $('p-wirecolor').value = rgbToHex(layer.wireColorRgb || [0.20, 0.62, 0.95]);
        $('p-vertcolor').value = rgbToHex(layer.vertColorRgb || [0.95, 0.95, 0.98]);
        $('p-boundarycolor').value = rgbToHex(layer.boundaryColorRgb || [1.0, 0.82, 0.29]);
        $('p-opacity').value = layer.opacity;
        $('p-opacity-val').textContent = layer.opacity.toFixed(2);

        $('p-pointsize').value = layer.pointSize;
        $('p-pointsize-val').textContent = String(layer.pointSize);

        var pcm = layer.pointColorMode;
        if (pcm === 2 && !layer.data.normals) { pcm = 0; }
        if (pcm === 3 && !layer.data.tags) { pcm = 0; }
        if (pcm === 4 && !layer.data.colors) { pcm = 0; }
        if (pcm === 5 && !(layer.data.scalars && layer.data.scalars.length)) { pcm = 0; }
        $('p-pointcolor').value = String(pcm);

        // 标量场列表（CloudCompare 的 Scalar field）
        var sfs = layer.data.scalars || [];
        var sfSel = $('p-sf');
        sfSel.innerHTML = '';
        for (var sfi = 0; sfi < sfs.length; sfi++)
        {
            var opt = document.createElement('option');
            opt.value = String(sfi);
            opt.textContent = sfs[sfi].name + ' [' + fmtNum(sfs[sfi].min) + ' ~ ' + fmtNum(sfs[sfi].max) + ']';
            sfSel.appendChild(opt);
        }
        if (sfs.length > 0)
        {
            var si0 = Math.min(layer.sfIndex || 0, sfs.length - 1);
            sfSel.value = String(si0);
            $('p-sfmin').value = (layer.sfMin === null || layer.sfMin === undefined) ? '' : String(layer.sfMin);
            $('p-sfmax').value = (layer.sfMax === null || layer.sfMax === undefined) ? '' : String(layer.sfMax);
            $('p-sfmin').placeholder = fmtNum(sfs[si0].min);
            $('p-sfmax').placeholder = fmtNum(sfs[si0].max);
            $('p-sframp').value = String(layer.sfRamp || 0);
        }

        var hasSF = layer.kind === 'points' && sfs.length > 0;
        var showSF = hasSF && pcm === 5;
        $('row-sf').classList.toggle('show', hasSF);
        $('row-sfrange').classList.toggle('show', showSF);
        $('row-sframp').classList.toggle('show', showSF);
        $('row-sfhist').classList.toggle('show', showSF);

        if (showSF)
        {
            var sfPick = sfs[Math.min(layer.sfIndex || 0, sfs.length - 1)];
            var loV = (typeof layer.sfMin === 'number' && isFinite(layer.sfMin)) ? layer.sfMin : sfPick.min;
            var hiV = (typeof layer.sfMax === 'number' && isFinite(layer.sfMax)) ? layer.sfMax : sfPick.max;
            drawHist($('p-sfhist'), sfPick, loV, hiV, layer.sfRamp | 0);
        }

        // 组内所有行都隐藏时，整组（含标题）隐藏
        Array.prototype.forEach.call(document.querySelectorAll('#props .prop-group'), function (g)
        {
            g.classList.toggle('empty', !g.querySelector('.prop-row.show'));
        });

        updateColorBar();

        $('p-shade').value = String(layer.shadeMode);
        $('p-faces').checked = !!layer.showFaces;
        $('p-wire').checked = !!layer.showWire;
        $('p-verts').checked = !!layer.showVerts;
        $('p-boundary').checked = !!layer.showBoundary;
        $('p-vsize').value = layer.pointSize;
        $('p-vsize-val').textContent = String(layer.pointSize);
        $('p-normals').checked = !!layer.showNormals;
        $('p-normallen').value = layer.normalLen;
        $('p-normallen-val').textContent = Number(layer.normalLen).toFixed(1);

        var d = layer.data;
        var txt;
        if (layer.kind === 'mesh')
        {
            txt = d.format + ' · ' + formatCount(d.count) + ' 三角形';
        }
        else
        {
            txt = d.format + ' · ' + formatCount(d.count) + ' 点';
        }
        if (d.note)
        {
            txt += ' · ' + d.note;
        }
        if (layer.kind === 'mesh' && layer.gpu && typeof layer.gpu.boundaryEdges === 'number')
        {
            txt += ' · 边界 ' + formatCount(layer.gpu.boundaryEdges) + ' 边';
        }
        $('p-stat').textContent = txt;

        var pathText = layer.absPath || layer.sourceUrl ||
            '（未解析：浏览器不暴露本地路径；放入 data 目录或用 HOLEOPT_SEARCH 指定搜索根）';
        $('p-path').textContent = pathText;
        $('p-path').title = pathText;
    }

    /* ---------------- 进度 / 状态 ---------------- */
    function setProgress(visible, text, frac)
    {
        var box = $('progress');
        box.classList.toggle('hidden', !visible);
        if (text !== undefined && text !== null)
        {
            $('pg-text').textContent = text;
        }
        if (frac !== undefined && frac !== null)
        {
            $('pg-fill').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
        }
    }

    function setInfo(text)
    {
        $('st-info').textContent = text;
    }

    function setStats(fps, layerCount, triangles, points)
    {
        $('st-fps').textContent = fps + ' fps';
        $('st-count').textContent = layerCount + ' 图层 · ' +
            formatCount(triangles) + ' tri · ' + formatCount(points) + ' pts';
    }

    /* ---------------- 二次确认 ---------------- */
    var confirmCb = null;

    function showConfirm(text, onOk)
    {
        confirmCb = onOk || null;
        $('modal-text').textContent = text;
        $('modal').classList.remove('hidden');
    }

    function hideConfirm()
    {
        $('modal').classList.add('hidden');
        confirmCb = null;
    }

    /* ---------------- 点云列含义确认 ---------------- */
    var COL_OPTIONS = [
        ['nx', '法向 X'],
        ['ny', '法向 Y'],
        ['nz', '法向 Z'],
        ['r', '颜色 R'],
        ['g', '颜色 G'],
        ['b', '颜色 B'],
        ['tag', '标签 / ID'],
        ['sf', '标量场'],
        ['skip', '忽略']
    ];

    var RAMPS = [
        {
            name: 'Jet',
            css: 'linear-gradient(90deg, rgb(38,77,242) 0%, rgb(26,217,230) 25%, ' +
                'rgb(64,230,89) 50%, rgb(255,217,38) 75%, rgb(250,56,46) 100%)'
        },
        {
            name: 'BGR',
            css: 'linear-gradient(90deg, rgb(41,87,230) 0%, rgb(41,199,112) 50%, rgb(230,56,46) 100%)'
        },
        {
            name: 'Gray',
            css: 'linear-gradient(90deg, rgb(20,20,20) 0%, rgb(240,240,240) 100%)'
        },
        {
            name: 'BWR',
            css: 'linear-gradient(90deg, rgb(36,92,224) 0%, rgb(245,245,245) 50%, rgb(219,51,46) 100%)'
        }
    ];

    // 与着色器 ramp 一致的色标采样点（用于直方图柱色）
    var RAMP_STOPS = [
        [[38, 77, 242], [26, 217, 230], [64, 230, 89], [255, 217, 38], [250, 56, 46]],
        [[41, 87, 230], [41, 199, 112], [230, 56, 46]],
        [[20, 20, 20], [240, 240, 240]],
        [[36, 92, 224], [245, 245, 245], [219, 51, 46]]
    ];

    var HIST_BINS = 48;

    function histBins(sf)
    {
        if (sf.histBins)
        {
            return sf.histBins;
        }
        var vals = sf.values;
        var n = vals.length;
        var step = Math.max(1, Math.ceil(n / 200000));
        var bins = new Float32Array(HIST_BINS);
        var lo = sf.min;
        var span = (sf.max - sf.min) || 1;

        for (var i = 0; i < n; i += step)
        {
            var b = Math.floor((vals[i] - lo) / span * HIST_BINS);
            if (b < 0) { b = 0; }
            if (b >= HIST_BINS) { b = HIST_BINS - 1; }
            bins[b]++;
        }

        sf.histBins = bins;
        return bins;
    }

    function rampColorAt(rampIdx, t)
    {
        var stops = RAMP_STOPS[rampIdx] || RAMP_STOPS[0];
        var x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
        var i = Math.min(stops.length - 2, Math.floor(x));
        var f = x - i;
        var a = stops[i];
        var b = stops[i + 1];
        return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' +
            Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
            Math.round(a[2] + (b[2] - a[2]) * f) + ')';
    }

    /* 标量场分布直方图 + 当前显示范围标记 */
    function drawHist(cv, sf, lo, hi, ramp)
    {
        if (!cv || !sf)
        {
            return;
        }
        var g = cv.getContext('2d');
        var W = cv.width;
        var H = cv.height;
        g.clearRect(0, 0, W, H);

        var bins = histBins(sf);
        var maxC = 0;
        for (var i = 0; i < bins.length; i++)
        {
            if (bins[i] > maxC) { maxC = bins[i]; }
        }
        if (!(maxC > 0))
        {
            return;
        }

        var bw = W / bins.length;
        for (var b = 0; b < bins.length; b++)
        {
            var h = Math.sqrt(bins[b] / maxC) * (H - 2);
            g.fillStyle = rampColorAt(ramp, (b + 0.5) / bins.length);
            g.fillRect(b * bw, H - h, Math.max(1, bw - 1), h);
        }

        var dspan = (sf.max - sf.min) || 1;
        var x0 = Math.max(0, Math.min(W, (lo - sf.min) / dspan * W));
        var x1 = Math.max(0, Math.min(W, (hi - sf.min) / dspan * W));
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(x0, 0, Math.max(0, x1 - x0), H);
        g.strokeStyle = 'rgba(255,255,255,0.45)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x0 + 0.5, 0);
        g.lineTo(x0 + 0.5, H);
        g.moveTo(x1 - 0.5, 0);
        g.lineTo(x1 - 0.5, H);
        g.stroke();
    }

    var colResolve = null;
    var colState = null;

    function normKey(s)
    {
        return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function defaultLabels(info)
    {
        var w = info.width;
        var names = info.names || [];
        var labels = [];
        var i;

        for (i = 0; i < w; i++)
        {
            labels.push('sf');
        }
        labels[0] = 'x';
        if (w > 1) { labels[1] = 'y'; }
        if (w > 2) { labels[2] = 'z'; }

        var k3 = names[3] ? normKey(names[3]) : '';
        var k4 = names[4] ? normKey(names[4]) : '';
        var k5 = names[5] ? normKey(names[5]) : '';
        var isRGB = (k3 === 'r' || k3 === 'red') && (k4 === 'g' || k4 === 'green') &&
            (k5 === 'b' || k5 === 'blue');

        if (w >= 6 && isRGB)
        {
            labels[3] = 'r';
            labels[4] = 'g';
            labels[5] = 'b';
        }
        else if (w >= 6)
        {
            // 数值优先：第 4~6 列是单位向量（平方和 ≈ 1）→ 默认按法向导入
            // 仅是默认值，弹窗里每列都能改（x/y/z/nx/ny/nz/r/g/b/tag/sf）
            var sm = info.sample || [];
            var ux = Number(sm[3]), uy = Number(sm[4]), uz = Number(sm[5]);
            var len = Math.sqrt(ux * ux + uy * uy + uz * uz);
            var unitVec = isFinite(len) && len > 0 && Math.abs(len - 1) <= 0.03;

            if (unitVec || w > 6)
            {
                labels[3] = 'nx';
                labels[4] = 'ny';
                labels[5] = 'nz';
            }
        }

        for (i = 3; i < w; i++)
        {
            if (labels[i] !== 'sf' || !names[i])
            {
                continue;
            }
            var k = normKey(names[i]);
            if (k === 'label' || k === 'id' || k === 'tag' || k === 'class' ||
                k === 'hid' || k === 'index')
            {
                labels[i] = 'tag';
            }
        }
        return labels;
    }

    function renderColRows()
    {
        var info = colState.info;
        var names = info.names || [];
        var box = $('col-rows');
        box.innerHTML = '';
        $('col-info').textContent = '共 ' + info.width +
            ' 列：前三列固定为 X / Y / Z，其余列请确认含义（可设多个标量场）';

        for (var i = 0; i < info.width; i++)
        {
            var row = document.createElement('div');
            row.className = 'col-row' + (i < 3 ? ' fixed' : '');

            var idx = document.createElement('span');
            idx.className = 'col-idx';
            idx.textContent = String(i + 1);

            var name = document.createElement('span');
            name.className = 'col-name';
            var sample = info.sample && info.sample[i] !== undefined ? String(info.sample[i]) : '';
            name.textContent = (names[i] || ('列 ' + (i + 1))) + (sample ? '   ( ' + sample + ' )' : '');
            name.title = name.textContent;

            var sel = document.createElement('select');
            sel.className = 'col-sel';
            sel.setAttribute('data-col', String(i));

            if (i < 3)
            {
                var fixed = document.createElement('option');
                fixed.value = 'xyz';
                fixed.textContent = (i === 0 ? '坐标 X' : (i === 1 ? '坐标 Y' : '坐标 Z'));
                sel.appendChild(fixed);
            }
            else
            {
                for (var oi = 0; oi < COL_OPTIONS.length; oi++)
                {
                    var op = document.createElement('option');
                    op.value = COL_OPTIONS[oi][0];
                    op.textContent = COL_OPTIONS[oi][1];
                    sel.appendChild(op);
                }
                sel.value = colState.labels[i] || 'sf';
                sel.addEventListener('change', function ()
                {
                    var ci = parseInt(this.getAttribute('data-col'), 10);
                    colState.labels[ci] = this.value;
                });
            }

            row.appendChild(idx);
            row.appendChild(name);
            row.appendChild(sel);
            box.appendChild(row);
        }
    }

    function validateLabels()
    {
        var labels = colState.labels;
        var count = function (k)
        {
            var c = 0;
            for (var i = 0; i < labels.length; i++)
            {
                if (labels[i] === k) { c++; }
            }
            return c;
        };

        var nPart = count('nx') + count('ny') + count('nz');
        if (nPart > 0 && nPart < 3)
        {
            return '法向需要同时指定 X / Y / Z 三列';
        }

        var cPart = count('r') + count('g') + count('b');
        if (cPart > 0 && cPart < 3)
        {
            return '颜色需要同时指定 R / G / B 三列';
        }

        var keys = ['nx', 'ny', 'nz', 'r', 'g', 'b', 'tag'];
        for (var ki = 0; ki < keys.length; ki++)
        {
            if (count(keys[ki]) > 1)
            {
                return '同一含义只能指定一次（' + keys[ki] + '）';
            }
        }
        return '';
    }

    function planFromLabels(labels, names)
    {
        names = names || [];
        var plan = { x: 0, y: 1, z: 2, normal: null, color: null, tag: -1, sf: [] };
        var nx = -1, ny = -1, nz = -1, cr = -1, cg = -1, cb = -1;
        var seq = 0;

        for (var i = 0; i < labels.length; i++)
        {
            var L = labels[i];
            if (L === 'nx') { nx = i; }
            else if (L === 'ny') { ny = i; }
            else if (L === 'nz') { nz = i; }
            else if (L === 'r') { cr = i; }
            else if (L === 'g') { cg = i; }
            else if (L === 'b') { cb = i; }
            else if (L === 'tag') { plan.tag = i; }
            else if (L === 'sf')
            {
                seq++;
                plan.sf.push({ i: i, name: names[i] ? names[i] : ('SF' + seq) });
            }
        }

        if (nx >= 0 && ny >= 0 && nz >= 0)
        {
            plan.normal = [nx, ny, nz];
        }
        if (cr >= 0 && cg >= 0 && cb >= 0)
        {
            plan.color = [cr, cg, cb];
        }
        return plan;
    }

    function autoColumnPlan(info)
    {
        return planFromLabels(defaultLabels(info), info.names || []);
    }

    function showColumnDialog(info)
    {
        return new Promise(function (resolve)
        {
            colResolve = resolve;
            colState = { info: info, labels: defaultLabels(info) };
            $('col-err').textContent = '';
            renderColRows();
            $('coldlg').classList.remove('hidden');
        });
    }

    /* ---------------- 标量场色条 ---------------- */
    function updateColorBar()
    {
        var bar = $('sfbar');
        if (!bar)
        {
            return;
        }

        var l = app ? app.getSelected() : null;
        if (!l || l.kind !== 'points' || !l.data.scalars || l.data.scalars.length === 0 ||
            (l.pointColorMode | 0) !== 5)
        {
            bar.classList.add('hidden');
            return;
        }

        var si = Math.min(l.sfIndex || 0, l.data.scalars.length - 1);
        var sf = l.data.scalars[si];
        var ramp = RAMPS[l.sfRamp | 0] || RAMPS[0];
        var mn = (typeof l.sfMin === 'number' && isFinite(l.sfMin)) ? l.sfMin : sf.min;
        var mx = (typeof l.sfMax === 'number' && isFinite(l.sfMax)) ? l.sfMax : sf.max;

        $('sf-name').textContent = sf.name;
        $('sf-ramp').style.background = ramp.css;
        $('sf-min').textContent = fmtNum(mn);
        $('sf-max').textContent = fmtNum(mx);
        drawHist($('sf-hist'), sf, mn, mx, l.sfRamp | 0);
        bar.classList.remove('hidden');
    }

    /* 应用用户输入的标量场范围（留空 = 自动） */
    function applySfRange()
    {
        var l = app ? app.getSelected() : null;
        if (!l || !l.data.scalars || l.data.scalars.length === 0)
        {
            return;
        }

        var si = Math.min(l.sfIndex || 0, l.data.scalars.length - 1);
        var sf = l.data.scalars[si];
        var tmin = $('p-sfmin').value.trim();
        var tmax = $('p-sfmax').value.trim();
        var mn = tmin === '' ? null : parseFloat(tmin);
        var mx = tmax === '' ? null : parseFloat(tmax);

        if (mn !== null && !isFinite(mn))
        {
            setInfo('标量场最小值无效');
            return;
        }
        if (mx !== null && !isFinite(mx))
        {
            setInfo('标量场最大值无效');
            return;
        }

        var a = (mn === null) ? sf.min : mn;
        var b = (mx === null) ? sf.max : mx;
        if (!(b > a))
        {
            setInfo('标量场范围无效：最大值必须大于最小值');
            return;
        }

        l.sfMin = mn;
        l.sfMax = mx;
        updateColorBar();
        app.markDirty();
    }

    /* ---------------- 拾取信息面板 ---------------- */
    function vecLen(a, b)
    {
        var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /* 顶点 b 处的夹角（度） */
    function angleAt(a, b, c)
    {
        var v1 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        var v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        var l1 = Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]);
        var l2 = Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2]);
        if (!(l1 > 1e-12 && l2 > 1e-12))
        {
            return 0;
        }
        var d = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (l1 * l2);
        return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
    }

    function renderPickBar(points, active)
    {
        var bar = $('pickbar');
        if (!bar)
        {
            return;
        }
        points = points || [];

        var btn = $('btn-pick');
        if (btn)
        {
            btn.classList.toggle('active', !!active);
        }
        bar.classList.toggle('hidden', !active && points.length === 0);

        var list = $('pick-list');
        list.innerHTML = '';

        for (var i = 0; i < points.length; i++)
        {
            var h = points[i];
            var row = document.createElement('div');
            row.className = 'pick-row';

            var title = document.createElement('div');
            title.className = 'pick-title';
            title.textContent = 'P' + (i + 1) + '  ' + h.layer.name +
                (h.layer.kind === 'mesh' ? ' · 网格' : ' · 点云');
            row.appendChild(title);

            var lines = [];
            lines.push('坐标  ' + fmtNum(h.pos[0]) + ', ' + fmtNum(h.pos[1]) + ', ' + fmtNum(h.pos[2]));
            if (h.normal)
            {
                lines.push('法向  ' + fmtNum(h.normal[0]) + ', ' +
                    fmtNum(h.normal[1]) + ', ' + fmtNum(h.normal[2]));
            }
            if (h.tag !== null && h.tag !== undefined)
            {
                lines.push('标签  ' + fmtNum(h.tag));
            }
            if (h.scalars)
            {
                for (var si = 0; si < h.scalars.length; si++)
                {
                    lines.push(h.scalars[si].name + '  ' + fmtNum(h.scalars[si].value));
                }
            }

            var info = document.createElement('div');
            info.className = 'pick-info';
            info.textContent = lines.join('\n');
            row.appendChild(info);
            list.appendChild(row);
        }

        var out = [];
        if (points.length >= 2)
        {
            var a = points[0].pos;
            var b = points[1].pos;
            out.push('距离 P1\u2192P2  ' + fmtNum(vecLen(a, b)));
            out.push('\u0394x ' + fmtNum(b[0] - a[0]) +
                '   \u0394y ' + fmtNum(b[1] - a[1]) +
                '   \u0394z ' + fmtNum(b[2] - a[2]));
        }
        if (points.length >= 3)
        {
            var p1 = points[0].pos;
            var p2 = points[1].pos;
            var p3 = points[2].pos;
            out.push('角度 \u2220P1P2P3  ' + angleAt(p1, p2, p3).toFixed(2) + '\u00B0');
            out.push('边长 P2P1 ' + fmtNum(vecLen(p2, p1)) +
                '   P2P3 ' + fmtNum(vecLen(p2, p3)));
        }
        $('pick-calc').textContent = out.join('\n');
    }

    /* ---------------- 单窗口 / 双窗口布局 ---------------- */
    function applyLayoutMode()
    {
        if (!app)
        {
            return;
        }
        var single = !!app.settings.singleView;

        $('tag-left').style.display = single ? 'none' : '';
        $('tag-right').style.display = single ? 'none' : '';
        $('split-line').style.display = single ? 'none' : '';

        // 载入菜单：单窗只有 A/B 合一，隐藏「公共」
        $('btn-load-both').style.display = single ? 'none' : '';

        // 拖放提示：单窗没有左右半屏，统一导入公共场景
        var dropZoneA = $('drop-zone-a');
        if (dropZoneA)
        {
            dropZoneA.style.width = single ? '100%' : '';
        }
        var dropLabel = $('drop-label-a');
        if (dropLabel)
        {
            dropLabel.textContent = single ? '松开导入到公共场景' : '松开导入到左侧 (A)';
        }
        var dropHint = $('drop-hint');
        if (dropHint)
        {
            dropHint.textContent = single
                ? '拖拽 STL / OBJ / PLY / 点云文件到窗口任意位置（导入公共场景）'
                : '拖拽 STL / OBJ / PLY / 点云文件到左半屏（左侧 A）或右半屏（右侧 B）';
        }

        $('btn-single').textContent = single ? '双窗' : '单窗';
        $('btn-single').title = single ? '切回双视口（左 A / 右 B）' : '合并为单视口（A/B/S 全部图层一起渲染）';
        // 不做高亮：它只是切换按钮，当前状态已由文案体现
        $('btn-single').classList.remove('active');

        $('row-ghost').style.display = single ? 'none' : '';
        $('row-sync').style.display = single ? 'none' : '';
        $('opt-sync').checked = !!app.settings.syncCam;
    }

    /* ---------------- 初始化 ---------------- */
    function init(appRef)
    {
        app = appRef;

        $('btn-load-before').addEventListener('click', function () { app.pickFiles('A'); });
        $('btn-load-after').addEventListener('click', function () { app.pickFiles('B'); });
        $('btn-load-both').addEventListener('click', function () { app.pickFiles('BOTH'); });
        $('btn-single').addEventListener('click', function ()
        {
            var on = !app.settings.singleView;
            app.setSingleView(on);
            setInfo(on ? '单窗口：A / B / S 全部图层在同一视口渲染' : '双窗口：左侧 A / 右侧 B');
        });
        $('btn-clear').addEventListener('click', function () { app.clearAll(); });
        $('btn-shot').addEventListener('click', function () { app.screenshot(); });

        $('modal-ok').addEventListener('click', function ()
        {
            var cb = confirmCb;
            hideConfirm();
            if (cb)
            {
                cb();
            }
        });
        $('modal-cancel').addEventListener('click', hideConfirm);
        $('modal').addEventListener('click', function (ev)
        {
            if (ev.target === this)
            {
                hideConfirm();
            }
        });
        $('col-ok').addEventListener('click', function ()
        {
            var err = validateLabels();
            if (err)
            {
                $('col-err').textContent = err;
                return;
            }
            $('coldlg').classList.add('hidden');
            var cb = colResolve;
            colResolve = null;
            if (cb)
            {
                cb(planFromLabels(colState.labels, colState.info.names));
            }
        });

        $('col-cancel').addEventListener('click', function ()
        {
            $('coldlg').classList.add('hidden');
            var cb = colResolve;
            colResolve = null;
            if (cb)
            {
                cb(null);
            }
        });

        document.addEventListener('keydown', function (ev)
        {
            if (ev.key === 'Escape' && !$('modal').classList.contains('hidden'))
            {
                hideConfirm();
            }
        });

        $('file-input').addEventListener('change', function (ev)
        {
            var files = Array.prototype.slice.call(ev.target.files || []);
            ev.target.value = '';
            app.addFiles(files, app.pendingSlot || 'A');
        });

        // 属性控件
        $('p-name').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.name = this.value || l.name;
            renderTree();
        });

        $('p-slot').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.slot = this.value;
            app.markDirty();
            renderTree();
        });

        $('p-color').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.color = this.value;
            l.colorRgb = hexToRgb(this.value);
            app.markDirty();
            renderTree();
        });

        $('p-backcolor').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.backColor = this.value;
            l.backColorRgb = hexToRgb(this.value);
            app.markDirty();
        });

        $('p-wirecolor').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.wireColor = this.value;
            l.wireColorRgb = hexToRgb(this.value);
            app.markDirty();
        });

        $('p-vertcolor').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.vertColor = this.value;
            l.vertColorRgb = hexToRgb(this.value);
            app.markDirty();
        });

        $('p-boundarycolor').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.boundaryColor = this.value;
            l.boundaryColorRgb = hexToRgb(this.value);
            app.markDirty();
        });

        $('p-opacity').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.opacity = parseFloat(this.value);
            $('p-opacity-val').textContent = l.opacity.toFixed(2);
            app.markDirty();
        });

        $('p-pointsize').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.pointSize = parseFloat(this.value);
            $('p-pointsize-val').textContent = String(l.pointSize);
            app.markDirty();
        });

        $('p-pointcolor').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.pointColorMode = parseInt(this.value, 10);
            updateColorBar();
            app.markDirty();
        });

        $('p-sf').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.sfIndex = parseInt(this.value, 10) || 0;
            l.sfMin = null;
            l.sfMax = null;
            renderProps();
            app.markDirty();
        });

        $('p-sfmin').addEventListener('change', applySfRange);
        $('p-sfmax').addEventListener('change', applySfRange);

        $('p-sfauto').addEventListener('click', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.sfMin = null;
            l.sfMax = null;
            $('p-sfmin').value = '';
            $('p-sfmax').value = '';
            updateColorBar();
            app.markDirty();
        });

        $('p-sframp').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.sfRamp = parseInt(this.value, 10) || 0;
            updateColorBar();
            app.markDirty();
        });

        $('p-shade').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.shadeMode = parseInt(this.value, 10);
            app.markDirty();
        });

        $('p-faces').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.showFaces = this.checked;
            app.markDirty();
        });

        $('p-wire').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.showWire = this.checked;
            app.markDirty();
        });

        $('p-verts').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.showVerts = this.checked;
            app.markDirty();
        });

        $('p-boundary').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.showBoundary = this.checked;
            app.markDirty();

            // 首次计算边界可能耗时，给出提示
            if (this.checked && l.gpu && !l.gpu.boundaryDone)
            {
                setInfo('正在统计边界边 …');
            }
        });

        $('p-vsize').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.pointSize = parseFloat(this.value);
            $('p-vsize-val').textContent = String(l.pointSize);
            app.markDirty();
        });

        $('p-normals').addEventListener('change', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.showNormals = this.checked;
            app.markDirty();
        });

        $('p-normallen').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.normalLen = parseFloat(this.value);
            $('p-normallen-val').textContent = Number(l.normalLen).toFixed(1);
            app.markDirty();
        });

        // 视图设置（复选框状态与 settings 对齐，支持 URL 预置）
        var ghostSolid = (app.settings.ghostMode | 0) === 1;
        $('opt-ghost-solid').checked = ghostSolid;
        $('opt-ghost-trans').checked = !ghostSolid;
        $('opt-sync').checked = !!app.settings.syncCam;
        $('opt-ghost').checked = !!app.settings.ghost;
        $('opt-grid').checked = !!app.settings.grid;
        $('opt-axes').checked = !!app.settings.axes;
        $('opt-lightfollow').checked = !!app.settings.lightFollow;
        $('opt-lightaz').value = Math.round((app.settings.lightAz || 0) * 180 / Math.PI);
        $('opt-lightel').value = Math.round((app.settings.lightEl || 0) * 180 / Math.PI);
        if ($('opt-lightaz-val')) { $('opt-lightaz-val').textContent = $('opt-lightaz').value + '°'; }
        if ($('opt-lightel-val')) { $('opt-lightel-val').textContent = $('opt-lightel').value + '°'; }

        $('opt-ghost').addEventListener('change', function ()
        {
            app.settings.ghost = this.checked;
            app.markDirty();
        });

        $('opt-ghost-trans').addEventListener('change', function ()
        {
            if (this.checked)
            {
                app.settings.ghostMode = 0;
                app.markDirty();
            }
        });

        $('opt-ghost-solid').addEventListener('change', function ()
        {
            if (this.checked)
            {
                app.settings.ghostMode = 1;
                app.markDirty();
            }
        });

        $('opt-sync').addEventListener('change', function ()
        {
            // 两视图共用同一相机对象，任何拖动/缩放/自适应都天然一致
            app.setSyncCamera(this.checked);
            setInfo(this.checked ? '相机同步：已开启（两视图共用相机，旋转/平移/缩放完全一致）' : '相机同步：已关闭');
        });

        $('opt-grid').addEventListener('change', function ()
        {
            app.settings.grid = this.checked;
            app.markDirty();
        });

        $('opt-axes').addEventListener('change', function ()
        {
            app.settings.axes = this.checked;
            app.markDirty();
        });

        $('btn-pick').addEventListener('click', function ()
        {
            app.togglePickInfo();
        });

        $('pick-clear').addEventListener('click', function ()
        {
            app.clearPicks();
        });

        $('pick-close').addEventListener('click', function ()
        {
            app.setPickInfo(false);
        });

        // 顶栏下拉：载入 / 插件 / 工具，三者互斥，点任一项后自动收起
        var topMenus = [
            { btn: $('btn-load'), menu: $('load-menu') },
            { btn: $('btn-plugins'), menu: $('plugins-menu') },
            { btn: $('btn-tools'), menu: $('tools-menu') }
        ];

        function hideTopMenus()
        {
            for (var mi = 0; mi < topMenus.length; mi++)
            {
                if (topMenus[mi].menu)
                {
                    topMenus[mi].menu.classList.add('hidden');
                }
                if (topMenus[mi].btn)
                {
                    topMenus[mi].btn.classList.remove('active');
                }
            }
        }

        for (var mj = 0; mj < topMenus.length; mj++)
        {
            (function (it)
            {
                if (!it.btn || !it.menu)
                {
                    return;
                }

                it.btn.addEventListener('click', function (ev)
                {
                    ev.stopPropagation();
                    var willOpen = it.menu.classList.contains('hidden');
                    hideTopMenus();
                    if (willOpen)
                    {
                        it.menu.classList.remove('hidden');
                        it.btn.classList.add('active');
                    }
                });

                it.menu.addEventListener('click', function (ev)
                {
                    ev.stopPropagation();
                    hideTopMenus();
                });
            })(topMenus[mj]);
        }

        document.addEventListener('click', hideCtxMenu);
        document.addEventListener('contextmenu', function (ev)
        {
            if (!ev.target || !ev.target.closest || !ev.target.closest('.tree-item'))
            {
                hideCtxMenu();
            }
        });

        document.addEventListener('click', hideTopMenus);

        window.addEventListener('keydown', function (ev)
        {
            if (ev.key === 'Escape')
            {
                hideTopMenus();
            }
        });

        // ?menu=1 默认展开工具菜单（便于截图 / 直达）
        if ((global.MV.config || {}).menu)
        {
            var mb = $('btn-tools');
            var mm = $('tools-menu');
            if (mb && mm)
            {
                mm.classList.remove('hidden');
                mb.classList.add('active');
            }
        }

        // 配色浮层：点「配色…」展开；点浮层外或 Esc 关闭；点色块不自动关闭
        (function ()
        {
            var btn = $('btn-colors');
            var pop = $('color-pop');
            if (!btn || !pop)
            {
                return;
            }

            function place()
            {
                var r = btn.getBoundingClientRect();
                var w = pop.offsetWidth || 216;
                var h = pop.offsetHeight || 180;
                var left = Math.min(r.left, window.innerWidth - w - 8);
                var top = r.bottom + 6;
                if (top + h > window.innerHeight - 8)
                {
                    top = Math.max(8, r.top - h - 6);
                }
                pop.style.left = Math.max(8, left) + 'px';
                pop.style.top = top + 'px';
            }

            function open()
            {
                pop.classList.remove('hidden');
                place();
                btn.classList.add('active');
            }

            function close()
            {
                pop.classList.add('hidden');
                btn.classList.remove('active');
            }

            btn.addEventListener('click', function (ev)
            {
                ev.stopPropagation();
                if (pop.classList.contains('hidden'))
                {
                    open();
                }
                else
                {
                    close();
                }
            });

            // 浮层内部：阻止冒泡，任何点击（含系统取色器回填）都不关闭
            pop.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
            pop.addEventListener('click', function (ev) { ev.stopPropagation(); });

            // 外部 pointerdown 关闭（capture 阶段先于其它逻辑）
            document.addEventListener('pointerdown', function (ev)
            {
                if (pop.classList.contains('hidden'))
                {
                    return;
                }
                if (pop.contains(ev.target) || btn.contains(ev.target))
                {
                    return;
                }
                close();
            }, true);

            window.addEventListener('keydown', function (ev)
            {
                if (ev.key === 'Escape')
                {
                    close();
                }
            });

            if ((global.MV.config || {}).colors)
            {
                open();
            }
        })();

        $('btn-remove-layer').addEventListener('click', function ()
        {
            var l = app.getSelected();
            if (!l)
            {
                setInfo('请先在场景树中选择一个图层');
                return;
            }
            app.removeLayer(l.id);
        });

        $('btn-pick-center').addEventListener('click', function ()
        {
            app.beginPickCenter();
        });

        $('btn-level').addEventListener('click', function ()
        {
            app.levelView();
        });

        $('btn-reset-view').addEventListener('click', function ()
        {
            app.resetView();
        });

        $('opt-lightfollow').addEventListener('change', function ()
        {
            app.settings.lightFollow = this.checked;
            app.markDirty();
        });

        $('opt-lightaz').addEventListener('input', function ()
        {
            app.settings.lightAz = parseFloat(this.value) * Math.PI / 180;
            $('opt-lightaz-val').textContent = this.value + '°';
            app.markDirty();
        });

        $('opt-lightel').addEventListener('input', function ()
        {
            app.settings.lightEl = parseFloat(this.value) * Math.PI / 180;
            $('opt-lightel-val').textContent = this.value + '°';
            app.markDirty();
        });

        $('opt-bg').addEventListener('input', function ()
        {
            app.settings.bg = hexToRgb(this.value);
            app.markDirty();
        });

        // 帮助
        $('btn-help').addEventListener('click', function ()
        {
            $('help').classList.toggle('hidden');
        });
        $('btn-help-close').addEventListener('click', function ()
        {
            $('help').classList.add('hidden');
        });

        renderTree();
        renderProps();
        applyLayoutMode();
    }

    global.MV.ui = {
        init: init,
        renderTree: renderTree,
        renderProps: renderProps,
        setProgress: setProgress,
        setInfo: setInfo,
        setStats: setStats,
        showConfirm: showConfirm,
        showColumnDialog: showColumnDialog,
        autoColumnPlan: autoColumnPlan,
        applyLayoutMode: applyLayoutMode,
        renderPickBar: renderPickBar,
        updateColorBar: updateColorBar,
        hexToRgb: hexToRgb
    };


    /* ==================== 全局拖放（原 dnd.js）（App 方法，由 app.js 启动时安装） ==================== */
    function installDndMethods()
    {
        var App = global.MV && global.MV.App;
        if (!App)
        {
            return;
        }

    var App = global.MV && global.MV.App;
    if (!App)
    {
        return;
    }

    App.prototype.bindDrop = function ()
    {
        var self = this;
        var area = document.getElementById('view-area');
        var zoneA = document.getElementById('drop-zone-a');
        var zoneB = document.getElementById('drop-zone-b');

        // 落点在画布左半 → A，右半 → B；单窗没有左右之分 → 公共场景（BOTH）
        function slotAt(clientX)
        {
            if (self.settings.singleView)
            {
                return 'BOTH';
            }
            if (!area)
            {
                return 'A';
            }
            var r = area.getBoundingClientRect();
            var x = clientX - r.left;
            if (x < r.width * 0.5)
            {
                return 'A';
            }
            return 'B';
        }

        function setZone(slot)
        {
            var single = !!self.settings.singleView;
            if (zoneA)
            {
                zoneA.style.width = single ? '100%' : '';
                zoneA.classList.toggle('active', single ? slot === 'BOTH' : slot === 'A');
            }
            if (zoneB)
            {
                zoneB.classList.toggle('active', !single && slot === 'B');
            }
        }

        function clearZone()
        {
            if (zoneA) { zoneA.classList.remove('active'); }
            if (zoneB) { zoneB.classList.remove('active'); }
        }

        function hasFiles(e)
        {
            var types = e.dataTransfer && e.dataTransfer.types;
            if (!types)
            {
                return false;
            }
            for (var i = 0; i < types.length; i++)
            {
                if (types[i] === 'Files')
                {
                    return true;
                }
            }
            return false;
        }

        // 全局监听：拖到画布、标签栏、场景树、属性面板任意位置都能识别
        document.addEventListener('dragover', function (e)
        {
            if (!hasFiles(e))
            {
                return;
            }
            e.preventDefault();                    // 关键：不 preventDefault 就不会触发 drop
            try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ }
            setZone(slotAt(e.clientX));
        });

        document.addEventListener('dragleave', function (e)
        {
            // 只有真正离开窗口才清除，避免经过子元素时闪烁
            if (!e.relatedTarget)
            {
                clearZone();
            }
        });

        document.addEventListener('drop', function (e)
        {
            if (!hasFiles(e))
            {
                return;
            }
            e.preventDefault();
            clearZone();

            var files = Array.prototype.slice.call(e.dataTransfer.files || []);
            if (files.length === 0)
            {
                return;
            }

            var slot = slotAt(e.clientX);
            var where = slot === 'A' ? '左侧 (A)' : (slot === 'B' ? '右侧 (B)' : '公共场景');
            global.MV.ui.setInfo('正在导入 ' + files.length + ' 个文件到' + where + ' …');
            self.addFiles(files, slot);
        });
    };

    }


    /* ==================== 载入前下采样弹窗（原 io/memguard，按分层移到界面层） ==================== */
    function askDownsample(file, est, limit)
    {
        // 自动化 / 演示：?memauto=sample&mempct=30 直接应答，不弹窗
        var cfg = global.MV.config || {};
        var auto = cfg.memauto;
        if (auto === 'sample' || auto === 'full')
        {
            return Promise.resolve({
                mode: auto,
                pct: auto === 'sample' ? (cfg.mempct || 50) : 100
            });
        }

        return new Promise(function (resolve)
        {
            var dlg = document.getElementById('memdlg');
            if (!dlg)
            {
                resolve({ mode: 'full', pct: 100 });
                return;
            }

            var pct = 100;
            var guess = Math.max(5, Math.min(95,
                Math.floor(limit / Math.max(est.bytes, 1) * 100 / 5) * 5));
            if (guess < 5) { guess = 5; }

            var slider = document.getElementById('mem-pct');
            var valEl = document.getElementById('mem-pct-val');
            var estEl = document.getElementById('mem-est');

            slider.value = String(guess);
            pct = guess;

            document.getElementById('mem-name').textContent = file.name || '(未命名)';
            document.getElementById('mem-scale').textContent =
                (est.kind === 'mesh' ? '约 ' + est.count.toLocaleString() + ' 个三角形' :
                    '约 ' + est.count.toLocaleString() + ' 个点') + ' · ' + est.note;
            document.getElementById('mem-need').textContent = global.MV.memguard.fmtBytes(est.bytes);
            document.getElementById('mem-limit').textContent = global.MV.memguard.fmtBytes(limit);

            function refresh()
            {
                pct = parseInt(slider.value, 10) || 100;
                valEl.textContent = pct + '%';
                var c = Math.round(est.count * pct / 100);
                var b = Math.round(est.bytes * pct / 100);
                estEl.textContent = '下采样后约 ' +
                    (est.kind === 'mesh' ? c.toLocaleString() + ' 三角形' : c.toLocaleString() + ' 点') +
                    '，预计占用 ' + global.MV.memguard.fmtBytes(b) +
                    (b <= limit ? '（在预算内）' : '（仍超预算）');
            }

            slider.oninput = refresh;
            refresh();

            function done(mode)
            {
                dlg.classList.add('hidden');
                resolve({ mode: mode, pct: pct });
            }

            document.getElementById('mem-sample').onclick = function () { done('sample'); };
            document.getElementById('mem-full').onclick = function () { done('full'); };
            document.getElementById('mem-cancel').onclick = function () { done('cancel'); };
            document.getElementById('mem-close').onclick = function () { done('cancel'); };

            dlg.classList.remove('hidden');
        });
    }

    /* 主入口：返回 {opts, cancel}；opts 里可能带 maxTriangles / maxPoints */
    global.MV.ui.askDownsample = askDownsample;

    global.MV.ui = global.MV.ui || {};
    global.MV.ui.installAppMethods = installDndMethods;

})(window);