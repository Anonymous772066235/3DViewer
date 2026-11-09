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

    /* 树结构签名：图层集合 / 可见性 / 名称 / 颜色 / 父子关系 / 折叠 / 选中。
     * 这些都没变时跳过整树重建（renderTree 内部会 innerHTML='' 全量重建）。 */
    var lastTreeSign = '';

    /* 元素缓存：属性面板有 ~40 个静态控件，renderProps 每次都要查一遍。
     * 用 isConnected 兜底——节点被替换过就重新查询，不会拿到失效引用。 */
    var EL_CACHE = {};

    function $(id)
    {
        var el = EL_CACHE[id];
        if (el && el.isConnected)
        {
            return el;
        }
        el = document.getElementById(id);
        if (el)
        {
            EL_CACHE[id] = el;
        }
        return el;
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


    /* vertices 占位项的右键菜单：拷到本侧 / 对侧 / 公共 */
    function showVertexCtx(x, y, layer)
    {
        var menu = $('ctx-menu');
        if (!menu)
        {
            return;
        }
        menu.innerHTML = '';

        var head = document.createElement('div');
        head.className = 'ctx-head';
        head.textContent = layer.name + ' · 顶点云';
        menu.appendChild(head);

        var other = layer.slot === 'A' ? 'B' : (layer.slot === 'B' ? 'A' : 'A');
        var selfLabel = layer.slot === 'A' ? '左侧 (A)' : (layer.slot === 'B' ? '右侧 (B)' : '公共 (S)');
        var otherLabel = other === 'A' ? '左侧 (A)' : '右侧 (B)';

        // 统一入口：预览态下 selectedId 是 null，必须先用闭包里的 layer 恢复选中
        function pickSlot(slot)
        {
            app.clearVertexPreview();
            app.selectedId = layer.id;
            app.extractVertices(slot);
        }

        ctxItem(menu, '拷贝到 ' + selfLabel + '（本侧）', function ()
        {
            pickSlot(layer.slot);
        });

        if (layer.slot !== 'S')
        {
            ctxItem(menu, '拷贝到 ' + otherLabel + '（对侧）', function ()
            {
                pickSlot(other);
            });
        }

        ctxItem(menu, '拷贝到 公共 (S)', function ()
        {
            pickSlot('S');
        });

        menu.classList.remove('hidden');
        var w = menu.offsetWidth || 170;
        var h = menu.offsetHeight || 96;
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';
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
    /* 调试：树渲染完同步点一次 ghost 行（用于复现点击路径的报错） */
    function clickGhostOnce()
    {
        if (!(global.MV.config || {}).clickverts || global.MV.__ghClicked)
        {
            return;
        }
        var a2 = global.MV.app;
        if (!a2 || !a2.layers.length)
        {
            return;
        }

        var mesh = null;
        for (var i = 0; i < a2.layers.length; i++)
        {
            if (a2.layers[i].kind === 'mesh')
            {
                mesh = a2.layers[i];
                break;
            }
        }
        if (!mesh)
        {
            return;
        }

        // 先保证选中（selectLayer 内部会再渲染一次，下一轮进来就能拿到 ghost 行）
        if (a2.selectedId !== mesh.id)
        {
            a2.selectLayer(mesh.id);
            return;
        }

        var gh = document.querySelector('.tree-item.ghost-child');
        if (gh)
        {
            global.MV.__ghClicked = true;
            gh.click();
        }
    }

    /* 树与属性一起刷新：二者几乎总是同步发生，合并成一个入口少一次重复建 DOM */
    function refreshUI()
    {
        renderTree();
        renderProps();
    }

    function renderTree()
    {
        if (!app)
        {
            return;
        }

        // 结构没变就不重建（配合 refreshUI，避免一次操作反复整树重建）
        var sig = String(app.selectedId) + '|' + String(app.vertexPreviewId) +
                  '|' + (collapsed.A ? 1 : 0) + (collapsed.B ? 1 : 0) + (collapsed.S ? 1 : 0);
        for (var si = 0; si < app.layers.length; si++)
        {
            var SL = app.layers[si];
            sig += '|' + SL.id + ',' + (SL.visible ? 1 : 0) + ',' + SL.kind + ',' + SL.slot +
                   ',' + SL.name + ',' + SL.color + ',' + (SL.parentId || 0) + ',' +
                   (SL.data ? SL.data.count : 0) + ',' + (SL.data ? SL.data.vertCount : 0);
        }
        if (sig === lastTreeSign)
        {
            return;
        }
        lastTreeSign = sig;

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

                        // 显存可能已被回收（如裁剪应用后释放），重新勾选时补上传
                        if (!layer.gpu && app.renderer && !layer._uploadFailed)
                        {
                            app.renderer.uploadLayer(layer);
                        }
                    }
                    app.markDirty();
                });

                var dot = el('span', 'dot');
                dot.style.background = layer.color;

                var tip = layerTooltip(layer);
                var name = el('span', 'lname', layer.name);
                name.title = tip;
                row.title = tip;

                // mesh 显示「面数 · 点数」，点云只显示点数
                var vc = layer.data.vertCount;
                var metaTxt;
                if (layer.kind === 'mesh')
                {
                    metaTxt = formatCount(layer.data.count) + ' 面' +
                        (vc ? ' · ' + formatCount(vc) + ' 点' : '');
                }
                else
                {
                    metaTxt = formatCount(layer.data.count) + ' 点';
                }

                var meta = el('span', 'lmeta', metaTxt);
                if (layer.kind === 'mesh' && vc)
                {
                    meta.title = layer.data.count + ' 个三角形 / ' + vc + ' 个顶点';
                }

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

                // 已派生的顶点云（子图层）
                // 注意：kids 必须在这里就取，不能用后面 var kids 的声明（var 提升会导致此处是 undefined）
                var myKids = byParent[layer.id] || [];
                var vKids = myKids.filter(function (k)
                {
                    return k.data && k.data.format === 'vertices';
                });

                // 还没有顶点云：显示一个占位子行，点一下即创建
                if (layer.kind === 'mesh' && vKids.length === 0 && layer.id === app.selectedId)
                {
                    var vrow = el('div', 'tree-item child ghost-child');
                    vrow.style.paddingLeft = (10 + (depth + 1) * 14) + 'px';
                    vrow.appendChild(el('span', 'vc-ico', '\u2601'));
                    vrow.appendChild(el('span', 'lname', 'vertices'));
                    vrow.title = '点击查看顶点信息；右键拷贝到本侧 / 对侧 / 公共';

                    if (app.vertexPreviewId === layer.id)
                    {
                        vrow.classList.add('selected');
                    }

                    // 单击：只显示顶点信息（不创建图层）
                    vrow.addEventListener('click', function (ev)
                    {
                        ev.stopPropagation();
                        app.previewVertices(layer.id);
                    });

                    // 右键：拷贝到本侧 / 对侧 / 公共
                    vrow.addEventListener('contextmenu', function (ev)
                    {
                        ev.preventDefault();
                        ev.stopPropagation();
                        showVertexCtx(ev.clientX, ev.clientY, layer);
                    });

                    children.appendChild(vrow);
                }

                var kids = myKids;
                if (kids.length)
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
    
        clickGhostOnce();
    }

    /* ---------------- 属性面板 ---------------- */
    /* 展开指定 slot 的分组（拷贝到对侧后自动露出来） */
    function expandSlot(slot)
    {
        if (slot === 'A' || slot === 'B' || slot === 'S')
        {
            collapsed[slot] = false;
        }
    }

    /* 填充「顶点云（尚未创建）」信息区；layer 为空则隐藏该区 */
    function showVertexInfo(layer)
    {
        var box = document.getElementById('vert-info');
        if (!box)
        {
            return;
        }

        if (!layer || layer.kind !== 'mesh' || !layer.data)
        {
            box.classList.add('hidden');
            return;
        }

        box.classList.remove('hidden');

        var vd = layer.data;
        var nv = vd.vertCount || 0;

        var elSrc = document.getElementById('vi-src');
        var elCnt = document.getElementById('vi-count');
        var elBox = document.getElementById('vi-bbox');

        if (elSrc) { elSrc.textContent = layer.name; }
        if (elCnt) { elCnt.textContent = nv.toLocaleString(); }

        var txt = '—';
        var bb = vd.bbox;
        var lo = null, hi = null;
        if (bb && bb.length >= 6 && typeof bb[0] === 'number')
        {
            lo = [bb[0], bb[1], bb[2]];
            hi = [bb[3], bb[4], bb[5]];
        }
        else if (bb && bb.min && bb.max && bb.min.length >= 3 && bb.max.length >= 3)
        {
            lo = bb.min;
            hi = bb.max;
        }
        if (lo && hi)
        {
            txt = lo[0].toFixed(1) + ', ' + lo[1].toFixed(1) + ', ' + lo[2].toFixed(1) +
                  ' → ' + hi[0].toFixed(1) + ', ' + hi[1].toFixed(1) + ', ' + hi[2].toFixed(1);
        }
        if (elBox) { elBox.textContent = txt; }
    }

    function renderProps()
    {
        // 选中「vertices」占位项时，只显示顶点信息区
        var viBox = document.getElementById('vert-info');
        if (viBox)
        {
            var vpSrc = null;
            if (app && app.vertexPreviewId != null)
            {
                for (var vpi = 0; vpi < app.layers.length; vpi++)
                {
                    if (app.layers[vpi].id === app.vertexPreviewId)
                    {
                        vpSrc = app.layers[vpi];
                        break;
                    }
                }
            }

            if (vpSrc)
            {
                viBox.classList.remove('hidden');

                var vd = vpSrc.data || {};
                var nv = vd.vertCount || 0;

                var elSrc = document.getElementById('vi-src');
                var elCnt = document.getElementById('vi-count');
                var elBox = document.getElementById('vi-bbox');

                if (elSrc) { elSrc.textContent = vpSrc.name; }
                if (elCnt) { elCnt.textContent = nv.toLocaleString(); }

                var txt = '—';
                var bb = vd.bbox;

                // 兼容两种结构：数组 [minx..maxz] / 对象 { min: [x,y,z], max: [x,y,z] }
                var lo = null, hi = null;
                if (bb && bb.length >= 6 && typeof bb[0] === 'number')
                {
                    lo = [bb[0], bb[1], bb[2]];
                    hi = [bb[3], bb[4], bb[5]];
                }
                else if (bb && bb.min && bb.max && bb.min.length >= 3 && bb.max.length >= 3)
                {
                    lo = bb.min;
                    hi = bb.max;
                }

                if (lo && hi)
                {
                    txt = lo[0].toFixed(1) + ', ' + lo[1].toFixed(1) + ', ' + lo[2].toFixed(1) +
                          ' → ' + hi[0].toFixed(1) + ', ' + hi[1].toFixed(1) + ', ' + hi[2].toFixed(1);
                }
                if (elBox) { elBox.textContent = txt; }

                return;         // 顶点预览态下不渲染图层属性
            }

            viBox.classList.add('hidden');
        }

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
        $('p-color-k').textContent = layer.kind === 'mesh' ? '正面' : '颜色';
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

            // 颜色范围：留空表示用数据全范围
            var ecmin = $('p-sfcolmin');
            var ecmax = $('p-sfcolmax');
            if (ecmin)
            {
                ecmin.value = (layer.sfColMin === null || layer.sfColMin === undefined) ? '' : String(layer.sfColMin);
                ecmin.placeholder = fmtNum(sfs[si0].min);
            }
            if (ecmax)
            {
                ecmax.value = (layer.sfColMax === null || layer.sfColMax === undefined) ? '' : String(layer.sfColMax);
                ecmax.placeholder = fmtNum(sfs[si0].max);
            }
            $('p-sframp').value = String(layer.sfRamp || 0);
        }

        var hasSF = layer.kind === 'points' && sfs.length > 0;
        var showSF = hasSF && pcm === 5;
        $('row-sf').classList.toggle('show', hasSF);
        $('row-sfrange').classList.toggle('show', showSF);
        var rowCol = $('row-sfcolrange');
        if (rowCol) { rowCol.classList.toggle('show', showSF); }
        $('row-sframp').classList.toggle('show', showSF);
        $('row-sfhist').classList.toggle('show', showSF);

        var rowOut = $('row-sfout');
        if (rowOut) { rowOut.classList.toggle('show', showSF); }

        // 标量条「显示」开关（在分组标题行右侧，只在标量场模式出现）
        var sfWrap = $('sf-toggle-wrap');
        if (sfWrap) { sfWrap.classList.toggle('show', showSF); }

        if (showSF)
        {
            var sfPick = sfs[Math.min(layer.sfIndex || 0, sfs.length - 1)];
            var loV = (typeof layer.sfMin === 'number' && isFinite(layer.sfMin)) ? layer.sfMin : sfPick.min;
            var hiV = (typeof layer.sfMax === 'number' && isFinite(layer.sfMax)) ? layer.sfMax : sfPick.max;
            var cLo = (typeof layer.sfColMin === 'number' && isFinite(layer.sfColMin)) ? layer.sfColMin : loV;
            var cHi = (typeof layer.sfColMax === 'number' && isFinite(layer.sfColMax)) ? layer.sfColMax : hiV;
            drawHist($('p-sfhist'), sfPick, loV, hiV, layer.sfRamp | 0, cLo, cHi);

            var selOut = $('p-sfout');
            if (selOut) { selOut.value = String((layer.sfOutMode | 0) || 1); }

            if ((global.MV.config || {}).scrollsf)
            {
                var rw = $('row-sfhist');
                if (rw && rw.scrollIntoView) { rw.scrollIntoView({ block: 'center' }); }
            }

            // 调试：?dumpcv=1 时把 canvas 导出到隐藏节点（headless 便于读取）
            if ((global.MV.config || {}).dumpcv)
            {
                var box = document.getElementById('__cv');
                if (!box)
                {
                    box = document.createElement('div');
                    box.id = '__cv';
                    box.style.display = 'none';
                    document.body.appendChild(box);
                }
                try { box.textContent = $('p-sfhist').toDataURL('image/png'); } catch (e2) { box.textContent = 'ERR'; }
            }
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

    /* ---------------- 底部日志面板 ---------------- */

    var LOG_MAX = 500;              // 历史条数上限
    var ST_MIN_H = 24;              // 单行高度（与 CSS #st-line 一致）
    var ST_STORE_KEY = 'viewer3d.statusHeight';
    var logBuf = [];
    var stHeight = ST_MIN_H;

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    /* 按关键字分级：错误 → 红，取消/警告 → 黄 */
    function classifyLog(text)
    {
        var t = text || '';
        if (/失败|错误|异常|无效|越界|不支持|无法|没[有法]|error|Error|FAIL/.test(t))
        {
            return 'err';
        }
        if (/取消|警告|注意|跳过|请先|未找到|未就绪|未拾取|warn|Warn/.test(t))
        {
            return 'warn';
        }
        return 'info';
    }

    function makeLogRow(rec)
    {
        var row = document.createElement('div');
        row.className = 'st-log-row' + (rec.kind === 'info' ? '' : ' ' + rec.kind);
        var t = document.createElement('span');
        t.className = 't';
        t.textContent = rec.time;
        var m = document.createElement('span');
        m.textContent = rec.text;
        row.appendChild(t);
        row.appendChild(m);
        return row;
    }

    function logPanelOpen()
    {
        var w = $('st-log-wrap');
        return !!w && !w.classList.contains('hidden');
    }

    function scrollLogToEnd()
    {
        var box = $('st-log');
        if (box) { box.scrollTop = box.scrollHeight; }
    }

    /* 追加一条历史；面板展开时同步追加 DOM */
    function pushLog(text)
    {
        var d = new Date();
        var rec = {
            time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()),
            text: String(text),
            kind: classifyLog(text)
        };
        logBuf.push(rec);
        if (logBuf.length > LOG_MAX) { logBuf.shift(); }

        var box = $('st-log');
        if (box && logPanelOpen())
        {
            box.appendChild(makeLogRow(rec));
            while (box.childNodes.length > LOG_MAX) { box.removeChild(box.firstChild); }
            scrollLogToEnd();
        }
        return rec;
    }

    function renderLogFull()
    {
        var box = $('st-log');
        if (!box) { return; }
        box.innerHTML = '';
        var frag = document.createDocumentFragment();
        for (var i = 0; i < logBuf.length; i++)
        {
            frag.appendChild(makeLogRow(logBuf[i]));
        }
        box.appendChild(frag);
        scrollLogToEnd();
    }

    function stMaxHeight()
    {
        var vh = global.innerHeight || 800;
        return Math.max(ST_MIN_H + 40, Math.round(vh * 0.4));
    }

    /* 应用高度：open 时渲染完整历史；persist 时写入 localStorage */
    function applyStatusHeight(hgt, persist)
    {
        var maxH = stMaxHeight();
        hgt = Math.max(ST_MIN_H, Math.min(maxH, Math.round(hgt)));
        stHeight = hgt;

        var bar = $('statusbar');
        if (!bar) { return; }
        bar.style.height = hgt + 'px';

        var open = hgt > ST_MIN_H + 2;
        var wrap = $('st-log-wrap');
        if (wrap) { wrap.classList.toggle('hidden', !open); }
        bar.classList.toggle('expanded', open);

        if (open) { renderLogFull(); }

        if (persist)
        {
            try { global.localStorage.setItem(ST_STORE_KEY, String(hgt)); } catch (e) { /* ignore */ }
        }
    }

    function fallbackCopy(text, done)
    {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
        if (ok) { done(); }
        else { setInfo('复制失败，请手动选中日志文本', true); }
    }

    function bindStatusbar()
    {
        var drag = $('st-drag');
        if (!drag) { return; }

        // 恢复上次高度
        var saved = NaN;
        try { saved = parseFloat(global.localStorage.getItem(ST_STORE_KEY)); } catch (e) { /* ignore */ }
        if (isFinite(saved) && saved > ST_MIN_H + 2)
        {
            applyStatusHeight(saved, false);
        }

        var dragging = false;
        var startY = 0;
        var startH = 0;

        drag.addEventListener('pointerdown', function (ev)
        {
            dragging = true;
            startY = ev.clientY;
            startH = stHeight;
            try { drag.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
            ev.preventDefault();
        });

        drag.addEventListener('pointermove', function (ev)
        {
            if (!dragging) { return; }
            // 向上拖 → 面板变高
            applyStatusHeight(startH + (startY - ev.clientY), false);
        });

        function endDrag()
        {
            if (!dragging) { return; }
            dragging = false;
            applyStatusHeight(stHeight, true);   // 落定并记住
        }

        drag.addEventListener('pointerup', endDrag);
        drag.addEventListener('pointercancel', endDrag);

        // 双击：单行 ↔ 展开
        drag.addEventListener('dblclick', function ()
        {
            applyStatusHeight(stHeight > ST_MIN_H + 2 ? ST_MIN_H : 220, true);
        });

        // 清空
        var clr = $('st-clear');
        if (clr)
        {
            clr.addEventListener('click', function ()
            {
                logBuf.length = 0;
                var box = $('st-log');
                if (box) { box.innerHTML = ''; }
                setInfo('日志已清空', true);
            });
        }

        // 复制全部
        var cp = $('st-copy');
        if (cp)
        {
            cp.addEventListener('click', function ()
            {
                if (!logBuf.length) { setInfo('暂无日志可复制', true); return; }
                var arr = [];
                for (var i = 0; i < logBuf.length; i++)
                {
                    arr.push(logBuf[i].time + '  ' + logBuf[i].text);
                }
                var txt = arr.join('\n');
                function done() { setInfo('已复制 ' + logBuf.length + ' 条日志', true); }

                if (global.navigator && navigator.clipboard && navigator.clipboard.writeText)
                {
                    navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt, done); });
                }
                else
                {
                    fallbackCopy(txt, done);
                }
            });
        }

        // 窗口尺寸变化时重新夹紧高度
        global.addEventListener('resize', function ()
        {
            applyStatusHeight(stHeight, false);
        });
    }

    /* ---------------- 坐标变换 ---------------- */

    var xformInputs = null;

    function fmtMat(v)
    {
        if (!isFinite(v)) { return '0'; }
        // 阈值取 toFixed(6) 的半个最小单位：否则 -1e-8 会先格式化成 "-0.000000"，
        // 去掉尾零后留下刺眼的 "-0"
        if (Math.abs(v) < 5e-7) { return '0'; }
        var s = v.toFixed(6);
        s = s.replace(/0+$/, '').replace(/\.$/, '');
        if (s === '-0' || s === '') { return '0'; }
        return s;
    }

    /* 每行 4 个、空格分隔，便于粘贴回表格 */
    function matToText(m)
    {
        var lines = [];
        for (var r = 0; r < 4; r++)
        {
            var row = [];
            for (var c = 0; c < 4; c++) { row.push(fmtMat(m[r * 4 + c])); }
            lines.push(row.join(' '));
        }
        return lines.join('\n');
    }

    function textToMat(txt)
    {
        var parts = String(txt || '').split(/[\s,;]+/).filter(function (x) { return x !== ''; });
        if (parts.length !== 16) { return null; }
        var m = new Float64Array(16);
        for (var i = 0; i < 16; i++)
        {
            var v = parseFloat(parts[i]);
            if (!isFinite(v)) { return null; }
            m[i] = v;
        }
        return m;
    }

    function identityMat()
    {
        var m = new Float64Array(16);
        m[0] = m[5] = m[10] = m[15] = 1;
        return m;
    }

    /* 4×4 求逆：转成列主序 → 伴随矩阵法 → 转回行主序 */
    function mat4Invert(m)
    {
        // 转置（行主序 -> 列主序）
        var a = [
            m[0], m[4], m[8],  m[12],
            m[1], m[5], m[9],  m[13],
            m[2], m[6], m[10], m[14],
            m[3], m[7], m[11], m[15]
        ];

        var a00 = a[0],  a01 = a[1],  a02 = a[2],  a03 = a[3];
        var a10 = a[4],  a11 = a[5],  a12 = a[6],  a13 = a[7];
        var a20 = a[8],  a21 = a[9],  a22 = a[10], a23 = a[11];
        var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

        var b00 = a00 * a11 - a01 * a10;
        var b01 = a00 * a12 - a02 * a10;
        var b02 = a00 * a13 - a03 * a10;
        var b03 = a01 * a12 - a02 * a11;
        var b04 = a01 * a13 - a03 * a11;
        var b05 = a02 * a13 - a03 * a12;
        var b06 = a20 * a31 - a21 * a30;
        var b07 = a20 * a32 - a22 * a30;
        var b08 = a20 * a33 - a23 * a30;
        var b09 = a21 * a32 - a22 * a31;
        var b10 = a21 * a33 - a23 * a31;
        var b11 = a22 * a33 - a23 * a32;

        var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (!det || !isFinite(det))
        {
            return null;
        }
        var id = 1 / det;

        var o = [
            ( a11 * b11 - a12 * b10 + a13 * b09) * id,
            (-a01 * b11 + a02 * b10 - a03 * b09) * id,
            ( a31 * b05 - a32 * b04 + a33 * b03) * id,
            (-a21 * b05 + a22 * b04 - a23 * b03) * id,
            (-a10 * b11 + a12 * b08 - a13 * b07) * id,
            ( a00 * b11 - a02 * b08 + a03 * b07) * id,
            (-a30 * b05 + a32 * b02 - a33 * b01) * id,
            ( a20 * b05 - a22 * b02 + a23 * b01) * id,
            ( a10 * b10 - a11 * b08 + a13 * b06) * id,
            (-a00 * b10 + a01 * b08 - a03 * b06) * id,
            ( a30 * b04 - a31 * b02 + a33 * b00) * id,
            (-a20 * b04 + a21 * b02 - a23 * b00) * id,
            (-a10 * b09 + a11 * b07 - a12 * b06) * id,
            ( a00 * b09 - a01 * b07 + a02 * b06) * id,
            (-a30 * b03 + a31 * b01 - a32 * b00) * id,
            ( a20 * b03 - a21 * b01 + a22 * b00) * id
        ];

        // 转回行主序
        return new Float64Array([
            o[0], o[4], o[8],  o[12],
            o[1], o[5], o[9],  o[13],
            o[2], o[6], o[10], o[14],
            o[3], o[7], o[11], o[15]
        ]);
    }

    function readXformMat()
    {
        if (!xformInputs) { return null; }
        var m = new Float64Array(16);
        for (var i = 0; i < 16; i++)
        {
            var v = parseFloat(xformInputs[i].value);
            if (!isFinite(v))
            {
                xformInfo('第 ' + (i + 1) + ' 个值无效', true);
                return null;
            }
            m[i] = v;
        }
        return m;
    }

    function writeXformMat(m)
    {
        if (!xformInputs) { return; }
        for (var i = 0; i < 16; i++) { xformInputs[i].value = fmtMat(m[i]); }
    }

    function xformInfo(text, isErr)
    {
        var el = $('xform-info');
        if (!el) { return; }
        el.textContent = text || '';
        el.className = 'xform-info' + (isErr ? ' err' : ' ok');
    }

    function buildXformGrid()
    {
        var box = $('xform-grid');
        if (!box || xformInputs) { return; }
        xformInputs = [];
        for (var i = 0; i < 16; i++)
        {
            var inp = document.createElement('input');
            inp.type = 'text';
            inp.spellcheck = false;
            inp.autocomplete = 'off';
            inp.title = 'm' + Math.floor(i / 4) + Math.floor(i % 4);
            box.appendChild(inp);
            xformInputs.push(inp);
        }
    }

    /* 数值 bbox（与 data.bbox 的 {min,max} 结构一致） */
    function bboxOfPositions(pos)
    {
        var mnx = Infinity, mny = Infinity, mnz = Infinity;
        var mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        for (var i = 0; i < pos.length; i += 3)
        {
            var x = pos[i], y = pos[i + 1], z = pos[i + 2];
            if (x < mnx) { mnx = x; }
            if (y < mny) { mny = y; }
            if (z < mnz) { mnz = z; }
            if (x > mxx) { mxx = x; }
            if (y > mxy) { mxy = y; }
            if (z > mxz) { mxz = z; }
        }
        if (!isFinite(mnx)) { return null; }
        return { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] };
    }

    /* 对一组 XYZ 顶点施加 4×4（行主序，列向量） */
    function xformPositions(arr, m)
    {
        for (var i = 0; i < arr.length; i += 3)
        {
            var x = arr[i], y = arr[i + 1], z = arr[i + 2];
            arr[i]     = m[0] * x + m[1] * y + m[2] * z + m[3];
            arr[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
            arr[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
        }
    }

    /* 法向只受 3×3 部分影响，变换后归一化 */
    function xformNormals(arr, m)
    {
        for (var i = 0; i < arr.length; i += 3)
        {
            var x = arr[i], y = arr[i + 1], z = arr[i + 2];
            var nx = m[0] * x + m[1] * y + m[2] * z;
            var ny = m[4] * x + m[5] * y + m[6] * z;
            var nz = m[8] * x + m[9] * y + m[10] * z;
            var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            arr[i] = nx / len;
            arr[i + 1] = ny / len;
            arr[i + 2] = nz / len;
        }
    }

    /* 把矩阵应用到图层：改 data + 重建 GPU */
    function applyXformToLayer(m, label)
    {
        var layer = app ? app.getSelected() : null;
        if (!layer || !layer.data || !layer.data.positions)
        {
            xformInfo('请先在场景树里选中图层', true);
            return false;
        }

        var d = layer.data;
        var before = bboxOfPositions(d.positions);

        xformPositions(d.positions, m);
        if (d.uniqVerts) { xformPositions(d.uniqVerts, m); }
        if (d.normals) { xformNormals(d.normals, m); }

        d.bbox = bboxOfPositions(d.positions) || d.bbox;

        // GPU 缓冲依赖顶点，必须重建
        if (app.renderer)
        {
            if (layer.gpu) { app.renderer.releaseLayer(layer); }
            layer.gpu = null;
            app.renderer.uploadLayer(layer);
        }

        app.markDirty();
        renderProps();

        var after = d.bbox;
        var msg = label + '：' + layer.name + '\n';
        if (before && after)
        {
            msg += 'X [' + before.min[0].toFixed(2) + ', ' + before.max[0].toFixed(2) + '] → [' +
                   after.min[0].toFixed(2) + ', ' + after.max[0].toFixed(2) + ']\n';
            msg += 'Y [' + before.min[1].toFixed(2) + ', ' + before.max[1].toFixed(2) + '] → [' +
                   after.min[1].toFixed(2) + ', ' + after.max[1].toFixed(2) + ']\n';
            msg += 'Z [' + before.min[2].toFixed(2) + ', ' + before.max[2].toFixed(2) + '] → [' +
                   after.min[2].toFixed(2) + ', ' + after.max[2].toFixed(2) + ']';
        }
        xformInfo(msg, false);
        setInfo(label + '已应用到 ' + layer.name);
        return true;
    }

    function openXformDialog()
    {
        buildXformGrid();
        var layer = app ? app.getSelected() : null;
        $('xform-layer').textContent = layer ? (layer.name + '（' + layer.kind + '）') : '（未选中）';
        if (xformInputs && xformInputs[0].value === '') { writeXformMat(identityMat()); }
        regFillSelects();
        icpFillSelects();
        $('xform').classList.remove('hidden');
        xformInfo('');
    }

    /* ---------------- 手动点对配准（Horn 四元数法） ---------------- */

    var regMode = false;          // 是否处于选点状态
    var regPairs = [];            // [{ s: 目标点(移动), d: 参考点(固定) }]
    var regPendingRef = null;     // 已选的参考点，等待对应目标点

    function fmt3p(p)
    {
        return p[0].toFixed(2) + ', ' + p[1].toFixed(2) + ', ' + p[2].toFixed(2);
    }

    /* 4×4 对称矩阵的最大特征值对应的特征向量（Jacobi 旋转法） */
    function jacobiLargestEigenVec(Nin)
    {
        var n = 4;
        var A = [];
        var V = [];
        var i, j, k, p, q;

        for (i = 0; i < n; i++)
        {
            A.push([Nin[i][0], Nin[i][1], Nin[i][2], Nin[i][3]]);
            var row = [0, 0, 0, 0];
            row[i] = 1;
            V.push(row);
        }

        for (var sweep = 0; sweep < 60; sweep++)
        {
            var off = 0;
            for (i = 0; i < n; i++)
            {
                for (j = i + 1; j < n; j++) { off += A[i][j] * A[i][j]; }
            }
            if (off < 1e-26) { break; }

            for (p = 0; p < n - 1; p++)
            {
                for (q = p + 1; q < n; q++)
                {
                    if (Math.abs(A[p][q]) < 1e-20) { continue; }

                    var theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                    var t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                    var c = 1 / Math.sqrt(t * t + 1);
                    var sn = t * c;

                    for (k = 0; k < n; k++)
                    {
                        var akp = A[k][p], akq = A[k][q];
                        A[k][p] = c * akp - sn * akq;
                        A[k][q] = sn * akp + c * akq;
                    }
                    for (k = 0; k < n; k++)
                    {
                        var apk = A[p][k], aqk = A[q][k];
                        A[p][k] = c * apk - sn * aqk;
                        A[q][k] = sn * apk + c * aqk;
                    }
                    for (k = 0; k < n; k++)
                    {
                        var vkp = V[k][p], vkq = V[k][q];
                        V[k][p] = c * vkp - sn * vkq;
                        V[k][q] = sn * vkp + c * vkq;
                    }
                }
            }
        }

        var bi = 0;
        for (i = 1; i < n; i++) { if (A[i][i] > A[bi][bi]) { bi = i; } }

        return [V[0][bi], V[1][bi], V[2][bi], V[3][bi]];
    }

    /* 求把 src 对齐到 dst 的刚体变换（4×4 行主序）
     * pairs: [{ s: [x,y,z], d: [x,y,z] }]
     * 用 Horn 的四元数法：最小化 sum |R·s + t − d|² */
    function solveRigid(pairs)
    {
        var n = pairs.length;
        if (n < 3) { return null; }

        var sc = [0, 0, 0], dc = [0, 0, 0];
        for (var i = 0; i < n; i++)
        {
            sc[0] += pairs[i].s[0]; sc[1] += pairs[i].s[1]; sc[2] += pairs[i].s[2];
            dc[0] += pairs[i].d[0]; dc[1] += pairs[i].d[1]; dc[2] += pairs[i].d[2];
        }
        for (var k = 0; k < 3; k++) { sc[k] /= n; dc[k] /= n; }

        // 协方差 S = Σ (s − sc)(d − dc)ᵀ
        var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (i = 0; i < n; i++)
        {
            var a0 = pairs[i].s[0] - sc[0], a1 = pairs[i].s[1] - sc[1], a2 = pairs[i].s[2] - sc[2];
            var b0 = pairs[i].d[0] - dc[0], b1 = pairs[i].d[1] - dc[1], b2 = pairs[i].d[2] - dc[2];
            S[0][0] += a0 * b0; S[0][1] += a0 * b1; S[0][2] += a0 * b2;
            S[1][0] += a1 * b0; S[1][1] += a1 * b1; S[1][2] += a1 * b2;
            S[2][0] += a2 * b0; S[2][1] += a2 * b1; S[2][2] += a2 * b2;
        }

        var Sxx = S[0][0], Sxy = S[0][1], Sxz = S[0][2];
        var Syx = S[1][0], Syy = S[1][1], Syz = S[1][2];
        var Szx = S[2][0], Szy = S[2][1], Szz = S[2][2];

        // Horn 的对称 4×4 矩阵
        var N = [
            [ Sxx + Syy + Szz, Syz - Szy,       Szx - Sxz,       Sxy - Syx ],
            [ Syz - Szy,       Sxx - Syy - Szz, Sxy + Syx,       Szx + Sxz ],
            [ Szx - Sxz,       Sxy + Syx,      -Sxx + Syy - Szz, Syz + Szy ],
            [ Sxy - Syx,       Szx + Sxz,       Syz + Szy,      -Sxx - Syy + Szz ]
        ];

        // Jacobi 特征分解：4×4 对称矩阵，确定性求解，避免幂迭代不收敛
        var best = jacobiLargestEigenVec(N);

        if (!best) { return null; }

        var w = best[0], x = best[1], y = best[2], z = best[3];
        var R = [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z),     2 * (x * z + w * y)],
            [2 * (x * y + w * z),     1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y),     2 * (y * z + w * x),     1 - 2 * (x * x + y * y)]
        ];

        var t = [
            dc[0] - (R[0][0] * sc[0] + R[0][1] * sc[1] + R[0][2] * sc[2]),
            dc[1] - (R[1][0] * sc[0] + R[1][1] * sc[1] + R[1][2] * sc[2]),
            dc[2] - (R[2][0] * sc[0] + R[2][1] * sc[1] + R[2][2] * sc[2])
        ];

        var m = new Float64Array(16);
        m[0] = R[0][0]; m[1] = R[0][1]; m[2] = R[0][2];  m[3] = t[0];
        m[4] = R[1][0]; m[5] = R[1][1]; m[6] = R[1][2];  m[7] = t[1];
        m[8] = R[2][0]; m[9] = R[2][1]; m[10] = R[2][2]; m[11] = t[2];
        m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;

        // 残差 RMS
        var rms = 0;
        for (i = 0; i < n; i++)
        {
            var p = pairs[i].s;
            var ex = (R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0]) - pairs[i].d[0];
            var ey = (R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1]) - pairs[i].d[1];
            var ez = (R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2]) - pairs[i].d[2];
            rms += ex * ex + ey * ey + ez * ez;
        }
        rms = Math.sqrt(rms / n);

        return { mat: m, rms: rms };
    }

    function fillLayerSelects(refSel, dstSel)
    {
        if (!refSel || !dstSel || !app) { return; }

        var cands = [];
        for (var i = 0; i < app.layers.length; i++)
        {
            var L = app.layers[i];
            if (L.visible && (L.kind === 'mesh' || L.kind === 'points')) { cands.push(L); }
        }

        function fill(sel, keepValue)
        {
            sel.innerHTML = '';
            for (var k = 0; k < cands.length; k++)
            {
                var o = document.createElement('option');
                o.value = String(cands[k].id);
                o.textContent = cands[k].name;
                sel.appendChild(o);
            }
            if (keepValue) { sel.value = keepValue; }
        }

        var prevRef = refSel.value;
        var prevDst = dstSel.value;
        fill(refSel, prevRef);
        fill(dstSel, prevDst);

        // 默认：目标层 = 当前选中层；参考层 = 另一个
        var sel = app.getSelected();
        if (sel)
        {
            dstSel.value = String(sel.id);
            for (var m = 0; m < cands.length; m++)
            {
                if (cands[m].id !== sel.id) { refSel.value = String(cands[m].id); break; }
            }
        }
    }

    function regFillSelects() { fillLayerSelects($('reg-ref'), $('reg-dst')); }
    function icpFillSelects() { fillLayerSelects($('icp-ref'), $('icp-dst')); }

    function regRender()
    {
        var el = $('reg-list');
        if (!el) { return; }
        var lines = [];
        for (var i = 0; i < regPairs.length; i++)
        {
            lines.push((i + 1) + '. 目标 (' + fmt3p(regPairs[i].s) + ') → 参考 (' + fmt3p(regPairs[i].d) + ')');
        }
        if (regPendingRef)
        {
            lines.push('● 参考点 (' + fmt3p(regPendingRef) + ')，请点击目标层上的对应位置');
        }
        el.textContent = lines.length ? lines.join('\n') : '尚未选点';
    }

    function regPick(cx, cy)
    {
        if (!app || !app.rayPick) { return; }
        var hit = app.rayPick(cx, cy);
        if (!hit || !hit.layer) { setInfo('未命中数据'); return; }

        var refId = parseInt($('reg-ref').value, 10);
        var dstId = parseInt($('reg-dst').value, 10);

        if (hit.layer.id === refId)
        {
            regPendingRef = hit.pos.slice();
            setInfo('参考点已选：' + fmt3p(regPendingRef) + '，请点击目标层的对应位置');
            regRender();
            return;
        }

        if (hit.layer.id === dstId)
        {
            if (!regPendingRef)
            {
                setInfo('请先点击参考层上的点');
                return;
            }
            regPairs.push({ s: hit.pos.slice(), d: regPendingRef });
            regPendingRef = null;
            setInfo('已配对 ' + regPairs.length + ' 组' + (regPairs.length >= 3 ? '，可点「计算矩阵」' : '，至少需要 3 组'));
            regRender();
            return;
        }

        setInfo('点到了其它图层，请点在参考层或目标层上');
    }

    function regSolve()
    {
        if (regPairs.length < 3)
        {
            xformInfo('至少需要 3 对点（当前 ' + regPairs.length + ' 对）', true);
            return;
        }
        var res = solveRigid(regPairs);
        if (!res)
        {
            xformInfo('求解失败：点对可能共线或重合', true);
            return;
        }
        writeXformMat(res.mat);
        xformInfo('点对配准完成：' + regPairs.length + ' 对，RMS = ' + res.rms.toFixed(4) +
            '\n点「应用」把矩阵作用到目标图层', false);
        setInfo('配准矩阵已计算（RMS ' + res.rms.toFixed(4) + '）');
    }

    var regCanvasBound = false;

    function regBindCanvas()
    {
        var cv = document.getElementById('gl');
        if (!cv || regCanvasBound) { return; }
        regCanvasBound = true;

        var down = null;

        cv.addEventListener('pointerdown', function (e)
        {
            if (!regMode || e.button !== 0) { return; }
            down = { x: e.clientX, y: e.clientY };
        }, true);

        cv.addEventListener('pointerup', function (e)
        {
            if (!regMode || !down) { return; }
            var dx = e.clientX - down.x;
            var dy = e.clientY - down.y;
            down = null;
            // 位移超过 4px 视为旋转，不取点
            if (dx * dx + dy * dy > 16) { return; }
            regPick(e.clientX, e.clientY);
        }, true);
    }

    /* ---------------- ICP 配准（Symmetric） ---------------- */

    function findLayerById(id)
    {
        if (!app) { return null; }
        for (var i = 0; i < app.layers.length; i++)
        {
            if (app.layers[i].id === id) { return app.layers[i]; }
        }
        return null;
    }

    function clampInt(v, lo, hi, dft)
    {
        var n = parseInt(v, 10);
        if (!isFinite(n)) { return dft; }
        return Math.max(lo, Math.min(hi, n));
    }

    /* 从图层取出配准用的点集与法向 */
    function icpSample(lay)
    {
        var d = lay.data;
        if (!d || !d.positions) { return null; }

        if (lay.kind === 'points')
        {
            return {
                pos: d.positions,
                nrm: d.normals || null,
                count: d.count || Math.floor(d.positions.length / 3)
            };
        }

        // 网格：优先用去重顶点 + 顶点法向
        if (d.uniqVerts && d.remap && d.vertCount)
        {
            var n1 = global.MV.icp.computeVertexNormals(d.positions, d.remap, d.vertCount);
            return { pos: d.uniqVerts, nrm: n1.normals, count: d.vertCount };
        }

        var n2 = global.MV.icp.computeVertexNormals(d.positions, null, null);
        return { pos: d.positions, nrm: n2.normals, count: n2.count };
    }

    function icpRun()
    {
        if (!app || !global.MV.icp) { return; }

        var refSel = $('icp-ref');
        var dstSel = $('icp-dst');
        var refId = parseInt(refSel ? refSel.value : '', 10);
        var dstId = parseInt(dstSel ? dstSel.value : '', 10);

        if (!isFinite(refId) || !isFinite(dstId))
        {
            xformInfo('请先选择参考层与目标层', true);
            return;
        }
        if (refId === dstId)
        {
            xformInfo('参考层与目标层不能是同一个图层', true);
            return;
        }

        var refLay = findLayerById(refId);
        var dstLay = findLayerById(dstId);
        if (!refLay || !dstLay)
        {
            xformInfo('图层无效', true);
            return;
        }

        var fixed = icpSample(refLay);
        var moving = icpSample(dstLay);
        if (!fixed || !moving)
        {
            xformInfo('图层缺少可配准的数据', true);
            return;
        }

        var maxIter = clampInt($('icp-iter').value, 1, 500, 40);
        var stride = clampInt($('icp-stride').value, 1, 64, 4);
        var thresh = parseFloat($('icp-thresh').value);
        if (!isFinite(thresh)) { thresh = 0.3; }

        var info = $('icp-info');
        var solver = null;
        try
        {
            solver = global.MV.icp.createSolver(moving.pos, moving.nrm, fixed.pos, fixed.nrm,
                { maxIter: maxIter, stride: stride, normalThresh: thresh, tol: 1e-7 });
        }
        catch (e)
        {
            if (info) { info.textContent = '出错：' + e.message; }
            xformInfo('ICP 出错：' + e.message, true);
            return;
        }

        if (!solver)
        {
            if (info) { info.textContent = '配准失败：数据不足'; }
            xformInfo('ICP 失败', true);
            return;
        }

        if (info) { info.textContent = '开始…'; }
        setInfo('ICP 计算中…');

        var t0 = Date.now();

        // 每帧 2 轮：单轮约几十毫秒，2 轮仍在浏览器可响应范围内
        function tick()
        {
            var r = null;
            for (var k = 0; k < 2; k++)
            {
                r = solver.step();
                if (r.done) { break; }
            }

            if (!r.done)
            {
                if (info)
                {
                    info.textContent = '迭代 ' + r.iters + ' / ' + maxIter +
                        '   RMS ' + r.rms.toFixed(4) + '   点 ' + r.used;
                }
                setTimeout(tick, 0);
                return;
            }

            var res = solver.result();
            var dt = Date.now() - t0;

            writeXformMat(res.mat);

            var txt = '迭代 ' + res.iters + ' 次，RMS = ' + res.rms.toFixed(4) +
                      '\n参与点 ' + res.used + '，' +
                      (res.hasNormals ? '法向已启用（对称目标）' : '无法向，退化为点到点') +
                      '\n耗时 ' + dt + ' ms';
            if (info) { info.textContent = txt; }

            xformInfo('ICP 完成：RMS = ' + res.rms.toFixed(4) +
                '\n点「应用」把矩阵作用到「' + dstLay.name + '」', res.rms > 1);
            setInfo('ICP 完成（RMS ' + res.rms.toFixed(4) + '，' + res.iters + ' 次迭代）');
        }

        setTimeout(tick, 30);
    }

    /* ---------------- 对称翻转检查 ---------------- */

    var SYM_VARIANTS = [
        { name: '原始',   m: [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1] },
        { name: '镜像X',  m: [-1, 0, 0, 0, 0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1] },
        { name: '镜像Y',  m: [1, 0, 0, 0,  0, -1, 0, 0, 0, 0, 1, 0,  0, 0, 0, 1] },
        { name: '镜像Z',  m: [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, -1, 0, 0, 0, 0, 1] }
    ];

    function mat4Mul(a, b)
    {
        var o = new Float64Array(16);
        for (var r = 0; r < 4; r++)
        {
            for (var c = 0; c < 4; c++)
            {
                var sum = 0;
                for (var k = 0; k < 4; k++) { sum += a[r * 4 + k] * b[k * 4 + c]; }
                o[r * 4 + c] = sum;
            }
        }
        return o;
    }

    function xformPoints(src, m, out)
    {
        for (var i = 0; i < src.length; i += 3)
        {
            var x = src[i], y = src[i + 1], z = src[i + 2];
            out[i]     = m[0] * x + m[1] * y + m[2] * z + m[3];
            out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
            out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
        }
    }

    /* 对目标层做 X/Y/Z 镜像后各跑一次 ICP，比较 RMS 判断是否为镜像件。
     * 原理：真实手性正确的数据，原始变体应当最优；若某个镜像变体明显更好，
     * 说明数据本身是镜像出来的（Geomagic 的「翻转检查」思路）。 */
    function symRun()
    {
        if (!app || !global.MV.icp) { return; }

        var refId = parseInt($('icp-ref').value, 10);
        var dstId = parseInt($('icp-dst').value, 10);
        if (!isFinite(refId) || !isFinite(dstId))
        {
            xformInfo('请先在上方 ICP 区块选择参考层与目标层', true);
            return;
        }
        if (refId === dstId)
        {
            xformInfo('参考层与目标层不能相同', true);
            return;
        }

        var fixed = icpSample(findLayerById(refId));
        var moving = icpSample(findLayerById(dstId));
        if (!fixed || !moving)
        {
            xformInfo('图层缺少可配准的数据', true);
            return;
        }

        // 完全沿用 ICP 区块的参数，不再暗中改动，避免行为与预期不符
        var maxIter = clampInt($('icp-iter').value, 1, 200, 40);
        var stride = clampInt($('icp-stride').value, 1, 64, 4);

        // 镜像会反转手性，源法向与目标法向大面积反向；
        // 若沿用法向一致性阈值会把对应点几乎全剔掉（该变体直接失败），
        // 因此镜像变体不做方向筛选。
        var thresh = -2;

        var info = $('sym-info');
        var results = [];
        var vi = 0;
        var solver = null;
        var cur = null;
        var t0 = Date.now();

        function finish()
        {
            var base = null;
            var best = null;
            var i;

            for (i = 0; i < results.length; i++)
            {
                if (results[i].name === '原始') { base = results[i]; }
                if (!best || results[i].rms < best.rms) { best = results[i]; }
            }

            var out = [];
            for (i = 0; i < results.length; i++)
            {
                var r = results[i];
                var val = (r.rms === Infinity) ? '失败  ' : r.rms.toFixed(4);
                out.push(r.name + '  ' + val + (r === best ? '   ← 最小' : ''));
            }

            var mirrored = !!(base && best && best.name !== '原始' &&
                              base.rms !== Infinity && best.rms < base.rms * 0.5);

            var verdict;
            if (!base || base.rms === Infinity)
            {
                verdict = '原始数据配准失败，无法判断';
            }
            else if (mirrored)
            {
                verdict = '疑似镜像件：' + best.name + ' 的 RMS 仅为原始的 ' +
                          (best.rms / base.rms * 100).toFixed(1) + '%';
            }
            else
            {
                verdict = '未发现镜像特征（原始 RMS ' + base.rms.toFixed(4) + '）';
            }

            out.push('');
            out.push(verdict);
            out.push('（' + SYM_VARIANTS.length + ' 个变体 × 最多 ' + maxIter + ' 轮，' +
                     (Date.now() - t0) + ' ms）');
            if (info) { info.textContent = out.join('\n'); }

            xformInfo(verdict, mirrored);
            setInfo(verdict);

            if (best && best.mat) { writeXformMat(best.mat); }
        }

        function tick()
        {
            // 还没开始当前变体：准备点集与求解器
            if (!solver)
            {
                if (vi >= SYM_VARIANTS.length) { finish(); return; }

                cur = SYM_VARIANTS[vi];
                var src = new Float32Array(moving.pos.length);
                xformPoints(moving.pos, cur.m, src);

                var nrm = null;
                if (moving.nrm)
                {
                    nrm = new Float32Array(moving.nrm.length);
                    xformPoints(moving.nrm, cur.m, nrm);
                }

                try
                {
                    solver = global.MV.icp.createSolver(src, nrm, fixed.pos, fixed.nrm,
                        { maxIter: maxIter, stride: stride, normalThresh: thresh, tol: 1e-7 });
                }
                catch (e)
                {
                    solver = null;
                }

                if (!solver)
                {
                    results.push({ name: cur.name, mirror: cur.m, rms: Infinity, iters: 0, mat: null });
                    solver = null;
                    vi++;
                    setTimeout(tick, 0);
                    return;
                }
            }

            var r = solver.step();

            if (r.done)
            {
                var res = solver.result();
                results.push({
                    name: cur.name,
                    mirror: cur.m,
                    rms: res.rms,
                    iters: res.iters,
                    mat: mat4Mul(res.mat, cur.m)
                });
                solver = null;
                cur = null;
                vi++;
            }
            else if (info)
            {
                info.textContent = '变体 ' + (vi + 1) + '/' + SYM_VARIANTS.length +
                    ' ' + cur.name + '   迭代 ' + r.iters + '/' + maxIter +
                    '   RMS ' + r.rms.toFixed(3);
            }

            setTimeout(tick, 0);
        }

        if (info) { info.textContent = '准备中…'; }
        setInfo('对称检查中…');
        setTimeout(tick, 30);
    }

    function bindXform()
    {
        buildXformGrid();

        var open = $('btn-xform');
        if (open) { open.addEventListener('click', openXformDialog); }

        var close = $('xform-close');
        if (close)
        {
            close.addEventListener('click', function () { $('xform').classList.add('hidden'); });
        }

        // 点遮罩空白处关闭
        var dlg = $('xform');
        if (dlg)
        {
            dlg.addEventListener('click', function (ev)
            {
                if (ev.target === dlg) { dlg.classList.add('hidden'); }
            });
        }

        var idBtn = $('xform-identity');
        if (idBtn)
        {
            idBtn.addEventListener('click', function ()
            {
                writeXformMat(identityMat());
                xformInfo('已重置为单位阵');
            });
        }

        var cpBtn = $('xform-copy');
        if (cpBtn)
        {
            cpBtn.addEventListener('click', function ()
            {
                var m = readXformMat();
                if (!m) { return; }
                var txt = matToText(m);
                function done() { xformInfo('已复制 4×4 矩阵到剪贴板'); }
                if (global.navigator && navigator.clipboard && navigator.clipboard.writeText)
                {
                    navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt, done); });
                }
                else
                {
                    fallbackCopy(txt, done);
                }
            });
        }

        var pstBtn = $('xform-paste');
        if (pstBtn)
        {
            pstBtn.addEventListener('click', function ()
            {
                if (!(global.navigator && navigator.clipboard && navigator.clipboard.readText))
                {
                    xformInfo('浏览器不支持读取剪贴板，请手动粘贴到输入框', true);
                    return;
                }
                navigator.clipboard.readText().then(function (txt)
                {
                    var m = textToMat(txt);
                    if (!m) { xformInfo('剪贴板内容不是 16 个数', true); return; }
                    writeXformMat(m);
                    xformInfo('已从剪贴板读入矩阵');
                }, function ()
                {
                    xformInfo('读取剪贴板被拒绝，请手动粘贴', true);
                });
            });
        }

        var invBtn = $('xform-inv');
        if (invBtn)
        {
            invBtn.addEventListener('click', function ()
            {
                var m = readXformMat();
                if (!m) { return; }
                var inv = mat4Invert(m);
                if (!inv)
                {
                    xformInfo('矩阵不可逆（行列式为 0）', true);
                    return;
                }
                if (applyXformToLayer(inv, '反变换'))
                {
                    xformInfo('已应用逆矩阵（回到变换前）\n\n' + matToText(inv), false);
                }
            });
        }

        var apBtn = $('xform-apply');
        if (apBtn)
        {
            apBtn.addEventListener('click', function ()
            {
                var m = readXformMat();
                if (!m) { return; }
                applyXformToLayer(m, '变换');
            });
        }

        // ---- 配准 Tab 切换 ----
        var tabBtns = document.querySelectorAll('.xform-tab');
        for (var ti = 0; ti < tabBtns.length; ti++)
        {
            (function (btn)
            {
                btn.addEventListener('click', function ()
                {
                    var name = btn.getAttribute('data-pane');
                    var i2;
                    var allTabs = document.querySelectorAll('.xform-tab');
                    for (i2 = 0; i2 < allTabs.length; i2++)
                    {
                        allTabs[i2].classList.toggle('active', allTabs[i2] === btn);
                    }
                    var panes = document.querySelectorAll('.xform-pane');
                    for (i2 = 0; i2 < panes.length; i2++)
                    {
                        panes[i2].classList.toggle('active',
                            panes[i2].getAttribute('data-pane') === name);
                    }
                });
            })(tabBtns[ti]);
        }

        // ---- 点对配准 ----
        regBindCanvas();

        var regStart = $('reg-start');
        if (regStart)
        {
            regStart.addEventListener('click', function ()
            {
                regMode = !regMode;
                regPendingRef = null;
                regStart.textContent = regMode ? '停止选点' : '开始选点';
                setInfo(regMode
                    ? '配准选点：先点参考层，再点目标层的对应位置（拖动仍可旋转）'
                    : '已停止选点');
                regRender();
            });
        }

        var regClear = $('reg-clear');
        if (regClear)
        {
            regClear.addEventListener('click', function ()
            {
                regPairs.length = 0;
                regPendingRef = null;
                regRender();
                setInfo('已清空点对');
            });
        }

        var regSolveBtn = $('reg-solve');
        if (regSolveBtn) { regSolveBtn.addEventListener('click', regSolve); }

        // ---- ICP ----
        var icpBtn = $('icp-run');
        if (icpBtn) { icpBtn.addEventListener('click', icpRun); }

        // ---- 对称翻转检查 ----
        var symBtn = $('sym-run');
        if (symBtn) { symBtn.addEventListener('click', symRun); }
    }

    /* 写状态栏单行；noLog 为 true 时只更新摘要、不记历史 */
    function setInfo(text, noLog)
    {
        var el = $('st-info');
        if (el) { el.textContent = text; }
        if (!noLog) { pushLog(text); }
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
    /* 应用颜色范围输入（留空 = 数据全范围） */
    function applySfColRange()
    {
        var l = app ? app.getSelected() : null;
        if (!l || !l.data.scalars || l.data.scalars.length === 0)
        {
            return;
        }
        var si = Math.min(l.sfIndex || 0, l.data.scalars.length - 1);
        var sf = l.data.scalars[si];

        var tmin = $('p-sfcolmin').value.trim();
        var tmax = $('p-sfcolmax').value.trim();
        var mn = tmin === '' ? null : parseFloat(tmin);
        var mx = tmax === '' ? null : parseFloat(tmax);

        if (mn !== null && !isFinite(mn))
        {
            setInfo('颜色范围下限无效');
            return;
        }
        if (mx !== null && !isFinite(mx))
        {
            setInfo('颜色范围上限无效');
            return;
        }

        var a = (mn === null) ? sf.min : mn;
        var b = (mx === null) ? sf.max : mx;
        if (!(b > a))
        {
            setInfo('颜色范围上限必须大于下限');
            return;
        }

        l.sfColMin = (mn === null) ? null : mn;
        l.sfColMax = (mx === null) ? null : mx;

        app.markDirty();
        renderProps();
        updateColorBar();
    }

    /* ---------------- 标量场范围条 ---------------- */

    /* 当前编辑图层的范围状态；没有可编辑的标量场时返回 null */
    function sfRulerState()
    {
        var lay = app ? app.getSelected() : null;
        if (!lay || lay.kind !== 'points')
        {
            return null;
        }
        var sfs = lay.data.scalars || [];
        if (!sfs.length || (lay.pointColorMode | 0) !== 5)
        {
            return null;
        }
        var si = Math.min(lay.sfIndex || 0, sfs.length - 1);
        var sf = sfs[si];

        var dmin = (typeof lay.sfMin === 'number' && isFinite(lay.sfMin)) ? lay.sfMin : sf.min;
        var dmax = (typeof lay.sfMax === 'number' && isFinite(lay.sfMax)) ? lay.sfMax : sf.max;
        if (!(dmax > dmin)) { dmax = dmin + 1; }

        // 颜色范围留空 = 数据全范围（与显示范围无关，拖三角时竖线不动）
        var cmin = (typeof lay.sfColMin === 'number' && isFinite(lay.sfColMin)) ? lay.sfColMin : sf.min;
        var cmax = (typeof lay.sfColMax === 'number' && isFinite(lay.sfColMax)) ? lay.sfColMax : sf.max;
        if (!(cmax > cmin)) { cmax = cmin + 1; }

        return { lay: lay, sf: sf, dmin: dmin, dmax: dmax, cmin: cmin, cmax: cmax };
    }

    /* 重绘范围条（不重建属性面板，拖动时用） */
    function syncSfRuler()
    {
        var st = sfRulerState();
        if (!st)
        {
            return;
        }
        drawHist($('p-sfhist'), st.sf, st.dmin, st.dmax, st.lay.sfRamp | 0, st.cmin, st.cmax);
    }

    /* 直方图 + 双范围手柄：
     *   顶部三角 = 显示范围（超出者按越界模式绘制）
     *   贯穿竖线 = 颜色范围（色带在这段铺满）
     * 分辨率按容器实际像素设置，避免被 CSS 压缩后发虚 */
    function drawHist(cv, sf, lo, hi, ramp, colLo, colHi)
    {
        if (!cv || !sf)
        {
            return;
        }
        if (typeof colLo !== 'number' || !isFinite(colLo)) { colLo = lo; }
        if (typeof colHi !== 'number' || !isFinite(colHi)) { colHi = hi; }

        // 按显示尺寸 × dpr 重设分辨率（首帧 clientWidth 可能为 0，退回 440）
        var cssW = cv.clientWidth || 0;
        var wantW = cssW > 20 ? Math.round(cssW * 2) : 440;
        var wantH = 104;
        if (cv.width !== wantW || cv.height !== wantH)
        {
            cv.width = wantW;
            cv.height = wantH;
        }

        var g = cv.getContext('2d');
        var W = cv.width;
        var H = cv.height;
        var TOP = 26;

        // 跟随主题：优先读 app 状态（主题在 init 末尾就可能已设置），再退回 body class
        var light = !!(global.MV.app && global.MV.app.settings && global.MV.app.settings.themeLight)
                 || document.body.classList.contains('theme-light');
        var C_BG = light ? '#eef1f5' : '#12161c';
        var C_MASK = light ? 'rgba(255,255,255,0.66)' : 'rgba(0,0,0,0.50)';
        var C_LINE_DARK = light ? 'rgba(255,255,255,0.90)' : 'rgba(0,0,0,0.75)';
        var C_LINE_LIGHT = light ? 'rgba(22,28,36,0.92)' : 'rgba(255,255,255,0.96)';
        var C_SEP = light ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.32)';
        var C_TRI = light ? '#0891b2' : '#22d3ee';
        var C_TRI_EDGE = light ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.90)';
        var C_OUTBAR = light ? 'rgba(146,152,160,0.70)' : 'rgba(126,130,136,0.62)';
        g.clearRect(0, 0, W, H);

        // 背景（深色主题用暗底，浅色主题自动跟随 CSS 变量不可读，这里统一半透明黑）
        g.fillStyle = C_BG;
        g.fillRect(0, 0, W, H);

        var span = (sf.max - sf.min) || 1;
        var PAD = 9;                       // 左右留白，手柄不会贴边被裁
        function px(v)
        {
            var f = (v - sf.min) / span;
            if (!(f > 0)) { f = 0; }
            if (f > 1) { f = 1; }
            return PAD + (W - 2 * PAD) * f;
        }
        var dx0 = px(lo), dx1 = px(hi);
        var cx0 = px(colLo), cx1 = px(colHi);

        // ---- 直方图 ----
        var bins = histBins(sf);
        var maxC = 0;
        for (var i = 0; i < bins.length; i++)
        {
            if (bins[i] > maxC) { maxC = bins[i]; }
        }
        if (maxC > 0)
        {
            var bw = (W - 2 * PAD) / bins.length;
            var ch = H - TOP - 4;
            for (var b = 0; b < bins.length; b++)
            {
                var hh = Math.sqrt(bins[b] / maxC) * ch;
                if (hh < 1) { continue; }
                var bv = sf.min + (b + 0.5) / bins.length * span;
                var outside = (bv < lo || bv > hi);
                var t = (bv - colLo) / ((colHi - colLo) || 1);
                g.fillStyle = outside
                    ? C_OUTBAR
                    : rampColorAt(ramp, Math.max(0, Math.min(1, t)));
                g.fillRect(PAD + b * bw, H - hh, Math.max(1, bw + 0.6), hh);
            }
        }

        // ---- 显示范围外的暗罩 ----
        g.fillStyle = C_MASK;
        if (dx0 > PAD) { g.fillRect(PAD, TOP, dx0 - PAD, H - TOP); }
        if (dx1 < W - PAD) { g.fillRect(dx1, TOP, W - PAD - dx1, H - TOP); }

        // ---- 颜色范围：先深描边再白线，保证在任何柱色上都看得见 ----
        function vline(x, dark, light, lw)
        {
            g.strokeStyle = dark;
            g.lineWidth = lw + 2;
            g.beginPath();
            g.moveTo(x, TOP); g.lineTo(x, H);
            g.stroke();
            g.strokeStyle = light;
            g.lineWidth = lw;
            g.beginPath();
            g.moveTo(x, TOP); g.lineTo(x, H);
            g.stroke();
        }
        vline(cx0, C_LINE_DARK, C_LINE_LIGHT, 2);
        vline(cx1, C_LINE_DARK, C_LINE_LIGHT, 2);

        // ---- 显示范围：顶部三角手柄（白边 + 青填充）----
        function tri(x, right)
        {
            var w = Math.min(10, x - 1, W - 1 - x);
            if (w < 3) { w = 3; }
            var h = TOP - 5;
            g.beginPath();
            // 左手柄靠左上、右手柄靠右上，方向随位置自动翻转
            if (right) { g.moveTo(x - w, 2); g.lineTo(x, 2); g.lineTo(x, h); }
            else { g.moveTo(x, 2); g.lineTo(x + w, 2); g.lineTo(x, h); }
            g.closePath();
            g.fillStyle = C_TRI;
            g.fill();
            g.strokeStyle = C_TRI_EDGE;
            g.lineWidth = 1;
            g.stroke();
        }
        tri(dx0, false);
        tri(dx1, true);

        // ---- 顶部分隔线与底边 ----
        g.strokeStyle = C_SEP;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, TOP + 0.5); g.lineTo(W, TOP + 0.5);
        g.moveTo(0, H - 0.5); g.lineTo(W, H - 0.5);
        g.stroke();
    }

    /* 范围条拖动：靠近哪个手柄就抓哪个 */
    function bindSfRuler()
    {
        var cv = $('p-sfhist');
        if (!cv || cv.__sfBound)
        {
            return;
        }
        cv.__sfBound = true;

        var drag = null;

        function ratio(ev)
        {
            var r = cv.getBoundingClientRect();
            var fx = (ev.clientX - r.left) / Math.max(r.width, 1);
            var fy = (ev.clientY - r.top) / Math.max(r.height, 1);
            return { fx: Math.max(0, Math.min(1, fx)), fy: fy, r: r };
        }

        function pickHandle(ev)
        {
            var st = sfRulerState();
            if (!st)
            {
                return null;
            }
            var p = ratio(ev);
            var span = (st.sf.max - st.sf.min) || 1;
            var padF = 9 / Math.max(cv.width, 1);
            var f = function (v)
            {
                var t = (v - st.sf.min) / span;
                if (!(t > 0)) { t = 0; }
                if (t > 1) { t = 1; }
                return padF + t * (1 - 2 * padF);
            };

            var cand = [
                { k: 'dmin', x: f(st.dmin), top: true },
                { k: 'dmax', x: f(st.dmax), top: true },
                { k: 'cmin', x: f(st.cmin), top: false },
                { k: 'cmax', x: f(st.cmax), top: false }
            ];

            var best = null;
            var bd = 0.045;
            for (var i = 0; i < cand.length; i++)
            {
                // 三角手柄只在上部抓，竖线全区可抓
                if (cand[i].top && p.fy > 0.30) { continue; }
                var d = Math.abs(p.fx - cand[i].x);
                if (d < bd)
                {
                    bd = d;
                    best = cand[i].k;
                }
            }
            return best;
        }

        cv.addEventListener('mousedown', function (ev)
        {
            var k = pickHandle(ev);
            if (!k)
            {
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            drag = k;
            document.body.style.cursor = 'ew-resize';
        });

        cv.addEventListener('mousemove', function (ev)
        {
            if (drag)
            {
                return;
            }
            cv.style.cursor = pickHandle(ev) ? 'ew-resize' : 'default';
        });

        window.addEventListener('mousemove', function (ev)
        {
            if (!drag)
            {
                return;
            }
            var st = sfRulerState();
            if (!st)
            {
                drag = null;
                return;
            }
            var p = ratio(ev);
            var span = (st.sf.max - st.sf.min) || 1;
            var padF = 9 / Math.max(cv.width, 1);
            var fv = (p.fx - padF) / Math.max(1e-6, 1 - 2 * padF);
            fv = Math.max(0, Math.min(1, fv));
            var v = st.sf.min + fv * span;
            var gap = span * 1e-4;

            if (drag === 'dmin')
            {
                st.lay.sfMin = Math.min(v, st.dmax - gap);
            }
            else if (drag === 'dmax')
            {
                st.lay.sfMax = Math.max(v, st.dmin + gap);
            }
            else if (drag === 'cmin')
            {
                st.lay.sfColMin = Math.min(v, st.cmax - gap);
            }
            else if (drag === 'cmax')
            {
                st.lay.sfColMax = Math.max(v, st.cmin + gap);
            }

            // 只回写显示范围的输入框。
            // 颜色范围不动 —— 它要么是 null（数据全范围），要么是用户显式设定的值，
            // 不应被三角手柄的拖动改写，否则「跟随」状态会被悄悄变成固定值。
            if (drag === 'dmin' || drag === 'dmax')
            {
                var nd = sfRulerState();
                var e1 = $('p-sfmin');
                var e2 = $('p-sfmax');
                if (nd && e1) { e1.value = String(Math.round(nd.dmin * 1000) / 1000); }
                if (nd && e2) { e2.value = String(Math.round(nd.dmax * 1000) / 1000); }
            }

            // 拖动竖线时同步颜色范围输入框
            if (drag === 'cmin' || drag === 'cmax')
            {
                var ec1 = $('p-sfcolmin');
                var ec2 = $('p-sfcolmax');
                if (ec1) { ec1.value = String(Math.round(st.lay.sfColMin * 1000) / 1000); }
                if (ec2) { ec2.value = String(Math.round(st.lay.sfColMax * 1000) / 1000); }
            }

            syncSfRuler();
            updateColorBar();
            if (app) { app.markDirty(); }
        });

        window.addEventListener('mouseup', function ()
        {
            if (!drag)
            {
                return;
            }
            drag = null;
            document.body.style.cursor = '';
        });
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
    function setSfbarVisible(on)
    {
        showSfbar = !!on;
        updateColorBar();
    }

    var showSfbar = true;      // 标量条是否显示（视图设置里可关）

    function updateColorBar()
    {
        var bar = $('sfbar');
        if (!bar)
        {
            return;
        }

        if (!showSfbar)
        {
            bar.classList.add('hidden');
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


        // 图表绑定按区域拆分，便于定位（原 593 行 init 的等价展开）
        bindTopbar();
        bindProps();
        bindViewOpts();
        bindMenus();
        bindColorPop();
        bindStatusbar();
        bindXform();
    }

    /* 强制重建树（签名缓存失效时用，如外部直接改了 layer 内部字段） */
    function forceRenderTree()
    {
        lastTreeSign = '';
        renderTree();
    }

    /* ---- bindTopbar ---- */
    function bindTopbar()
    {
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

        $('btn-fit').addEventListener('click', function ()
        {
            app.fitAll();
            setInfo('视图已按当前数据铺满');
        });

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
    }

    /* ---- bindProps ---- */
    function bindProps()
    {
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

        $('p-sfcolmin').addEventListener('change', applySfColRange);
        $('p-sfcolmax').addEventListener('change', applySfColRange);
        $('p-sfcolauto').addEventListener('click', function ()
        {
            var l3 = app ? app.getSelected() : null;
            if (!l3) { return; }
            l3.sfColMin = null;
            l3.sfColMax = null;
            app.markDirty();
            renderProps();
            updateColorBar();
        });

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

        // 越界值：半透明灰 / 不显示

        $('p-sfout').addEventListener('change', function ()

        {

            var l2 = app.getSelected();

            if (!l2)

            {

                return;

            }

            l2.sfOutMode = parseInt(this.value, 10) || 1;

            app.markDirty();

            updateColorBar();

        });


        // 范围条拖动

        bindSfRuler();


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
    }

    /* ---- bindViewOpts ---- */
    function bindViewOpts()
    {
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
    }

    /* ---- bindMenus ---- */
    function bindMenus()
    {
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
    }

    /* ---- bindColorPop ---- */
    function bindColorPop()
    {
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

        var viMake = document.getElementById('vi-make');
        if (viMake)
        {
            viMake.addEventListener('click', function ()
            {
                var srcId = app ? app.vertexPreviewId : null;
                if (srcId == null)
                {
                    return;
                }
                var slot = 'A';
                for (var mi2 = 0; mi2 < app.layers.length; mi2++)
                {
                    if (app.layers[mi2].id === srcId) { slot = app.layers[mi2].slot; break; }
                }
                app.clearVertexPreview();
                app.selectedId = srcId;
                app.extractVertices(slot);
            });
        }

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
    }


    /* 主题：只切 body 上的 class，颜色由 CSS 变量决定 */
    function applyTheme(light)
    {
        document.body.classList.toggle('theme-light', !!light);

        // 范围条是 canvas，颜色不会随 CSS 变，切主题后重画
        if (typeof syncSfRuler === 'function') { syncSfRuler(); }
        if (typeof updateColorBar === 'function') { updateColorBar(); }

        // 按钮文案 = 点下去会变成的主题（与「单窗/双窗」的交互一致）
        var btn = document.getElementById('btn-theme');
        if (btn)
        {
            btn.textContent = light ? '深色' : '浅色';
        }
    }

    /* 裁剪编辑栏：显隐 / 选中态 / 禁用态 / 选区块数（由 algo 的 hooks.segState 驱动） */
    function updateSegBar(state)
    {
        var bar = document.getElementById('seg-bar');
        if (!bar)
        {
            return;
        }

        state = state || {};
        bar.classList.toggle('hidden', !state.visible);
        if (!state.visible)
        {
            return;
        }

        var el;
        el = document.getElementById('seg-btn-rect');
        if (el) { el.classList.toggle('active', state.mode === 'rect'); }

        el = document.getElementById('seg-btn-poly');
        if (el) { el.classList.toggle('active', state.mode === 'poly'); }

        el = document.getElementById('seg-btn-append');
        if (el) { el.disabled = !state.hasPreview; }

        el = document.getElementById('seg-btn-apply');
        if (el) { el.disabled = !state.hasPreview; }

        el = document.getElementById('seg-btn-undo');
        if (el) { el.disabled = !state.canUndo; }

        el = document.getElementById('seg-count');
        if (el) { el.textContent = '选区 ' + (state.count || 0) + ' 块'; }
    }

    /* ---------------- 裁剪选择框（SVG overlay） ----------------
     * 属于界面层：algo 只拿 {overlay, rect, poly} 三个引用做几何绘制，不创建 DOM
     */
    function createSegOverlay()
    {
        var cv = document.getElementById('gl');
        if (!cv || !cv.parentNode)
        {
            return null;
        }

        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('id', 'seg-overlay');
        svg.style.cssText =
            'position:absolute;left:0;top:0;width:100%;height:100%;' +
            'pointer-events:none;z-index:5';

        function mkShape(tag)
        {
            var el = document.createElementNS(NS, tag);
            el.setAttribute('fill', 'rgba(255, 210, 70, 0.12)');
            el.setAttribute('stroke', '#ffd246');
            el.setAttribute('stroke-width', '1.2');
            el.setAttribute('stroke-dasharray', '5 3');
            el.style.display = 'none';
            svg.appendChild(el);
            return el;
        }

        var rect = mkShape('rect');
        var poly = mkShape('polygon');

        cv.parentNode.appendChild(svg);
        return { overlay: svg, rect: rect, poly: poly };
    }

    /* 裁剪按钮的激活/可用状态（algo 通过 hooks.syncSegButtons 回调过来） */
    function syncSegButtons(mode, hasPreview)
    {
        var r = document.getElementById('btn-seg-rect');
        var p = document.getElementById('btn-seg-poly');
        var ap = document.getElementById('btn-seg-apply');
        if (r) { r.classList.toggle('active', mode === 'rect'); }
        if (p) { p.classList.toggle('active', mode === 'poly'); }
        if (ap) { ap.disabled = !hasPreview; }
    }




    /* 百分比 max-height 在部分环境下不生效，用像素再兜一层 */
    function syncTabPanelMax()
    {
        var side = document.getElementById('sidebar');
        if (!side)
        {
            return;
        }

        var limit = Math.max(120, Math.floor(side.clientHeight * 0.5));
        var panels = document.querySelectorAll('#sidebar > .panel[data-tab]');
        for (var i = 0; i < panels.length; i++)
        {
            // 直接给高度：flex 分配下 max-height 会被 min-height 兜住，锁定尺寸最可靠
            panels[i].style.height = limit + 'px';
            panels[i].style.maxHeight = limit + 'px';
            panels[i].style.flex = '0 0 ' + limit + 'px';
        }
    }

    /* 侧栏 Tab：图层属性 / 视图设置 共用一块区域 */
    function bindSideTabs()
    {
        var tabs = document.querySelectorAll('#sidebar .panel-tabs .tab[data-tab]');
        var panels = document.querySelectorAll('#sidebar > .panel[data-tab]');
        if (!tabs.length || !panels.length)
        {
            return;
        }

        function showTab(name)
        {
            for (var i = 0; i < tabs.length; i++)
            {
                tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
            }
            for (var j = 0; j < panels.length; j++)
            {
                panels[j].classList.toggle('tab-hidden', panels[j].getAttribute('data-tab') !== name);
            }
            syncTabPanelMax();
        }

        for (var k = 0; k < tabs.length; k++)
        {
            (function (t)
            {
                t.addEventListener('click', function (ev)
                {
                    ev.stopPropagation();
                    showTab(t.getAttribute('data-tab'));
                });
            })(tabs[k]);
        }

        // 供 app.init 之后按 ?tab= 切到指定 Tab
        global.MV.ui.showSideTab = showTab;
    }

    /* ==================== 侧栏宽 / 面板高拖拽 ==================== */
    function bindSidebarResize()
    {
        var side = document.getElementById('sidebar');
        var grip = document.getElementById('sidebar-resizer');

        if (side && grip)
        {
            grip.addEventListener('mousedown', function (ev)
            {
                ev.preventDefault();
                var startX = ev.clientX;
                var startW = side.getBoundingClientRect().width;
                grip.classList.add('dragging');

                function move(e2)
                {
                    var w = Math.max(220, Math.min(620, startW + (e2.clientX - startX)));
                    side.style.flex = '0 0 ' + w + 'px';
                    side.style.width = w + 'px';
                }

                function up()
                {
                    grip.classList.remove('dragging');
                    document.removeEventListener('mousemove', move);
                    document.removeEventListener('mouseup', up);
                }

                document.addEventListener('mousemove', move);
                document.addEventListener('mouseup', up);
            });
        }

        var grips = document.querySelectorAll('.panel-resizer');
        for (var i = 0; i < grips.length; i++)
        {
            (function (g)
            {
                g.addEventListener('mousedown', function (ev)
                {
                    ev.preventDefault();
                    var prev = g.previousElementSibling;
                    if (!prev || !side)
                    {
                        return;
                    }

                    var startY = ev.clientY;
                    var startH = prev.getBoundingClientRect().height;
                    g.classList.add('dragging');

                    function move(e2)
                    {
                        var total = side.getBoundingClientRect().height;
                        var hh = Math.max(54, Math.min(total - 140, startH + (e2.clientY - startY)));
                        prev.style.flex = '0 0 ' + hh + 'px';
                        prev.style.height = hh + 'px';
                    }

                    function up()
                    {
                        g.classList.remove('dragging');
                        document.removeEventListener('mousemove', move);
                        document.removeEventListener('mouseup', up);
                    }

                    document.addEventListener('mousemove', move);
                    document.addEventListener('mouseup', up);
                });
            })(grips[i]);
        }

        // 标量条开关（视图设置里）+ 标量条自带的关闭按钮
        var cb = document.getElementById('opt-sfbar');
        if (cb)
        {
            cb.addEventListener('change', function () { setSfbarVisible(cb.checked); });
        }

        var sfClose = document.getElementById('sf-close');
        if (sfClose)
        {
            sfClose.addEventListener('click', function (ev)
            {
                ev.stopPropagation();
                setSfbarVisible(false);
                if (cb) { cb.checked = false; }
            });
        }

        bindSideTabs();
        global.addEventListener('resize', syncTabPanelMax);

        // 首次布局可能还没算完（sidebar.clientHeight 为 0 时会退化到 min-height），
        // 多补两次计算；另外在首个渲染帧后再算一次
        syncTabPanelMax();
        setTimeout(syncTabPanelMax, 0);
        setTimeout(syncTabPanelMax, 250);
        if (global.requestAnimationFrame)
        {
            global.requestAnimationFrame(function () { syncTabPanelMax(); });
        }
    }

    global.MV.ui = {
        init: init,
        renderTree: renderTree,
        refreshUI: refreshUI,
        forceRenderTree: forceRenderTree,
        renderProps: renderProps,
        setProgress: setProgress,
        setInfo: setInfo,
        solveRigid: solveRigid,
        setStats: setStats,
        showConfirm: showConfirm,
        showColumnDialog: showColumnDialog,
        autoColumnPlan: autoColumnPlan,
        applyLayoutMode: applyLayoutMode,
        renderPickBar: renderPickBar,
        updateColorBar: updateColorBar,
        hexToRgb: hexToRgb,
        createSegOverlay: createSegOverlay,
        syncSegButtons: syncSegButtons,
        updateSegBar: updateSegBar,
        applyTheme: applyTheme,
        setSfbarVisible: setSfbarVisible,
        showVertexInfo: showVertexInfo,
        expandSlot: expandSlot,
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
            // 单窗：落到公共槽位（与 addFiles 内部强制一致）
            if (self.settings.singleView)
            {
                return 'S';
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
                zoneA.classList.toggle('active', single ? (slot === 'BOTH' || slot === 'S') : slot === 'A');
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

    bindSidebarResize();

})(window);
