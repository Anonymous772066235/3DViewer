/* L6 | 快捷键：一张表 + 单一入口
 *
 * 之前 F/W/N/P/Delete 写在 app.js 的 bindKeys 里，Esc 另有 4 处独立监听
 * （app / modal / 顶栏菜单 / 配色浮层），问题有三个：
 *   1. 新增一个键不知道该加在哪，容易两处都响应
 *   2. 只挡了 INPUT/SELECT/TEXTAREA，确认框打开时按 Delete 仍会删图层
 *   3. 帮助面板里只列了 4 条，实际有 9 条，能发现的不及一半
 *
 * 现在收敛到这里：
 *   - 捕获阶段统一拦截，命中后阻止事件继续传递，旧监听不会再跑
 *   - 守卫：输入框 / contenteditable / 确认框打开 / 按键重复
 *   - Esc 走「分层退出」栈，一次只退一层
 *   - 帮助面板按本表自动生成，避免文档与实现再次脱节
 */
(function (global)
{
    'use strict';

    var MV = global.MV = global.MV || {};

    function $(id)
    {
        return global.document.getElementById(id);
    }

    function app()
    {
        return MV.app;
    }

    function click(id)
    {
        var el = $(id);
        if (!el) { return false; }
        el.click();
        return true;
    }

    function visible(id)
    {
        var el = $(id);
        return !!el && !el.classList.contains('hidden');
    }

    /* 显示类开关：直接改图层字段，不依赖属性面板当前停在哪一栏 */
    function toggleFlag(a, flag, meshOnly)
    {
        var l = a.getSelected && a.getSelected();
        if (!l) { return; }
        if (meshOnly && l.data && l.data.kind !== 'mesh') { return; }

        l[flag] = !l[flag];

        if (MV.ui)
        {
            if (MV.ui.renderProps) { MV.ui.renderProps(); }
            if (MV.ui.renderTree) { MV.ui.renderTree(); }
        }
        a.markDirty();
    }

    function sideTab(name)
    {
        var t = global.document.querySelector(
            '#sidebar .panel-tabs .tab[data-tab="' + name + '"]');
        if (t) { t.click(); }
    }

    /* ==================== 键位表 ====================
     * k：组合键（字母小写，修饰键按 Ctrl/Alt/Shift 顺序）
     * g：帮助面板里的分组
     * 单键给高频且非破坏性的动作；破坏性动作加修饰键 */
    var KEYS = [
        { k: 'f', g: '视图', label: '适应视图', run: function (a) { a.fitAll(); } },
        { k: '1', g: '视图', label: '单窗', run: function (a) { a.setSingleView(true); } },
        { k: '2', g: '视图', label: '双窗', run: function (a) { a.setSingleView(false); } },
        { k: '0', g: '视图', label: '视角回正', run: function () { click('btn-reset-view'); } },
        { k: '[', g: '视图', label: '分隔线左移 5%', run: function (a)
            { a.setSplitRatio(a.settings.splitRatio - 0.05); } },
        { k: ']', g: '视图', label: '分隔线右移 5%', run: function (a)
            { a.setSplitRatio(a.settings.splitRatio + 0.05); } },

        { k: 'w', g: '显示', label: '线框', run: function (a) { toggleFlag(a, 'showWire', true); } },
        { k: 'n', g: '显示', label: '法向', run: function (a) { toggleFlag(a, 'showNormals', true); } },
        { k: 'v', g: '显示', label: '顶点', run: function (a) { toggleFlag(a, 'showVerts', true); } },
        { k: 'b', g: '显示', label: '边界', run: function (a) { toggleFlag(a, 'showBoundary', true); } },
        { k: 'g', g: '显示', label: '地面网格', run: function () { click('opt-grid'); } },
        { k: 'a', g: '显示', label: '坐标轴', run: function () { click('opt-axes'); } },
        { k: 't', g: '显示', label: '深浅主题', run: function () { click('btn-theme'); } },

        { k: 'p', g: '模式', label: '拾取模式', run: function (a) { a.togglePickInfo(); } },
        { k: 'c', g: '模式', label: '裁剪模式', run: function () { click('btn-seg'); } },

        { k: 'o', g: '文件', label: '载入菜单', run: function () { click('btn-load'); } },
        { k: 's', g: '文件', label: '截图', run: function () { click('btn-shot'); } },
        { k: 'Shift+s', g: '文件', label: '导出菜单', run: function () { click('btn-export'); } },
        { k: 'Delete', g: '文件', label: '删除选中图层', run: function (a)
            { if (a.selectedId !== null) { a.removeLayer(a.selectedId); } } },
        { k: 'Shift+Delete', g: '文件', label: '清空全部图层', run: function () { click('btn-clear'); } },

        { k: 'Alt+1', g: '面板', label: '图层属性', run: function () { sideTab('props'); } },
        { k: 'Alt+2', g: '面板', label: '视图设置', run: function () { sideTab('view'); } },
        { k: 'Alt+3', g: '面板', label: '数据对齐', run: function () { sideTab('xform'); } },

        { k: '?', g: '帮助', label: '打开 / 关闭本说明', run: function () { toggleHelp(); } }
    ];

    /* ==================== Esc：分层退出 ====================
     * 一次只退一层，顺序：确认框 → 下拉菜单 → 浮层 → 帮助 → 载入中 →
     * 裁剪 → 拾取信息 → 设旋转中心 → 清空选中 */
    function escapeStack()
    {
        var a = app();

        if (visible('modal')) { click('modal-cancel'); return true; }

        if (global.document.querySelector('.menu:not(.hidden)')) { global.document.body.click(); return true; }

        var pop = $('color-pop');
        if (pop && !pop.classList.contains('hidden'))
        {
            /* 浮层的关闭挂在 document 的 pointerdown 上，这里补一次同样的
             * 事件即可，避免为此单独导出一个 close() */
            var ev = ('PointerEvent' in global)
                ? new global.PointerEvent('pointerdown', { bubbles: true })
                : new global.MouseEvent('pointerdown', { bubbles: true });
            global.document.body.dispatchEvent(ev);
            return true;
        }

        if (visible('help')) { click('btn-help-close'); return true; }

        if (a && a.loading) { a.cancelLoad(); return true; }

        if (MV.algo && MV.algo.currentMode && MV.algo.currentMode())
        {
            MV.algo.setMode(null);
            return true;
        }

        if (a && a.pickInfo) { a.setPickInfo(false); return true; }
        if (a && a.pickMode) { a.cancelPickCenter(); return true; }

        if (a && a.selectedId !== null)
        {
            a.selectedId = null;
            if (MV.ui) { MV.ui.refreshUI(); }
            return true;
        }

        return false;
    }

    /* ==================== 帮助面板 ==================== */
    function toggleHelp()
    {
        var el = $('help');
        if (!el) { return; }
        var willOpen = el.classList.contains('hidden');
        el.classList.toggle('hidden', !willOpen);
        if (willOpen) { renderHelp(); }
    }

    function renderHelp()
    {
        var box = $('keyhelp');
        if (!box) { return; }

        var groups = [];
        for (var i = 0; i < KEYS.length; i++)
        {
            if (groups.indexOf(KEYS[i].g) < 0) { groups.push(KEYS[i].g); }
        }

        var html = '';
        for (var g = 0; g < groups.length; g++)
        {
            html += '<div class="keyhelp-g">' + groups[g] + '</div><table class="keyhelp-t">';
            for (var j = 0; j < KEYS.length; j++)
            {
                if (KEYS[j].g !== groups[g]) { continue; }
                html += '<tr><td><kbd>' + KEYS[j].k + '</kbd></td><td>' +
                    KEYS[j].label + '</td></tr>';
            }
            html += '</table>';
        }

        html += '<div class="keyhelp-g">模式内（进入裁剪 / 拾取后生效）</div>' +
            '<table class="keyhelp-t">' +
            '<tr><td><kbd>Space</kbd></td><td>拾取取点</td></tr>' +
            '<tr><td><kbd>Enter</kbd></td><td>闭合多边形选区</td></tr>' +
            '<tr><td><kbd>Ctrl+Z</kbd></td><td>撤销上一步追加</td></tr>' +
            '</table>';

        html += '<div class="keyhelp-g">Esc</div><table class="keyhelp-t">' +
            '<tr><td><kbd>Esc</kbd></td><td>逐层退出：确认框 → 菜单 → 浮层 → 帮助 → ' +
            '裁剪 → 拾取 → 选中</td></tr></table>';

        box.innerHTML = html;
    }

    /* ==================== 组合键与守卫 ==================== */
    function comboOf(e)
    {
        if (e.key === '?') { return '?'; }          /* Shift+/ 的语义就是问号 */

        var parts = [];
        if (e.ctrlKey || e.metaKey) { parts.push('Ctrl'); }
        if (e.altKey) { parts.push('Alt'); }
        if (e.shiftKey) { parts.push('Shift'); }

        var k = e.key;
        if (k === ' ') { k = 'Space'; }
        if (k.length === 1) { k = k.toLowerCase(); }
        parts.push(k);

        return parts.join('+');
    }

    function inEditable(e)
    {
        var t = e.target;
        if (!t) { return false; }
        var tag = (t.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { return true; }
        return !!t.isContentEditable;
    }

    function onKeydown(e)
    {
        var combo = comboOf(e);

        if (combo === 'Escape')
        {
            if (escapeStack())
            {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
            return;
        }

        /* 按住不放不重复触发；确认框打开时快捷键一律不响应 */
        if (e.repeat) { return; }
        if (visible('modal')) { return; }
        if (inEditable(e)) { return; }

        for (var i = 0; i < KEYS.length; i++)
        {
            if (KEYS[i].k !== combo) { continue; }

            var a = app();
            if (!a) { return; }

            e.preventDefault();
            e.stopImmediatePropagation();

            try
            {
                KEYS[i].run(a);
            }
            catch (err)
            {
                if (global.console) { global.console.warn('[快捷键] ' + KEYS[i].label, err); }
            }
            return;
        }
    }

    function init()
    {
        if (init.done) { return; }
        init.done = true;

        /* 捕获阶段先手：命中后旧监听（window/document 上的）不会再收到事件 */
        global.addEventListener('keydown', onKeydown, true);

        var open = $('btn-help');
        if (open) { open.addEventListener('click', toggleHelp); }

        var close = $('btn-help-close');
        if (close)
        {
            close.addEventListener('click', function ()
            {
                var el = $('help');
                if (el) { el.classList.add('hidden'); }
            });
        }
    }

    MV.keys = {
        init: init,
        keys: KEYS,
        escape: escapeStack,
        toggleHelp: toggleHelp
    };
})(window);
