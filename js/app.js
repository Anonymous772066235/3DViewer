/* [L6·编排] app.js — 状态 / 图层 / 加载 / 输入分派 / 渲染循环
 * 依赖：全部下层（core / io / algo / render / ui）
 * 含：快捷键表（原 keys.js，L6 交互层）
 * 导出：MV.app
 */
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
        { k: 'Shift+v', g: '视图', label: '新增当前视角到清单',
            run: function (a)
            {
                var item = a.addCurrentView();
                if (global.MV.ui && global.MV.ui.setInfo)
                {
                    global.MV.ui.setInfo('已新增视角：' + item.name, true);
                }
            } },
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
        { k: 'F2', g: '图层', label: '重命名选中图层',
            run: function () { global.MV.ui.beginRenameSelected(); } },
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

        /* 配准中：Esc 先终止配准（比退出模式更紧急） */
        if (MV.ui && MV.ui.isIcpRunning && MV.ui.isIcpRunning())
        {
            MV.ui.cancelICP();
            return true;
        }

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

(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    var B = null;
    var Math3 = null;

    // 未捕获的脚本错误直接显示在状态栏，便于本地排查
    global.addEventListener('error', function (e)
    {
        var el = document.getElementById('st-info');
        if (el && e && e.message)
        {
            var where = ((e.filename || '').split('/').pop()) + ':' + (e.lineno || '?');
            el.textContent = 'JS 错误: ' + e.message + ' @ ' + where;

            // 状态栏会被 debug 文本反复覆盖，错误必须另打一份到 console 才能追溯
            if (global.console && global.console.error)
            {
                global.console.error('JSERR @ ' + where + ' -> ' + e.message);
            }
        }
    });

    /* 自动赋色：按槽位分组，**深 / 浅两套**。
     *
     * 改动三条：
     *   1. 6 色并且刻意拉开色相 —— 原来是 4 个同色系的蓝（200°~215°），
     *      第 5 个图层就开始撞色，而人眼对同色系内的细微差别几乎不敏感；
     *   2. 浅色一套整体压深 20~30%：白底上 `#6fc3ff` / `#8fb9ff` 的对比度只有 1.6:1，
     *      轮廓直接发虚；
     *   3. 选色由 `pickColor()` 按当前主题取，切主题时 `recolorLayers()` 会把
     *      "没被手动改过色"的图层换到另一套的同索引位置。 */
    var PALETTE = {
        dark: {
            A: ['#4da3ff', '#2eccb5', '#9b8cff', '#4dc9ff', '#6f8dff', '#38b6d6'],
            B: ['#ffb347', '#ff7a5c', '#ffd166', '#f4956b', '#ffa07a', '#e8b04b'],
            S: ['#8fd694', '#a9d46e', '#5fd0a8', '#7ed957', '#b7d95c', '#57c98b']
        },
        light: {
            A: ['#1f6fd0', '#0e8a78', '#5b47c4', '#1a86b8', '#3a5fd0', '#0f7f9c'],
            B: ['#c47a10', '#c0452a', '#b38900', '#b85f2c', '#c2622f', '#a86a1a'],
            S: ['#2f8f4a', '#5a8f1c', '#1a8a68', '#3d8f2a', '#6f8f20', '#1d8a56']
        }
    };

    function paletteSet(light)
    {
        return light ? PALETTE.light : PALETTE.dark;
    }

    /* 在 hex 上做提亮 / 压暗（amt > 0 提亮，< 0 压暗） */
    function tintHex(hex, amt)
    {
        var rgb = global.MV.util.hexToRgb(hex);
        if (!rgb) { return hex; }

        var out = [0, 0, 0];
        for (var i = 0; i < 3; i++)
        {
            var c = rgb[i];
            out[i] = (amt >= 0) ? (c + (1 - c) * amt) : (c * (1 + amt));
        }
        return global.MV.util.rgbToHex(out);
    }

    /* 四个通道的标注色 —— **深浅两套主题使用同一组色值**，不随主题变。
     *
     * 选值依据（WCAG 对比度实测，面片色共 36 个，跨深浅两套色卡）：
     *
     *   通道   色值        对深底 #161b22   对浅底 #ffffff   离最近面片色
     *   顶点   #e713a7        4.16             4.16            52°
     *   边界   #e83068        4.16             4.16            28°
     *   法向   #0097a7        4.93             3.51             7°
     *   线框   中性反色       15.4 / 1.06        —              —
     *
     * 为什么标注色只能落在紫红 / 红两族：面片色占满了橙 11°~43°、绿 68°~174°、
     * 青蓝 185°~249°，色环上再没有别的空档。实测把「离面片 ≥26°」当硬约束时，
     * 只有 285°~345° 这一段有解，所以顶点与边界同族（差 24°），靠形态区分：
     * 顶点是圆点、边界是折线，且两者极少同时打开。
     *
     * 线框没有固定色值，因为它覆盖面积最大、必须画在**任意**面片上都可读：
     * 按面片亮度在近黑 / 近白之间二选一（与面片亮度差恒 > 0.35）。
     * 这条规则同样与主题无关 —— 同一张面片在深浅两套下得到同一条线色。
     *
     * 背面色仍随主题（#6b7078 / #7a828c）：它是面片，不是标注，要贴着背景。 */
    var MARK_WIRE = '#00e5ff';     /* 线框：荧光青（开线框时面片压暗 55%，线才跳得出来） */
    var MARK_VERT = '#ff3df2';     /* 顶点：高亮品红，离面片 54° */
    var MARK_BOUND = '#ff2d55';    /* 边界：高亮红，开放边 / 缺陷标记 */

    function applyDerivedColors(lay, hex, light)
    {
        /* 线框：固定纯黑，深浅主题、面片颜色都不影响。
         *
         * 为什么是"黑"而不是某个高亮色：线框是唯一会铺满整个模型的通道，
         * 必须压在任意槽位色上都看得见。实测对全部 36 个面片色取最小值 ——
         *   固定纯黑    3.14   ← 固定色里的最优
         *   固定近白    1.28
         *   高亮青 #00e5ff  1.04（画在同族亮蓝面上等于消失）
         *   高亮黄 #ffd400  1.01（画在橙色系面片上等于消失）
         * 也就是说：任何**彩色**线框都必然在某族面片上失效，只有中性黑能通吃。
         * 代价是浅色主题的暗面片上只有 3.1（以前按面片反色能做到 5.9），
         * 换来"切主题线框不换色"。 */
        var wire = MARK_WIRE;

        lay.wireColor = wire;
        lay.wireColorRgb = global.MV.util.hexToRgb(wire);

        lay.vertColor = MARK_VERT;
        lay.vertColorRgb = global.MV.util.hexToRgb(MARK_VERT);

        lay.boundaryColor = MARK_BOUND;
        lay.boundaryColorRgb = global.MV.util.hexToRgb(MARK_BOUND);

        /* 背面色：中性灰，避免与正面色抢眼。
         * 原来还留着一个 `backColor: '#b03a30'`（红）而 rgb 是灰 —— hex 与 rgb 不一致，
         * 渲染只用 rgb 所以没暴露，但任何人读 hex 都会拿到错的值。这里统一。 */
        lay.backColor = light ? '#7a828c' : '#6b7078';
        lay.backColorRgb = global.MV.util.hexToRgb(lay.backColor);
    }

    function App()
    {
        this.layers = [];
        this.nextId = 1;
        this.selectedId = null;
        this.vertexPreviewId = null;   // 选中 vertices 占位项时的源网格 id（未创建图层）
        this.pendingSlot = 'A';
        this.lastActiveView = -1;
        this.pickMode = false;
        this.pickInfo = false;
        this.pickPoints = [];

        this.settings = {
            /* 背景色必须在**构造期**就定下来：setTheme 是在 init() 之后调的，
             * 那时 canvas 已经按深色清过一次屏 —— 浅色模式下刷新会看到一帧暗色。
             * 规则与 <head> 里的内联脚本、以及 init 末尾恢复主题时完全一致：
             * 先看 URL ?theme=，再退回 localStorage（默认深色）。 */
            bg: (function ()
            {
                var light = false;
                try
                {
                    var qs = (global.location && global.location.search) || '';
                    if (qs.indexOf('theme=light') >= 0) { light = true; }
                    else if (qs.indexOf('theme=dark') < 0)
                    {
                        light = (global.localStorage.getItem('viewer3d.theme') === 'light');
                    }
                }
                catch (e) { /* 隐私模式：退回深色 */ }

                return light ? [0.933, 0.945, 0.961] : [0.078, 0.094, 0.129];
            })(),
            grid: false,          /* 地面网格默认关闭 */
            axes: true,
            ghost: true,
            ghostMode: 0,
            singleView: false,
        splitRatio: 0.5,          /* 双窗分隔比例（0 左、1 右，0.5 各半） */
            syncCam: true,
            lightFollow: true,
            lightAz: Math.PI * 0.25,
            lightEl: Math.PI * 0.20,
            lineWidth: 1.1,
            pointScale: 1.0
        };

        // 默认左右相机同步：两个视图共用同一个相机对象
        var CameraCtor = global.MV.math.OrbitCamera;
        var sharedCam = new CameraCtor();
        this.views = [
            { camera: sharedCam, slots: { A: true, B: false, S: true }, rect: { x: 0, y: 0, w: 1, h: 1 } },
            { camera: sharedCam, slots: { A: false, B: true, S: true }, rect: { x: 0, y: 0, w: 1, h: 1 } }
        ];

        this.canvas = null;
        this.renderer = null;
        this.dpr = 1;
        this.cssW = 1;
        this.cssH = 1;
        this.dirty = true;
        this.drag = null;
        this.paletteCursor = { A: 0, B: 0, S: 0 };
        this.propsByKey = {};
        this.lastStats = { triangles: 0, points: 0, draws: 0 };
        this.fps = 0;
        this.frameCount = 0;
        this.fpsStamp = 0;
        this.statStamp = 0;
        this.loading = false;
    }

    /* ---------------- 初始化 ---------------- */
    App.prototype.init = function ()
    {
        B = global.MV.math.BBox;
        Math3 = global.MV.math;

        this.canvas = document.getElementById('gl');
        this.renderer = new global.MV.Renderer(this.canvas);

        // 上下文丢失/恢复：丢失时提示；恢复后清空各层 GPU 资源，下一帧自动重新上传
        (function (self2)
        {
            self2.renderer.onContextEvent = function (kind)
            {
                if (kind === 'lost')
                {
                    global.MV.ui.setInfo('WebGL 上下文丢失（显存被系统回收），正在等待恢复…');
                    return;
                }

                for (var ci = 0; ci < self2.layers.length; ci++)
                {
                    self2.layers[ci].gpu = null;
                }
                self2.markDirty();
                global.MV.ui.setInfo('WebGL 上下文已恢复，正在重建显存资源');
            };
        })(this);
        /* `?mark=` 是给旧的 3D 十字拾取标记调"单臂长度"用的；
         * 拾取改成 DOM 标签后长度没有意义了，参数保留解析但不再生效。 */

        if (!this.renderer.init())
        {
            document.getElementById('st-info').textContent = this.renderer.error;
            document.getElementById('drop-hint').classList.add('hidden');
            return;
        }

        // 先解析 URL 参数，ui.init 才能按最终状态回填复选框
        var params = new global.URLSearchParams(global.location.search);

        // URL 参数集中解析：其它模块只读 MV.config，不再各自 new URLSearchParams
        global.MV.config = {
            demo: params.get('demo') || '',
            segapply: params.get('segapply') === '1',
            runOptimize: params.get('runoptimize') === '1',
            memlimit: parseFloat(params.get('memlimit')) || 0,
            memauto: params.get('memauto') || '',
            mempct: parseInt(params.get('mempct') || '50', 10) || 50,
            menu: params.get('menu') === '1',
            tab: params.get('tab') || '',
            mkverts: params.get('mkverts') === '1',
            preview: params.get('preview') === '1',
            clickverts: params.get('clickverts') === '1',
            selone: params.get('selone') === '1',
            dumpcv: params.get('dumpcv') === '1',
            scrollsf: params.get('scrollsf') === '1',
            pcm: params.has('pcm') ? parseInt(params.get('pcm'), 10) : -1,
            colors: params.get('colors') === '1',
            noconfirm: params.get('noconfirm') === '1',
            debug: params.get('debug') === '1',
            cull: params.get('cull') !== '0',

        /* 网格 LOD：参考 three.js LOD 的距离切换 + 3D Tiles 的屏幕空间误差。
         * ?lod=0 关闭；?lodpx=N 调整允许误差（像素，默认 12）。 */
            lod: params.get('lod') !== '0',
            lodPx: parseFloat(params.get('lodpx')) || 16,   // CSS 像素；渲染时乘 dpr
            pickgrid: params.get('pickgrid') === '1',       // 超大网格默认不预建拾取网格
            lodcache: params.get('lodcache') !== '0',       // ?lodcache=0 禁用 LOD 缓存

        /* 线框 / 顶点「按屏幕密度自动隐藏」。?density=0 关闭，
         * 用于对比或强制查看密集网格的全部边线。 */
        density: params.get('density') !== '0',

        /* 单层「显示端」点数上限。
         *
         * 46 万 + 36 万点的两份点云，双视图下每帧要画 165 万个点
         * （每个图层在主视图画一次、在对面的 ghost 再画一次）。
         * 点云是单次 drawArrays、无分块剔除，代价与点数线性相关，
         * 这就是配准期间帧率被拖住的主因。
         *
         * 抽稀只影响「画出来的点」，不碰 positions —— 拾取、配准、
         * 统计、导出仍用全量数据。1200px 视口本来也分辨不出 46 万个点。
         * ?ptcap=0 可关闭，?ptcap=N 可改。 */
        pointCap: (function () {
            var v = params.get('ptcap');
            if (v === null) { return 180000; }
            var n = parseInt(v, 10);
            return isFinite(n) && n >= 0 ? n : 180000;
        })()
        };
        var wireParam = params.get('wire');
        this.urlWire = wireParam === '1' || wireParam === '2';
        this.urlVerts = params.get('verts') === '1';
        this.urlFaces = params.get('faces') !== '0' && wireParam !== '2';
        this.urlNormals = params.get('normals') === '1';
        this.urlBoundary = params.get('boundary') === '1';
        this.urlMark = params.has('mark') ? (parseFloat(params.get('mark')) || 0) : 0;
        // 可选：显式限制载入数量（默认 0 = 不限制，全量载入）
        this.urlMaxTri = params.has('maxtri') ? (parseInt(params.get('maxtri'), 10) || Number.POSITIVE_INFINITY) : 0;
        this.urlMaxPts = params.has('maxpts') ? (parseInt(params.get('maxpts'), 10) || Number.POSITIVE_INFINITY) : 0;
        this.urlPointColor = params.has('pc') ? (parseInt(params.get('pc'), 10) || 0) : -1;
        this.urlSF = params.has('sf') ? (parseInt(params.get('sf'), 10) || 0) : 0;
        this.urlSfMin = params.has('sfmin') ? parseFloat(params.get('sfmin')) : null;
        this.urlSfMax = params.has('sfmax') ? parseFloat(params.get('sfmax')) : null;
        this.urlSfRamp = params.has('sframp') ? (parseInt(params.get('sframp'), 10) || 0) : 0;
        this.noConfirmColumns = params.get('noconfirm') === '1';
        this.urlShade = params.has('shade') ? (parseInt(params.get('shade'), 10) || 0) : -1;
        if (params.get('lf') === '0')
        {
            this.settings.lightFollow = false;
        }
        if (params.has('laz'))
        {
            this.settings.lightAz = (parseFloat(params.get('laz')) || 0) * Math.PI / 180;
        }
        if (params.has('lel'))
        {
            this.settings.lightEl = (parseFloat(params.get('lel')) || 0) * Math.PI / 180;
        }
        this.urlZoom = parseFloat(params.get('zoom') || '1') || 1;
        this.urlYaw = params.has('yaw') ? (parseFloat(params.get('yaw')) || 0) * Math.PI / 180 : null;
        this.urlPitch = params.has('pitch') ? (parseFloat(params.get('pitch')) || 0) * Math.PI / 180 : null;
        if (params.get('ghostsolid') === '1' || params.get('ghostmode') === '1')
        {
            this.settings.ghostMode = 1;
        }
        if (params.get('sync') === '1')
        {
            this.setSyncCamera(true);
        }
        // ?zoom= / ?target= 在载入完成后生效（fitAll 会重置距离，这里统一乘一次）
        // target=x,y,z 用于把镜头对准某个局部（配合 zoom 放大看细节）
        var urlTarget = null;
        if (params.has('target'))
        {
            var ta = (params.get('target') || '').split(',');
            if (ta.length >= 3)
            {
                var tv = [parseFloat(ta[0]), parseFloat(ta[1]), parseFloat(ta[2])];
                if (isFinite(tv[0]) && isFinite(tv[1]) && isFinite(tv[2]))
                {
                    urlTarget = tv;
                }
            }
        }
        if ((this.urlZoom && this.urlZoom !== 1) || urlTarget)
        {
            var camApplied = false;      // 双文件加载会触发多次 mv:loaded，只应用一次
            global.addEventListener('mv:loaded', function ()
            {
                if (camApplied)
                {
                    return;
                }
                camApplied = true;

                var cams = self.settings.syncCam
                    ? [self.views[0].camera]
                    : [self.views[0].camera, self.views[1].camera];
                for (var zi = 0; zi < cams.length; zi++)
                {
                    if (urlTarget)
                    {
                        cams[zi].target = [urlTarget[0], urlTarget[1], urlTarget[2]];
                    }
                    if (self.urlZoom && self.urlZoom !== 1)
                    {
                        cams[zi].distance *= self.urlZoom;
                    }
                }
                self.markDirty();
            });
        }

        // 自测 / 演示：?demo=pick 载入完成后自动做三次拾取（便于验证面板与距离/角度）
        if (params.get('demo') === 'pick')
        {
            global.addEventListener('mv:loaded', function ()
            {
                var r = self.canvas.getBoundingClientRect();
                var tries = [];
                for (var gy = 0; gy < 5; gy++)
                {
                    for (var gx = 0; gx < 5; gx++)
                    {
                        tries.push([0.26 + gx * 0.12, 0.30 + gy * 0.10]);
                    }
                }
                self.setPickInfo(true);
                for (var ti = 0; ti < tries.length && (self.pickPoints || []).length < 3; ti++)
                {
                    var fx = self.settings.singleView ? tries[ti][0] : (0.5 + tries[ti][0] * 0.5);
                    var x = r.left + r.width * fx;
                    var y = r.top + r.height * tries[ti][1];
                    if (self.rayPick(x, y))
                    {
                        self.addPickPoint(x, y);
                    }
                }
            });
        }

        this.debug = params.get('debug') === '1';

        global.MV.ui.init(this);

        // 单窗必须在 ui.init 之后设置：setSingleView 会调 ui.applyLayoutMode，之前调无效
        if (params.get('single') === '1')
        {
            this.setSingleView(true);
        }
        global.MV.ui.setInfo('就绪 — 支持 STL / OBJ / PLY / 点云文本');

        this.bindPointer();
        this.bindDrop();
        this.bindKeys();

        var self = this;

        // 尺寸变化由事件驱动，不再每帧轮询
        window.addEventListener('resize', function () { self.resize(); });

        // ResizeObserver 覆盖非窗口级变化：侧栏拖拽、单双窗切换、面板折叠等
        if (global.ResizeObserver)
        {
            this.sizeObserver = new global.ResizeObserver(function () { self.resize(); });
            this.sizeObserver.observe(this.canvas);
        }

        // 首次测量（此时可能尚未布局完成，ResizeObserver 首帧回调会再修正一次）
        this.resize();

        // 左下角视角立方体：点击面切换视角
        this.cubeCanvas = document.getElementById('axis-cube');
        if (this.cubeCanvas)
        {
            // HEX_GEO 已拆到 gizmo.js，通过 MV.gizmoGeo 读取
            var geo = global.MV.gizmoGeo;
            this.cubeCanvas.title = geo
                ? ('视角器：' + geo.count + ' 个面 ' + JSON.stringify(geo.stat) +
                    '，箭头为 X/Y/Z 正方向')
                : '视角器：点击面切换视角，箭头为 X/Y/Z 正方向';
        }
        if (this.cubeCanvas)
        {
            this.cubeCanvas.addEventListener('click', function (ev) { self.hitAxisCube(ev); });
        this.cubeCanvas.addEventListener('mousemove', function (ev)
        {
            var cv = self.cubeCanvas;
            var r = cv.getBoundingClientRect();
            self.cubeHover = {
                x: (ev.clientX - r.left) * cv.width / Math.max(r.width, 1),
                y: (ev.clientY - r.top) * cv.height / Math.max(r.height, 1)
            };
            self.drawAxisCube();
        });
        this.cubeCanvas.addEventListener('mouseleave', function ()
        {
            self.cubeHover = null;
            self.drawAxisCube();
        });
        }

        this.tickBound = this.tick.bind(this);
        requestAnimationFrame(this.tickBound);

        // 支持 ?url=<文件地址>&slot=A|B|BOTH 直接打开（需 http 服务）
        // 第二个文件用 ?url2=&slot2=（双窗对比：左网格 / 右点云）
        // 必须串行：addFiles 内部共享进度与图层状态，并行会互相覆盖
        var selfU = this;
        var autoUrl = params.get('url');
        var autoUrl2 = params.get('url2');

        function pickSlot(v, dft)
        {
            var s2 = (v || dft).toUpperCase();
            return (s2 === 'A' || s2 === 'B' || s2 === 'S' || s2 === 'BOTH') ? s2 : dft;
        }

        if (autoUrl)
        {
            this.loadFromUrl(autoUrl, pickSlot(params.get('slot'), 'B')).then(function ()
            {
                if (autoUrl2)
                {
                    return selfU.loadFromUrl(autoUrl2, pickSlot(params.get('slot2'), 'A'));
                }
                return null;
            }).catch(function (e)
            {
                if (global.MV.ui && global.MV.ui.setInfo)
                {
                    global.MV.ui.setInfo('载入失败：' + (e && e.message ? e.message : e), false, 'fail');
                }
            });
        }
        else if (autoUrl2)
        {
            this.loadFromUrl(autoUrl2, pickSlot(params.get('slot2'), 'A')).catch(function () {});
        }
    };

    /* 载入历史点一条：
     *   url  —— 直接再取该地址
     *   path —— 由服务端 GET /file?path= 回读（浏览器自己读不了本地路径）
     *   disk —— 拿不到路径，只能提示重新选择 */
    App.prototype.openRecent = function (item)
    {
        if (!item) { return; }

        var slot = item.slot || 'A';

        // 标记本次载入来自历史：成功后只把原条目置顶，不再追加重复记录
        this._recentLoading = item;

        if (item.kind === 'url' && item.url)
        {
            this.loadFromUrl(item.url, slot, item.name);
            return;
        }

        if (item.kind === 'path' && item.path)
        {
            this.loadFromUrl('/file?path=' + encodeURIComponent(item.path), slot, item.name);
            return;
        }

        if (item.kind === 'handle' && item.handleId)
        {
            var self = this;
            global.MV.ui.setInfo('正在恢复「' + item.name + '」…');
            global.MV.ui.reopenHandle(item.handleId).then(function (file)
            {
                return self.addFiles([file], slot);
            }).then(null, function (err)
            {
                global.MV.ui.setInfo('无法恢复「' + item.name + '」：' + err.message +
                    '（文件可能已被移动或删除）');
            });
            return;
        }

        global.MV.ui.setInfo('「' + item.name +
            '」当初由本地选择载入，浏览器拿不到它的路径，请重新选择文件');
        this.pickFiles(slot);
    };

    App.prototype.loadFromUrl = async function (url, slot, nameHint)
    {
        global.MV.ui.setProgress(true, '下载 ' + url, 0);
        try
        {
            var tDl = global.MV.ui.nowMs();
            var file_dl = 0;
            var resp = await global.fetch(url, { cache: 'no-store' });
            if (!resp.ok)
            {
                throw new Error('HTTP ' + resp.status);
            }
            var buf = await resp.arrayBuffer();
            /* 下载耗时记在 File 上，载入的汇总日志会把它算进总时长 */
            file_dl = global.MV.ui.nowMs() - tDl;
            // /file?path=... 这类地址的末段没有文件名，允许调用方直接给
            var name = nameHint || decodeURIComponent((url.split('/').pop() || 'model').split('?')[0]);
            var file = new global.File([buf], name);
            file._downloadMs = file_dl;

            // 记录完整访问地址（浏览器能拿到的最接近“绝对路径”的信息）
            try
            {
                file.sourceUrl = new global.URL(url, global.location.href).href;
            }
            catch (e)
            {
                file.sourceUrl = url;
            }

            await this.addFiles([file], slot);
        }
        catch (err)
        {
            global.MV.ui.setProgress(false, '');
            global.MV.ui.setInfo('URL 载入失败: ' + err.message +
                '（file:// 下无法读取本地文件，请用 serve.bat 启动本地服务）', false, 'fail');
        }
    };

    /* ---------------- 尺寸 / 视图矩形 ---------------- */
    App.prototype.resize = function ()
    {
        var cw = this.canvas.clientWidth;
        var ch = this.canvas.clientHeight;
        var dpr = Math.min(global.devicePixelRatio || 1, 2);

        if (cw !== this.cssW || ch !== this.cssH || dpr !== this.dpr)
        {
            this.cssW = cw;
            this.cssH = ch;
            this.dpr = dpr;

            /* 重新分配 drawing buffer 会立刻清空画面。
             *
             * 上下文是 alpha:false，所以「清空」= 不透明黑。
             * ResizeObserver 的回调发生在 rAF 之后、合成之前 —— 若只把 dirty
             * 置位等下一帧再画，这一帧合成出去的就是那块还没绘制的黑缓冲。
             * 拖日志栏时回调连续触发，于是画面反复闪黑；
             * 深色主题本身就是黑的，所以这个 bug 一直只在浅色下显形。
             *
             * 这里改完尺寸立刻补画一帧，保证任何时刻被合成的都是已绘制的画面。 */
            this.canvas.width = Math.max(1, Math.round(cw * dpr));
            this.canvas.height = Math.max(1, Math.round(ch * dpr));
            this.dirty = true;

            this.updateRects();

            /* 视口宽度变了，分隔线也要跟着挪。
             * 拖侧栏 / 折叠面板都会走到这里（ResizeObserver 观察 canvas），
             * 但这条线原来只在 setSplitRatio 里写过位置 ——
             * 于是拖侧栏时画布已经跟上了，分隔线还停在旧像素处。 */
            this.syncSplitLine();

            if (this.renderer && this.renderer.ready)
            {
                this.renderFrame();
                this.dirty = false;
            }
        }
    };

    App.prototype.updateRects = function ()
    {
        var dpr = this.dpr;
        var fullW = Math.max(1, Math.round(this.cssW * dpr));
        var fullH = Math.max(1, Math.round(this.cssH * dpr));

        if (this.settings.singleView)
        {
            this.views[0].rect = { x: 0, y: 0, w: fullW, h: fullH };
            this.views[1].rect = { x: 0, y: 0, w: 1, h: 1 };
            return;
        }

        var gap = 2;
        var ratio = this.settings.splitRatio;
        if (!(ratio > 0 && ratio < 1)) { ratio = 0.5; }

        var left = Math.max(1, (this.cssW - gap) * ratio);

        this.views[0].rect = { x: 0, y: 0, w: Math.round(left * dpr), h: fullH };
        this.views[1].rect = {
            x: Math.round((left + gap) * dpr),
            y: 0,
            w: Math.max(1, Math.round((this.cssW - gap - left) * dpr)),
            h: fullH
        };
    };

    /* ---------------- 图层管理 ---------------- */
    /* 取下一个自动色。返回 { hex, idx }：
     * idx 要记在图层上 —— 切主题时靠它在另一套色卡里找到"同一个位置"的颜色
     * （否则深色下第 3 个图层是紫的，切到浅色会变成别的色相，用户会以为数据变了）。 */
    App.prototype.pickColor = function (slot)
    {
        var set = paletteSet(this.settings.themeLight);
        var list = set[slot] || set.S;

        var idx = this.paletteCursor[slot] % list.length;
        this.paletteCursor[slot] = (this.paletteCursor[slot] + 1) % list.length;

        return { hex: list[idx], idx: idx };
    };

    /* 切主题后重算「自动色」图层：主色换到另一套色卡的同索引位置，派生色一并对齐。
     * 用户手动改过任何一项颜色的图层（autoColor=false）整层跳过 —— 不去覆盖他的选择。 */
    App.prototype.recolorLayers = function ()
    {
        var set = paletteSet(this.settings.themeLight);
        var light = !!this.settings.themeLight;
        var changed = 0;

        for (var i = 0; i < this.layers.length; i++)
        {
            var L = this.layers[i];
            if (!L || L.autoColor === false) { continue; }

            var list = set[L.slot] || set.S;
            var idx = (L.autoIdx || 0) % list.length;
            var hex = list[idx];

            L.color = hex;
            L.colorRgb = global.MV.util.hexToRgb(hex);

            applyDerivedColors(L, hex, light);
            changed++;
        }

        if (changed)
        {
            this.markDirty();
            if (global.MV.ui && global.MV.ui.renderTree) { global.MV.ui.renderTree(); }
        }
    };

    // 同一文件的多个图层之间双向联动的显示属性
    var LINK_KEYS = [
        /* autoColor / autoIdx 也要联动：同一文件在 A/B 两侧必须保持同色，
         * 否则"两侧表现一致"这条设计就破了 */
        'autoColor', 'autoIdx',
        'color', 'colorRgb', 'backColor', 'backColorRgb',
        'wireColor', 'wireColorRgb', 'vertColor', 'vertColorRgb',
        'boundaryColor', 'boundaryColorRgb',
        'opacity', 'pointSize', 'pointColorMode', 'sfIndex', 'sfMin', 'sfMax', 'sfRamp',
        'shadeMode', 'showFaces', 'showWire', 'showVerts', 'showBoundary', 'showNormals', 'normalLen'
    ];


    /* 把网格的唯一顶点抽成一个独立点云图层（挂在源网格下）
     * 用位置量化去重（Q=1e4，0.1 μm），与焊接判重规则一致 */

    /* 选中「vertices」占位项：只显示信息，不创建图层 */
    App.prototype.previewVertices = function (meshId)
    {
        this.vertexPreviewId = meshId;
        this.selectedId = meshId;        // 保持选中：树里 mesh 仍高亮、vertices 仍显示

        global.MV.ui.renderTree();

        // 直接填充顶点信息区（不依赖 renderProps 的分支判断）
        if (global.MV.ui.showVertexInfo)
        {
            global.MV.ui.showVertexInfo(this.getSelected());
        }
    };

    /* 退掉顶点预览（选中别的图层时调用） */
    App.prototype.clearVertexPreview = function ()
    {
        if (this.vertexPreviewId !== null && this.vertexPreviewId !== undefined)
        {
            this.vertexPreviewId = null;
        }
    };


    /* 顶点云统一外观：青色 + 小点径，便于与源网格区分 */
    App.prototype.applyVertexCloudStyle = function (lay)
    {
        /* 青色在深底上很跳，在白底上偏亮（对比度约 2.2:1）——浅色主题压深一档 */
        var hex = this.settings.themeLight ? '#0e8a9c' : '#22d3ee';
        lay.color = hex;
        lay.colorRgb = global.MV.util.hexToRgb(hex);
        lay.pointSize = 2;
        lay.opacity = 1;
        lay.pointColorMode = 0;
    };

    App.prototype.extractVertices = function (targetSlot)
    {
        // 兼容「顶点预览态」：此时 selectedId 为 null，退回用 vertexPreviewId
        var src = this.getSelected();
        if (!src && this.vertexPreviewId != null)
        {
            for (var vi = 0; vi < this.layers.length; vi++)
            {
                if (this.layers[vi].id === this.vertexPreviewId) { src = this.layers[vi]; break; }
            }
        }

        if (!src || src.kind !== 'mesh' || !src.data || !src.data.positions)
        {
            global.MV.ui.setInfo('请先在场景树里选中一个网格图层');
            return;
        }

        // 快路径：STL 焊接时 render 已经算好唯一顶点集，直接拿来用（不重算）
        var cached = (src.data && src.data.uniqVerts) || (src.gpu && src.gpu.uniqVerts);
        if (cached && cached.length)
        {
            var cn = cached.length / 3;
            var cbb = src.data && src.data.bbox ? src.data.bbox : null;
            var cdata = {
                kind: 'points',
                positions: cached,
                count: cn,
                vertCount: cn,
                normals: null,
                colors: null,
                tags: null,
                scalars: [],
                bbox: cbb,
                format: 'vertices',
                truncated: false,
                totalSource: cn,
                note: ''
            };
            var slotOut = targetSlot || src.slot;
            var clayer = this.createLayer('vertices', slotOut, cdata,
                'verts:' + src.id + ':' + cn + ':' + slotOut);
            clayer.parentId = src.id;
            clayer.visible = true;
            this.applyVertexCloudStyle(clayer);
            this.layers.push(clayer);
            this.selectedId = clayer.id;
            if (this.renderer) { this.renderer.uploadLayer(clayer); }   // 新图层必须上传，否则绘制列表跳过
            this.markDirty();
            // 目标分组若折叠着，先展开，否则新图层看不见
            if (global.MV.ui.expandSlot) { global.MV.ui.expandSlot(slotOut); }
            global.MV.ui.refreshUI();
            global.MV.ui.setInfo('已把 ' + cn + ' 个顶点拷成点云（复用焊接结果，无需重算）');
            return;
        }

        /* 优先用规范化顶点表（索引格式 = 解析器顶点表；STL = 焊接结果），
         * 避免把索引格式的顶点表当成 soup 重复展开。 */
        var pos = src.data.uniqVerts || src.data.positions;
        var nSrc = Math.floor(pos.length / 3);
        var map = new Map();
        var out = new Float32Array(pos.length);
        var n = 0;
        var Q = 1e4;

        var minX = Infinity, minY = Infinity, minZ = Infinity;
        var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (var v = 0; v < nSrc; v++)
        {
            var o = v * 3;
            var x = pos[o], y = pos[o + 1], z = pos[o + 2];
            var key = Math.round(x * Q) + ',' + Math.round(y * Q) + ',' + Math.round(z * Q);
            if (map.has(key))
            {
                continue;
            }
            map.set(key, n);
            out[n * 3] = x;
            out[n * 3 + 1] = y;
            out[n * 3 + 2] = z;
            n++;

            if (x < minX) { minX = x; }
            if (y < minY) { minY = y; }
            if (z < minZ) { minZ = z; }
            if (x > maxX) { maxX = x; }
            if (y > maxY) { maxY = y; }
            if (z > maxZ) { maxZ = z; }
        }

        if (n === 0)
        {
            global.MV.ui.setInfo('该网格没有可提取的顶点');
            return;
        }

        var data = {
            kind: 'points',
            positions: out.subarray(0, n * 3),
            count: n,
            vertCount: n,
            normals: null,
            colors: null,
            tags: null,
            scalars: [],
            bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
            format: 'vertices',
            truncated: false,
            totalSource: n,
            note: ''
        };

        var slotOut = targetSlot || src.slot;
        var lay = this.createLayer('vertices', slotOut, data,
            'verts:' + src.id + ':' + n + ':' + slotOut);
        lay.parentId = src.id;
        lay.visible = true;
        this.applyVertexCloudStyle(lay);
        this.layers.push(lay);
        this.selectedId = lay.id;
        if (this.renderer) { this.renderer.uploadLayer(lay); }          // 同上
        this.markDirty();

        if (global.MV.ui.expandSlot) { global.MV.ui.expandSlot(slotOut); }
        global.MV.ui.refreshUI();
        global.MV.ui.setInfo('已把 ' + n + ' 个顶点拷成点云图层（挂在 ' + src.name + ' 下）');
    };

    /* 导入预处理：analyzeMesh / buildIndexed / buildSpaceChunks / 索引自检
     * 串行依赖链一次在 Worker 里做完。结果挂回 data，createLayer / uploadLayer
     * 读到现成字段就跳过各自的同步计算。
     * Worker 不可用（file://）时返回 false，走原来的同步路径。 */
    var preprocessWorker = null;
    var preprocessReqId = 0;
    var preprocessPending = Object.create(null);

    function getPreprocessWorker()
    {
        if (preprocessWorker || !global.Worker) { return preprocessWorker; }
        try
        {
            var v = (global.MV.config && global.MV.config.version) || '';
            preprocessWorker = new global.Worker('js/worker_io.js' + (v ? '?v=' + v : ''));
            preprocessWorker.onmessage = function (ev)
            {
                var m = ev.data;
                /* parse 命令的进度 / 结果走独立 pending 表 */
                if (m && m.cmd && parsePending[m.id])
                {
                    var pp = parsePending[m.id];
                    if (m.cmd === 'progress')
                    {
                        if (pp.onProgress) { pp.onProgress(m.frac, m.text); }
                        return;
                    }
                    delete parsePending[m.id];
                    pp.done(m);
                    return;
                }
                var resolve = preprocessPending[m.id];
                delete preprocessPending[m.id];
                if (!resolve) { return; }
                resolve({
                    vertCount: m.vertCount, bbox: m.bbox,
                    uniqVerts: m.uniqVerts, remap: m.remap,
                    verts: m.verts, idx: m.idx, vcount: m.vcount,
                    chunks: m.chunks, lods: m.lods, orderedIdx: m.orderedIdx,
                    idxOk: m.idxOk, badIdx: m.badIdx
                });
            };
            preprocessWorker.onerror = function ()
            {
                /* 让所有等待中的请求 reject，调用方回退同步 */
                for (var k in preprocessPending)
                {
                    preprocessPending[k](null);
                }
                preprocessPending = Object.create(null);
                try { preprocessWorker.terminate(); } catch (e) { /* ignore */ }
                preprocessWorker = null;
            };
        }
        catch (e)
        {
            preprocessWorker = null;
        }
        return preprocessWorker;
    }

    var parsePending = Object.create(null);

    /* LOD 缓存：同一文件第二次打开不再重复跑聚类简化。
     * 缓存键含文件名/大小/修改时间/算法版本，源数据变了自动失效。 */
    App.prototype.applyLodCache = async function (data, file)
    {
        if (!data || data.kind !== 'mesh' || !data.preLods ||
            !global.MV.lodCache || (global.MV.config && global.MV.config.lodcache === false))
        {
            return;
        }
        var key = 'lod-v1|' + file.name + '|' + file.size + '|' + (file.lastModified || 0);
        var cached = await global.MV.lodCache.get(key);
        if (cached && cached.length === data.preLods.length)
        {
            data.preLods = cached;
            data.lodCacheHit = true;
        }
        else
        {
            await global.MV.lodCache.put(key, data.preLods);
            data.lodCacheHit = false;
        }
    };

    /* 完整导入（解析 + 预处理）在 Worker 内一次完成。
     * 主线程只负责：发 File、显示进度、收结果。
     * file:// 下 Worker 不可用 → 回退原来的 MV.loaders.loadFile。 */
    App.prototype.parseInWorker = function (file, opts, onProgress)
    {
        var W = getPreprocessWorker && getPreprocessWorker();
        if (!W) { return Promise.resolve(null); }   // 回退标记

        return new Promise(function (resolve)
        {
            var id = 'parse_' + (++preprocessReqId);
            parsePending[id] = { done: resolve, onProgress: onProgress };
            var v = (global.MV.config && global.MV.config.version) || '';
            /* 只有 STL 是非索引格式（三角形直接存 3 个顶点坐标），需要焊接；
            * OBJ/PLY/OFF/glTF 解析器都保留顶点索引（indexed），不经过这里。 */
            var weld = !!(opts && opts.format && String(opts.format).indexOf('STL') === 0);
            try
            {
                W.postMessage({
                    id: id, cmd: 'parse', file: file, opts: opts, weld: weld
                });
            }
            catch (e)
            {
                delete parsePending[id];
                resolve(null);
            }
        }).then(function (m)
        {
            if (!m || m.cmd === 'cancelled') { return null; }
            if (m.cmd === 'error') { throw new Error(m.message || '解析失败'); }
            return m.data || null;
        });
    };

    App.prototype.preprocessMesh = function (data)
    {
        if (!data || data.kind !== 'mesh' || !data.positions ||
            data.uniqVerts !== undefined)
        {
            return Promise.resolve(false);
        }
        /* 索引格式的 positions 是顶点表，不是 soup，面数必须取 data.count。 */
        var tri = data.count || Math.floor(data.positions.length / 9);
        if (!tri) { return Promise.resolve(false); }

        /* 索引化格式（OBJ/PLY/OFF/glTF）：顶点表+索引已表达拓扑，保留原样不焊接 */
        if (data.indexed && data.indices && data.vertCount)
        {
            /* file:// 回退也能分块：buildSpaceChunks 已上移到双环境共享作用域。 */
            var ix = { verts: data.positions, idx: data.indices, vcount: data.vertCount };
            var topo = global.MV.topology || {};
            var sc = topo.buildSpaceChunks ? topo.buildSpaceChunks(ix, tri)
                : { chunks: null, bbox: data.bbox, n: 1, idx: data.indices };
            var lods = (topo.buildClusterLods && sc.chunks)
                ? topo.buildClusterLods(ix, tri, sc.bbox, sc.n, sc.chunks)
                : null;
            return Promise.resolve({
                vertCount: data.vertCount, bbox: data.bbox,
                uniqVerts: data.positions, remap: data.indices,
                verts: data.positions, idx: data.indices, vcount: data.vertCount,
                chunks: sc.chunks, lods: lods,
                orderedIdx: sc.idx,
                idxOk: true, badIdx: 0
            }).then(function (r)
            {
                data.vertCount = r.vertCount;
                data.uniqVerts = r.uniqVerts;
                data.remap = r.remap;
                data.preVerts = r.verts;
                data.preIdx = r.idx;
                data.preVcount = r.vcount;
                data.preChunks = r.chunks;
                data.preLods = r.lods;
                data.preOrderedIdx = r.orderedIdx;
                data.preIdxOk = true;
                data.preBadIdx = 0;
                return true;
            });
        }

        if (tri < 1000) { return Promise.resolve(false); }   // soup 小网格不值得开 Worker

        var W = getPreprocessWorker();
        if (!W) { return Promise.resolve(false); }

        return new Promise(function (resolve)
        {
            var id = ++preprocessReqId;
            preprocessPending[id] = resolve;
            /* 发副本：transfer 后主线程的 data.positions 不能失效（渲染要用） */
            var copy = new Float32Array(data.positions);
            try
            {
                W.postMessage({
                    id: id, positions: copy,
                    weld: (data.format || '').indexOf('STL') === 0   // 只有 STL 非索引
                }, [copy.buffer]);
            }
            catch (e)
            {
                delete preprocessPending[id];
                resolve(false);
            }
        }).then(function (r)
        {
            if (!r) { return false; }
            data.vertCount = r.vertCount;
            data.bbox = r.bbox;
            data.uniqVerts = r.uniqVerts;
            data.remap = r.remap;
            data.preVerts = r.verts;
            data.preIdx = r.idx;
            data.preVcount = r.vcount;
            data.preChunks = r.chunks;
            data.preLods = r.lods || null;
            data.preOrderedIdx = r.orderedIdx;
            data.preIdxOk = r.idxOk;
            data.preBadIdx = r.badIdx;
            return true;
        });
    };

    /* 首次拾取前后台建 pickGrid：独立一次性 Worker，避免与导入预处理的
     * onmessage 冲突。大网格拾取索引 O(三角形×覆盖格)，主线程建会卡。 */
    App.prototype.schedulePickGrid = function (layer)
    {
        var d = layer && layer.data;
        if (!d || d.kind !== 'mesh' || !d.positions) { return; }
        var tri = d.count || Math.floor(d.positions.length / 9);
        if (tri < 4000 || !global.Worker) { return; }   // 小网格 / 无 Worker：同步兜底
        /* 200 万面以上预建要复制 100+ MiB 并后台扫全量面，和首帧渲染抢资源；
         * 默认跳过，首次点选时走全量拾取。?pickgrid=1 可强制预建。 */
        if (tri > 2000000 && !(global.MV.config && global.MV.config.pickgrid)) { return; }

        var verts = d.preVerts || d.uniqVerts || d.positions;
        var triIdx = d.preIdx || d.remap || null;
        var copy = new Float32Array(verts);
        var idxCopy = triIdx ? new Uint32Array(triIdx) : null;
        var id = layer.id;
        try
        {
            var v = (global.MV.config && global.MV.config.version) || '';
            var W = new global.Worker('js/worker_io.js' + (v ? '?v=' + v : ''));
            W.onmessage = function (ev)
            {
                var m = ev.data;
                if (m && m.cmd === 'pickgrid' && m.layerId === id)
                {
                    layer._pickGridPending = m.grid;
                }
                W.terminate();                          // 一次性
            };
            W.onerror = function () { try { W.terminate(); } catch (e) { /* ignore */ } };
            var tr = [copy.buffer];
            if (idxCopy) { tr.push(idxCopy.buffer); }
            W.postMessage({
                id: id, cmd: 'pickgrid', layerId: id,
                verts: copy, idx: idxCopy, triCount: tri, N: 8
            }, tr);
        }
        catch (e) { /* 失败不影响拾取（走同步兜底） */ }
    };

    App.prototype.createLayer = function (name, slot, data, key)
    {
        // 树里要立即显示「点数量」：在导入时就统计一次唯一顶点数（焊接结果与它一致）
        // 网格只分析一次：顶点数 / 包围盒 / 去重顶点集，后续（树显示、顶点云拷贝）全部复用
        if (data.kind === 'mesh' && data.positions && data.uniqVerts === undefined)
        {
            if (data.indexed && data.indices && data.vertCount)
            {
                /* 索引格式：顶点表 + 面索引本身就是规范表示，不能按 soup 再分析一次。 */
                data.uniqVerts = data.positions;
                data.remap = data.indices;
            }
            else if (global.MV.render && global.MV.render.analyzeMesh)
            {
                var an = global.MV.render.analyzeMesh(data.positions);
                data.vertCount = an.vertCount;
                data.bbox = an.bbox;
                data.uniqVerts = an.uniqVerts;
                data.remap = an.remap;
            }
            else
            {
                data.vertCount = Math.floor(data.positions.length / 9);
            }
        }

        var picked = this.pickColor(slot);
        var hex = picked.hex;
        var layer = {
            id: this.nextId++,
            /* 会话内唯一（树里显示为 #12）；uid 跨会话也唯一，供日志/导出引用 */
            uid: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: this.uniqueLayerName(name),
            slot: slot,
            kind: data.kind,
            data: data,
            visible: true,
            shownAt: Date.now(),      // 最近一次被启用/载入的时间，供扩展挑选当前显示的网格
            gpu: null
        };

        // 同一模型（同名同大小）在 A / B 两侧共享一份显示属性：改任一侧，另一侧同步
        var k = key || ('data:' + (data.uid || ''));
        var props = this.propsByKey[k];
        if (!props)
        {
            props = {
                color: hex,
                colorRgb: global.MV.util.hexToRgb(hex),

                /* autoColor / autoIdx：切主题时据此换到另一套色卡的同索引颜色。
                 * 用户手动改过任意一项颜色后 autoColor 置 false，整层不再自动变。 */
                autoColor: true,
                autoIdx: picked.idx,

                /* 以下几项由 applyDerivedColors() 填：线框按面片亮度，
                 * 顶点 / 边界 / 法向是固定的标注色（深浅主题一致） */
                backColor: '#6b7078',
                backColorRgb: global.MV.util.hexToRgb('#6b7078'),
                wireColor: hex,
                wireColorRgb: global.MV.util.hexToRgb(hex),
                vertColor: '#ff3df2',
                vertColorRgb: global.MV.util.hexToRgb('#ff3df2'),
                boundaryColor: '#ff2d55',
                boundaryColorRgb: global.MV.util.hexToRgb('#ff2d55'),
                opacity: 1,
                pointSize: 3,
                // 有标量场时默认用标量场（彩虹）着色，否则单色
                pointColorMode: (data.kind === 'points' && data.scalars && data.scalars.length > 0) ? 5 : 0,
                sfIndex: 0,
                sfMin: null,
                sfMax: null,
                sfRamp: 0,
                shadeMode: 1,
                showFaces: true,
                showWire: false,
                showVerts: false,
                showBoundary: false,
                showNormals: false,
                normalLen: 1
            };

            applyDerivedColors(props, hex, !!this.settings.themeLight);

            this.propsByKey[k] = props;
        }

        layer.propsKey = k;   // 供移除图层时判断共享属性是否还需保留

        for (var i = 0; i < LINK_KEYS.length; i++)
        {
            (function (propKey)
            {
                Object.defineProperty(layer, propKey, {
                    enumerable: true,
                    configurable: true,
                    get: function () { return props[propKey]; },
                    set: function (v) { props[propKey] = v; }
                });
            })(LINK_KEYS[i]);
        }

        return layer;
    };

    /* 左右相机同步：开启时两个视图共用同一个相机对象，任何操作天然一致；关闭时拆回独立对象 */
    App.prototype.setSyncCamera = function (on)
    {
        this.settings.syncCam = !!on;
        var vi = this.lastActiveView >= 0 ? this.lastActiveView : 0;
        if (on)
        {
            var shared = this.views[vi].camera;
            this.views[0].camera = shared;
            this.views[1].camera = shared;
        }
        else
        {
            var c0 = this.views[0].camera;
            var Ctor = global.MV.math.OrbitCamera;
            this.views[1].camera = new Ctor();
            this.views[1].camera.copyFrom(c0);
        }
        this.markDirty();
    };

    App.prototype.getSelected = function ()
    {
        for (var i = 0; i < this.layers.length; i++)
        {
            if (this.layers[i].id === this.selectedId)
            {
                return this.layers[i];
            }
        }
        return null;
    };

    App.prototype.selectLayer = function (id)
    {
        this.clearVertexPreview();
        this.selectedId = id;
        global.MV.ui.refreshUI();
    };

    App.prototype.removeLayer = function (id)
    {
        // 收集目标层及其所有后代（结果图层挂在源图层下面）
        var targets = [id];
        for (var t = 0; t < targets.length; t++)
        {
            for (var m = 0; m < this.layers.length; m++)
            {
                if (this.layers[m].parentId === targets[t] &&
                    targets.indexOf(this.layers[m].id) < 0)
                {
                    targets.push(this.layers[m].id);
                }
            }
        }

        var removedCount = 0;
        for (var ti = 0; ti < targets.length; ti++)
        {
            removedCount += this.removeSingleLayer(targets[ti]);
        }

        if (removedCount === 0)
        {
            return;
        }

        global.MV.ui.refreshUI();
        this.markDirty();
        global.MV.ui.setInfo('已移除 ' + removedCount + ' 个图层');
    };

    /* 删除单个图层（不刷新界面），返回删除数量 */
    App.prototype.removeSingleLayer = function (id)
    {
        var removed = null;
        var at = -1;

        for (var i = 0; i < this.layers.length; i++)
        {
            if (this.layers[i].id === id)
            {
                removed = this.layers[i];
                at = i;
                break;
            }
        }

        if (!removed)
        {
            return 0;
        }

        // 释放显存（同一文件在 A/B 两侧时按引用计数递减）
        this.renderer.releaseLayer(removed);
        this.layers.splice(at, 1);

        // 若已无其它图层使用这份共享属性，一并清理，避免下次载入同一文件沿用旧设置
        if (removed.propsKey)
        {
            var stillUsed = false;
            for (var j = 0; j < this.layers.length; j++)
            {
                if (this.layers[j].propsKey === removed.propsKey)
                {
                    stillUsed = true;
                    break;
                }
            }
            if (!stillUsed)
            {
                delete this.propsByKey[removed.propsKey];
            }
        }

        if (this.selectedId === id)
        {
            // 选中相邻的图层，避免属性面板空白
            this.selectedId = this.layers.length
                ? this.layers[Math.min(at, this.layers.length - 1)].id
                : null;
        }

        return 1;
    };


    /* 同名时自动加序号：导入两个同名文件，第二个叫「m (2)」，
     * 避免场景树里两行一模一样、只能靠颜色区分 */
    App.prototype.uniqueLayerName = function (name)
    {
        var base = String(name == null ? '' : name).trim() || 'layer';
        var used = {};
        for (var i = 0; i < this.layers.length; i++)
        {
            used[this.layers[i].name] = 1;
        }
        if (!used[base]) { return base; }

        var k = 2;
        while (used[base + ' (' + k + ')']) { k++; }
        return base + ' (' + k + ')';
    };

    /* 重命名：树里双击、右键菜单、F2 都走这里 */
    App.prototype.renameLayer = function (id, name)
    {
        var l = this.layerById(id);
        if (!l) { return false; }

        var v = String(name == null ? '' : name)
            .replace(/[\r\n\t]+/g, ' ')
            .trim()
            .slice(0, 60);

        if (!v || v === l.name) { return false; }

        var old = l.name;
        l.name = v;

        if (global.MV.ui)
        {
            global.MV.ui.refreshUI();
            /* 重名不拦，但提示一下：树里有 #id，仍然能区分 */
            var dup = false;
            for (var i = 0; i < this.layers.length; i++)
            {
                if (this.layers[i] !== l && this.layers[i].name === v) { dup = true; }
            }
            global.MV.ui.setInfo('已重命名：' + old + ' → ' + v +
                (dup ? '（存在同名图层，可用 #' + l.id + ' 区分）' : ''));
        }
        this.markDirty();
        return true;
    };

    App.prototype.layerById = function (id)
    {
        for (var i = 0; i < this.layers.length; i++)
        {
            if (this.layers[i].id === id)
            {
                return this.layers[i];
            }
        }
        return null;
    };

    function slotLabelOf(slot)
    {
        if (slot === 'A') { return '左侧 (A)'; }
        if (slot === 'B') { return '右侧 (B)'; }
        return '公共图层 (S)';
    }

    /* 移动到另一侧（A <-> B）：只改归属，几何与显存不动；子图层跟随 */
    App.prototype.moveLayerToSlot = function (id, slot)
    {
        var layer = this.layerById(id);
        if (!layer || layer.slot === slot)
        {
            return;
        }

        for (var i = 0; i < this.layers.length; i++)
        {
            if (this.layers[i].parentId === id)
            {
                this.layers[i].slot = slot;
            }
        }
        layer.slot = slot;

        global.MV.ui.refreshUI();
        this.markDirty();
        global.MV.ui.setInfo('已移动「' + layer.name + '」到 ' + slotLabelOf(slot));
    };

    /* 拷贝到另一侧：共享几何数据与显存（refs+1），显示属性为独立副本 */
    App.prototype.copyLayerToSlot = function (id, slot)
    {
        var src = this.layerById(id);
        if (!src)
        {
            return;
        }

        var copy = this.createLayer(src.name, slot, src.data,
            src.name + '|copy|' + Date.now() + '|' + Math.random());
        copy.parentId = null;

        for (var i = 0; i < LINK_KEYS.length; i++)
        {
            var k = LINK_KEYS[i];
            if (src[k] !== undefined)
            {
                copy[k] = src[k];
            }
        }

        copy.sourceFile = src.sourceFile;
        copy.sourceUrl = src.sourceUrl;
        copy.absPath = src.absPath;
        copy.isResult = src.isResult;

        if (src.gpu)
        {
            copy.gpu = src.gpu;
            src.gpu.refs = (src.gpu.refs || 1) + 1;
        }
        else
        {
            this.renderer.uploadLayer(copy);
        }

        this.layers.push(copy);
        this.selectedId = copy.id;

        global.MV.ui.refreshUI();
        this.markDirty();
        global.MV.ui.setInfo('已拷贝「' + src.name + '」到 ' + slotLabelOf(slot));
    };

    App.prototype.clearAll = function ()
    {
        if (this.layers.length === 0)
        {
            global.MV.ui.setInfo('当前没有图层可清空');
            return;
        }

        var self = this;
        global.MV.ui.showConfirm('清空全部 ' + this.layers.length +
            ' 个图层？此操作不可撤销，建议先导出需要保留的数据。', function ()
        {
            self.doClearAll();
        });
    };

    App.prototype.doClearAll = function ()
    {
        for (var i = 0; i < this.layers.length; i++)
        {
            this.renderer.releaseLayer(this.layers[i]);
        }
        this.layers = [];
        this.selectedId = null;
        this.paletteCursor = { A: 0, B: 0, S: 0 };
        this.propsByKey = {};
        global.MV.ui.refreshUI();
        document.getElementById('drop-hint').classList.remove('hidden');
        global.MV.ui.setInfo('已清空全部图层');
        this.markDirty();
    };

    App.prototype.markDirty = function ()
    {
        this.dirty = true;
    };

    /* ---------------- 包围盒 / 视图 ---------------- */
    /* 把包围盒 8 个角点按矩阵变换后重新取包络。
     * 刚体变换下「变换后包围盒」比「包围盒变换」更紧，但这里要求简单可靠，
     * 8 个角点已经足够（每帧至多几十次乘法）。 */
    function xformedBBox(bb, m)
    {
        if (!bb || !m || !bb.min || !bb.max) { return bb; }

        var mn = [Infinity, Infinity, Infinity];
        var mx = [-Infinity, -Infinity, -Infinity];

        for (var k = 0; k < 8; k++)
        {
            var x = (k & 1) ? bb.max[0] : bb.min[0];
            var y = (k & 2) ? bb.max[1] : bb.min[1];
            var z = (k & 4) ? bb.max[2] : bb.min[2];

            var tx = m[0] * x + m[1] * y + m[2] * z + m[3];
            var ty = m[4] * x + m[5] * y + m[6] * z + m[7];
            var tz = m[8] * x + m[9] * y + m[10] * z + m[11];

            if (tx < mn[0]) { mn[0] = tx; } if (tx > mx[0]) { mx[0] = tx; }
            if (ty < mn[1]) { mn[1] = ty; } if (ty > mx[1]) { mx[1] = ty; }
            if (tz < mn[2]) { mn[2] = tz; } if (tz > mx[2]) { mx[2] = tz; }
        }

        return { min: mn, max: mx };
    }

    App.prototype.computeBBox = function (slots)
    {
        // 单窗口模式下所有槽位合并显示，忽略槽位过滤
        if (this.settings.singleView)
        {
            slots = null;
        }

        var box = B.empty();
        for (var i = 0; i < this.layers.length; i++)
        {
            var l = this.layers[i];
            if (!l.visible)
            {
                continue;
            }
            if (slots && !slots[l.slot])
            {
                /* 双窗里开了「叠加对面模型」时，对面槽位的图层会以半透明画在
                 * 本视图内。既然看得见，取景就必须把它算进去 ——
                 * 否则一开叠加，对面模型整个落在画面外
                 * （实测偏出视锥 24 倍），开关看起来像没生效。
                 * 判定条件与 rayPick 里一致：ghost 不含公共层 S。 */
                var asGhost = !!(this.settings && this.settings.ghost) && l.slot !== 'S';
                if (!asGhost)
                {
                    continue;
                }
            }
            /* 预览态（配准过程中的 layer.previewMat）必须按变换后的包络参与，
             * 否则场景包围盒/适应视图仍以为它待在原位 —— 相机看着空地，
             * 而目标早就被画到几米之外，表现就是「配准过程中目标看不见」。 */
            B.merge(box, l.previewMat ? xformedBBox(l.data.bbox, l.previewMat) : l.data.bbox);
        }
        return box;
    };

    /* 适应视图：把数据投到相机坐标系，取「最值 + 中心」，就这么两步。
     *
     * 每个顶点在相机坐标系里只有三个分量：(r, u, f) = 右 / 上 / 前。
     *   · 三个分量的 min/max 就是「投影到屏幕 XY 的范围」，其中点即该对准的注视点；
     *   · 距离由逐点约束取最大：d >= f + |u| / tan(fovY/2)（水平方向同理）。
     *
     * 两遍采样（各 ≤ 10 万点）：第一遍求范围 → 移动注视点；第二遍按新注视点求距离。
     * 不迭代、不用包围盒角点、不需要收敛判断。
     *
     * onlyLayer：只算这一层（单图层「适应」用）。
     * 返回 0 表示拿不到顶点（交给包围盒兜底）。注视点在函数内一并修正。 */
    App.prototype.tightFitDistance = function (vi, slots, onlyLayer)
    {
        var v = this.views[vi];
        if (!v || !v.camera) { return 0; }

        var cam = v.camera;
        var b = cam.basis();
        var tanY = Math.tan(cam.fov * 0.5);
        if (!(tanY > 1e-6)) { return 0; }

        var tanX = tanY * ((v.rect && v.rect.h > 0) ? (v.rect.w / v.rect.h) : 1);
        var F = b.forward, U = b.up, R = b.right;

        /* 参与取景的图层 */
        var list = [];
        var totalPts = 0;
        for (var i = 0; i < this.layers.length; i++)
        {
            var l = this.layers[i];
            if (onlyLayer)
            {
                if (l !== onlyLayer) { continue; }
            }
            else
            {
                if (!l.visible) { continue; }
                if (slots && !slots[l.slot])
                {
                    /* 与 computeBBox / rayPick 一致：叠加的对面图层也算 */
                    var asGhost = !!(this.settings && this.settings.ghost) && l.slot !== 'S';
                    if (!asGhost) { continue; }
                }
            }
            if (l.data && l.data.positions && l.data.positions.length >= 3)
            {
                list.push(l);
                totalPts += Math.floor(l.data.positions.length / 3);
            }
        }
        if (!list.length) { return 0; }

        var stride = Math.max(1, Math.ceil(totalPts / 100000));

        /* 扫一遍：返回 (r,u,f) 的最值；need=true 时同时求所需距离 */
        function measure(center, need)
        {
            var u0 = Infinity, u1 = -Infinity;
            var r0 = Infinity, r1 = -Infinity;
            var f0 = Infinity, f1 = -Infinity;
            var dist = 0;
            var n = 0;

            for (var li = 0; li < list.length; li++)
            {
                var lay = list[li];
                var pos = lay.data.positions;
                var cnt = Math.floor(pos.length / 3);
                var M = lay.previewMat || null;

                for (var k = 0; k < cnt; k += stride)
                {
                    var px = pos[k * 3], py = pos[k * 3 + 1], pz = pos[k * 3 + 2];

                    if (M)
                    {
                        var qx = M[0] * px + M[1] * py + M[2] * pz + M[3];
                        var qy = M[4] * px + M[5] * py + M[6] * pz + M[7];
                        var qz = M[8] * px + M[9] * py + M[10] * pz + M[11];
                        px = qx; py = qy; pz = qz;
                    }

                    var dx = px - center[0], dy = py - center[1], dz = pz - center[2];
                    var pr = dx * R[0] + dy * R[1] + dz * R[2];
                    var pu = dx * U[0] + dy * U[1] + dz * U[2];
                    var pf = dx * F[0] + dy * F[1] + dz * F[2];

                    if (pr < r0) { r0 = pr; }
                    if (pr > r1) { r1 = pr; }
                    if (pu < u0) { u0 = pu; }
                    if (pu > u1) { u1 = pu; }
                    if (pf < f0) { f0 = pf; }
                    if (pf > f1) { f1 = pf; }

                    if (need)
                    {
                        var dv = pf + Math.abs(pu) / tanY;
                        var dh = pf + Math.abs(pr) / tanX;
                        if (dv > dist) { dist = dv; }
                        if (dh > dist) { dist = dh; }
                    }
                    n++;
                }
            }
            return { u0: u0, u1: u1, r0: r0, r1: r1, f0: f0, f1: f1, dist: dist, n: n };
        }

        /* 第一遍：求范围 → 注视点挪到范围中心 */
        var c0 = cam.target;
        var a = measure(c0, false);
        if (!a.n) { return 0; }

        var midR = (a.r0 + a.r1) / 2;
        var midU = (a.u0 + a.u1) / 2;
        var midF = (a.f0 + a.f1) / 2;

        cam.target = [
            c0[0] + R[0] * midR + U[0] * midU + F[0] * midF,
            c0[1] + R[1] * midR + U[1] * midU + F[1] * midF,
            c0[2] + R[2] * midR + U[2] * midU + F[2] * midF
        ];

        /* 第二遍：按新注视点求距离。
         * 乘 1.10：采样按步长取点，端部的极值点可能整段跳过 ——
         * 实测 46 万点按 5 取 1 时，真实极值比采样值再远约 11%，
         * 余量给小了会贴边（端部被裁）。宁可留 10%，也不要裁数据。 */
        var b2 = measure(cam.target, true);
        return b2.n ? b2.dist * 1.10 : 0;
    };

    /* slotsOverride：用别的槽位集合来定 bbox。
     * 双窗共享同一个相机，各自 fit 会互相覆盖 —— 见 mergedSlots 的说明。 */
    /* 适应视图白名单：只允许三个入口调用 fitView ——
     *   1) 导入数据到空视图   2) 双击画布空白   3) 「适应」按钮 / F 键
     * token 是模块私有的，其它代码拿不到；未授权调用一律静默返回，
     * 从机制上杜绝"开关数据/切布局/切主题时偷偷适应"这类回归。 */
    var FIT_TOKEN = {};

    App.prototype.fitView = function (vi, fitEmpty, slotsOverride, token)
    {
        if (token !== FIT_TOKEN) { return; }
        var v = this.views[vi];
        var useSlots = slotsOverride || v.slots;

        var box = this.computeBBox(useSlots);
        if (!B.valid(box))
        {
            box = this.computeBBox(useSlots, true);
        }
        if (!B.valid(box))
        {
            box = this.computeBBox(null);
        }
        if (B.valid(box))
        {
            /* 传视口宽高比：fit 要按水平/垂直两个方向分别算距离 */
            var aspFit = (v.rect && v.rect.h > 0) ? (v.rect.w / v.rect.h) : 1;
            v.camera.fit(box, aspFit);

            /* 包围盒只用来定「注视点 + min/max 距离」；真正的距离按实际顶点算，
             * 否则弧形/细长模型的空角会把画面撑开一大圈空白。 */
            var tight = this.tightFitDistance(vi, useSlots, null);
            if (tight > 0)
            {
                /* 距离已在函数内按目标占比收敛，这里不再叠边距 */
                v.camera.distance = Math.max(tight, 1e-3);
            }
            if (this.urlZoom > 0)
            {
                v.camera.distance *= this.urlZoom;
            }
            if (this.urlYaw !== null)
            {
                v.camera.yaw = this.urlYaw;
            }
            if (this.urlPitch !== null)
            {
                v.camera.pitch = this.urlPitch;
            }
            this.markDirty();
        }
        else if (fitEmpty)
        {
            v.camera.target = [0, 0, 0];
            v.camera.distance = 500;
            this.markDirty();
        }
    };

    /* 该视图当前有没有「可见图层」参与渲染。
     * 载入流程用它判断"这个视图是不是空的"——只有空视图才自动适配，
     * 已有数据的视图保持用户摆好的相机。隐藏的图层不算（它不在画面上）。 */
    App.prototype.viewHasLayers = function (vi)
    {
        var v = this.views[vi];
        if (!v || !v.slots) { return false; }

        for (var i = 0; i < this.layers.length; i++)
        {
            var L = this.layers[i];
            if (L.visible === false) { continue; }
            if (v.slots[L.slot]) { return true; }
        }
        return false;
    };

    /* 所有视图可见槽位的并集。
     *
     * **双窗共享同一个相机对象**（`camera: sharedCam`），这是"同视角对比"的设计：
     * 但正因如此，`fitView(0)` 框 A、`fitView(1)` 框 B 会互相覆盖 ——
     * 后执行的赢，结果两个窗口都只看得到最后那片数据，另一片完全不可见。
     * 实测 a/b 相距 3 米时，两个视图的相机 target 都停在 b 的位置。
     * 所以"适应"对共享相机只能做一次，且必须框住并集。 */
    App.prototype.mergedSlots = function ()
    {
        /* 单窗：A/B/S 全部在同一个视口里渲染（不在本槽的以 ghost 叠加），
         * slots 不再起过滤作用。这里必须全选 —— 否则只载入 B 槽文件时，
         * 视图 0 的 {A,S} 框不到它，画面停在默认距离，看起来像"载入失败"。 */
        if (this.settings.singleView) { return { A: true, B: true, S: true }; }

        var merged = { A: false, B: false, S: false };
        var n = this.views.length;

        for (var i = 0; i < n; i++)
        {
            var sl = this.views[i].slots;
            for (var k in sl)
            {
                if (sl[k]) { merged[k] = true; }
            }
        }
        return merged;
    };

    App.prototype.fitAll = function ()
    {
        /* 相机同步时两个视图共用同一个相机对象，「分别 fit」等于互相覆盖
         * （后执行的赢），所以并集只 fit 一次；关掉同步后各自独立，才分开 fit。 */
        if (this.settings.syncCam || this.settings.singleView)
        {
            this.fitView(0, true, this.mergedSlots(), FIT_TOKEN);
            return;
        }

        this.fitView(0, true, null, FIT_TOKEN);
        this.fitView(1, true, null, FIT_TOKEN);
    };

    /* 单窗口 / 双窗口切换：单窗口时 A/B/S 全部图层在同一个视口渲染 */
    /* 双窗分隔比例：0.5 各半，0 全给右视图，1 全给左视图。
     * 拖动分隔线时连续调用；同时把 DOM 上的分隔线挪到对应位置。 */
    /* 只把分隔线（含右侧角标）摆到当前比例对应的像素位置。
     *
     * 与 setSplitRatio 分开的原因：`splitRatio` 没变、但 `#view-area` 的宽度变了
     * 的情况很常见 —— 拖左侧栏、折叠属性面板、进出单窗都会发生。
     * 那种时候只需要挪线，不需要重算比例、也不需要再跑一遍 updateRects。 */
    App.prototype.syncSplitLine = function ()
    {
        var line = document.getElementById('split-line');
        var area = document.getElementById('view-area');
        if (!line || !area)
        {
            return;
        }

        var px = Math.round((area.clientWidth || 0) * this.settings.splitRatio);
        if (this._splitPx === px)
        {
            return;
        }

        this._splitPx = px;
        line.style.left = px + 'px';
        line.style.marginLeft = '-1px';

        /* 右侧角标的 CSS 是固定的 left: calc(50% + 12px)，
         * 分隔线一动它就跟不上了，这里同步成相对分隔线的位置 */
        var tagR = document.getElementById('tag-right');
        if (tagR) { tagR.style.left = (px + 12) + 'px'; }
    };

    App.prototype.setSplitRatio = function (ratio)
    {
        ratio = Math.max(0.02, Math.min(0.98, Number(ratio) || 0.5));
        this.settings.splitRatio = ratio;

        this.syncSplitLine();

        /* 矩形要立刻跟着变：updateRects 平时只在 resize / 切模式时调用，
         * 拖动过程中不重算的话，画面会停在旧切分上 */
        this.updateRects();
        this.markDirty();
    };

    /* 把比例缓动到目标值：拖到极限 / 退出单窗时用它产生「丝滑」的过渡。
     * 用定时器推进而不是 rAF —— 页面切到后台或被遮挡时 rAF 会被节流甚至停发，
     * 那样动画会卡在中间、回调永不触发（单窗就切不过去）。 */
    App.prototype.animateSplitRatio = function (target, ms, done)
    {
        var self = this;
        var from = this.settings.splitRatio;
        var now = function ()
        {
            return (global.performance && global.performance.now)
                ? global.performance.now() : Date.now();
        };
        var t0 = now();
        ms = ms || 180;

        if (this._splitTimer)
        {
            global.clearInterval(this._splitTimer);
            this._splitTimer = null;
        }

        this._splitTimer = global.setInterval(function ()
        {
            var k = Math.min(1, (now() - t0) / ms);
            var e = 1 - Math.pow(1 - k, 3);               // ease-out
            self.setSplitRatio(from + (target - from) * e);

            if (k >= 1)
            {
                global.clearInterval(self._splitTimer);
                self._splitTimer = null;
                if (done) { done(); }
            }
        }, 16);
    };

    /* ==========================================================================
       视角清单（多个命名视角）
       OrbitCamera 完整状态 = target(3) + distance + q(4)。
       q 是单位四元数，直接存数组即可（无万向锁、不丢滚转）。
       结构：{ active: <id>, list: [ { id, name, A:{...}, B:{...} }, ... ] }
       ========================================================================== */
    /* 视角清单只存在内存中：刷新页面即清空，不写 localStorage。
     * 这是有意的设计 —— 视角是"当下这次查看"的状态，不是用户数据；
     * 上次打开的视角在新会话里往往已经没有对应数据了，恢复它反而干扰。 */

    App.prototype.captureView = function (vi)
    {
        var c = this.views[vi] && this.views[vi].camera;
        if (!c) { return null; }
        return {
            target: [c.target[0], c.target[1], c.target[2]],
            distance: c.distance,
            q: [c.q[0], c.q[1], c.q[2], c.q[3]]
        };
    };

    App.prototype.restoreView = function (vi, st)
    {
        var c = this.views[vi] && this.views[vi].camera;
        if (!c || !st) { return false; }
        if (st.target && st.target.length === 3) { c.target = st.target.slice(); }
        if (st.distance > 0) { c.distance = st.distance; }
        if (st.q && st.q.length === 4) { c.q = st.q.slice(); }
        return true;
    };

    /* ---- 会话内清单（刷新即清空） ---- */
    App.prototype.getViewList = function ()
    {
        if (!this._viewList) { this._viewList = { active: '', list: [] }; }
        return this._viewList;
    };

    App.prototype.saveViewList = function (store)
    {
        this._viewList = store;
        return store;
    };

    /* 新增当前视角（快捷键 Shift+V 与菜单共用） */
    /* 自增序号：Date.now() 在同一毫秒内会给出相同值（同步连点两次就撞），
     * 加上序号并对现有清单查重，保证 id 全局唯一。 */
    var viewIdSeq = 0;

    App.prototype.addCurrentView = function (name)
    {
        var store = this.getViewList();
        var id;
        do
        {
            id = 'v' + Date.now().toString(36) + '_' + (++viewIdSeq).toString(36);
        }
        while (store.list.some(function (x) { return x.id === id; }));
        var item = {
            id: id,
            name: name || ('视角 ' + (store.list.length + 1)),
            createdAt: Date.now(),                  // 保存时刻，菜单里显示
            A: this.captureView(0),
            B: this.captureView(1)
        };
        store.list.push(item);
        store.active = id;
        this.saveViewList(store);
        if (global.MV.ui && global.MV.ui.refreshViewMenu) { global.MV.ui.refreshViewMenu(); }
        return item;
    };

    /* 切换到某个命名视角 */
    App.prototype.switchToView = function (id)
    {
        var store = this.getViewList();
        var item = null;
        for (var i = 0; i < store.list.length; i++)
        {
            if (store.list[i].id === id) { item = store.list[i]; break; }
        }
        if (!item) { return false; }
        this.restoreView(0, item.A);
        this.restoreView(1, item.B || item.A);
        store.active = id;
        this.saveViewList(store);
        this.markDirty();
        if (global.MV.ui && global.MV.ui.refreshViewMenu) { global.MV.ui.refreshViewMenu(); }
        return true;
    };

    App.prototype.deleteView = function (id)
    {
        var store = this.getViewList();
        var next = [];
        for (var i = 0; i < store.list.length; i++)
        {
            if (store.list[i].id !== id) { next.push(store.list[i]); }
        }
        store.list = next;
        if (store.active === id) { store.active = next.length ? next[0].id : ''; }
        this.saveViewList(store);
        if (global.MV.ui && global.MV.ui.refreshViewMenu) { global.MV.ui.refreshViewMenu(); }
        return true;
    };

    /* 切布局时的临时保留：同样只在内存里，页面刷新即失效 */
    App.prototype.saveViews = function ()
    {
        this._viewSession = { A: this.captureView(0), B: this.captureView(1) };
        return this._viewSession;
    };

    App.prototype.restoreSavedViews = function ()
    {
        var st = this._viewSession;
        if (!st) { return false; }
        return this.restoreView(0, st.A) && this.restoreView(1, st.B);
    };

    App.prototype.setSingleView = function (on)
    {
        on = !!on;
        if (this.settings.singleView === on)
        {
            return;
        }
        /* 切布局前记下当前视角，切完原样恢复 —— 不再无条件 fit。
         * 只有「该视图此前没有任何数据」才由调用方（导入路径）另行 fit。 */
        var beforeA = this.captureView(0);
        var beforeB = this.captureView(1);

        this.settings.singleView = on;

        var Ctor = global.MV.math.OrbitCamera;
        if (on)
        {
            // 进入单窗口：右视图相机独立出来，主相机保持原视角
            this.syncBeforeSingle = this.settings.syncCam;
            this.settings.syncCam = false;
            this.views[1].camera = new Ctor();
            this.views[1].camera.copyFrom(this.views[0].camera);
            this.restoreView(0, beforeA);
        }
        else
        {
            // 回到双窗口：右视图用进入单窗前的 B 视角（没有则继承 A）
            this.views[1].camera = new Ctor();
            this.views[1].camera.copyFrom(this.views[0].camera);
            this.restoreView(0, beforeA);
            this.restoreView(1, beforeB || beforeA);

            // 进入单窗口前是同步状态的话，退出后恢复共享相机
            if (this.syncBeforeSingle)
            {
                this.views[1].camera = this.views[0].camera;
                this.settings.syncCam = true;
            }
        }

        this.saveViews();

        if (!on)
        {
            /* 从单窗回到双窗：分隔线一律回到正中（50%），
             * 从贴边缓动展开，避免「啪」地跳出来 */
            this.setSplitRatio(0.04);
            this.animateSplitRatio(0.5, 200);
        }

        this.lastActiveView = 0;
        global.MV.ui.applyLayoutMode();
        this.markDirty();
    };

    App.prototype.focusLayer = function (id)
    {
        var layer = null;
        for (var i = 0; i < this.layers.length; i++)
        {
            if (this.layers[i].id === id)
            {
                layer = this.layers[i];
                break;
            }
        }
        if (!layer)
        {
            return;
        }
        var r0 = this.views[0].rect, r1 = this.views[1].rect;
        var a0 = (r0 && r0.h > 0) ? (r0.w / r0.h) : 1;
        var a1 = (r1 && r1.h > 0) ? (r1.w / r1.h) : 1;

        function fitOne(vi, asp)
        {
            var cam = this.views[vi].camera;
            cam.fit(layer.data.bbox, asp);
            var t = this.tightFitDistance(vi, null, layer);
            if (t > 0) { cam.distance = Math.max(t, 1e-3); }
        }

        var self2 = this;
        if (this.views[0].slots[layer.slot])
        {
            fitOne.call(self2, 0, a0);
        }
        if (this.views[1].slots[layer.slot])
        {
            fitOne.call(self2, 1, a1);
        }
        if (!this.views[0].slots[layer.slot] && !this.views[1].slots[layer.slot])
        {
            fitOne.call(self2, 0, a0);
        }
        this.markDirty();
    };

    /* ---------------- 文件载入 ---------------- */
    App.prototype.pickFiles = function (slot)
    {
        this.pendingSlot = slot;

        /* 支持 File System Access 的浏览器走 showOpenFilePicker：
         * 与拖入一致能拿到 FileSystemFileHandle，历史里就能无损重开。
         * 不支持或调用失败时退回 <input type=file>（只能靠 /locate 补路径）。 */
        if (global.showOpenFilePicker)
        {
            var self = this;
            global.showOpenFilePicker({ multiple: true })
                .then(function (handles)
                {
                    var files = [];
                    var chain = Promise.resolve();
                    for (var i = 0; i < handles.length; i++)
                    {
                        (function (h)
                        {
                            chain = chain.then(function () { return h.getFile(); })
                                .then(function (f)
                                {
                                    files.push(f);
                                    if (global.MV.ui.setHandleOf) { global.MV.ui.setHandleOf(f, h); }
                                });
                        })(handles[i]);
                    }
                    return chain.then(function ()
                    {
                        if (files.length) { return self.addFiles(files, slot); }
                    });
                })
                .catch(function (err)
                {
                    if (err && err.name === 'AbortError') { return; }   // 用户取消
                    document.getElementById('file-input').click();
                });
            return;
        }

        document.getElementById('file-input').click();
    };

    App.prototype.addFiles = async function (files, slotMode)
    {
        if (!files || files.length === 0 || this.loading)
        {
            return;
        }
        this.loading = true;
        this._abortLoad = false;

        // 单窗模式没有左右之分：所有导入统一进公共槽位 S，
        // 避免 BOTH 被展开成 A/B 两份、在树里变成两个图层。
        if (this.settings.singleView)
        {
            slotMode = 'S';
        }

        for (var i = 0; i < files.length; i++)
        {
            var file = files[i];
            var slots = slotMode === 'BOTH' ? ['A', 'B'] : [slotMode || 'A'];

            try
            {
                // 载入前评估内存/显存：超预算则弹窗让用户选择下采样比例
                var guard = { opts: {}, cancel: false };
                if (global.MV.memguard)
                {
                    guard = await this.guardFile(file);
                }
                if (guard.cancel)
                {
                    global.MV.ui.setInfo('已取消载入：' + file.name, false, 'warn');
                    continue;
                }
                if (guard.pct)
                {
                    global.MV.ui.setInfo('按 ' + guard.pct + '% 下采样载入：' + file.name);
                }
                await this.loadOne(file, slots, guard.opts);
            }
            catch (err)
            {
                global.MV.ui.setProgress(false, '');
                if (err && err.message === '__abort__')
                {
                    global.MV.ui.setInfo('已取消载入', false, 'warn');
                    break;
                }
                global.MV.ui.setInfo('载入失败: ' + file.name + ' — ' + err.message, false, 'fail');
                console.error(err);
            }
        }

        this.loading = false;
        global.MV.ui.setProgress(false, '');
        global.MV.ui.refreshUI();
        this.markDirty();

        // 通知扩展：加载已完成
        try
        {
            global.dispatchEvent(new global.Event('mv:loaded'));
        }
        catch (e)
        {
            /* 兼容旧浏览器 */
        }
    };

    /* 尽量补全本地文件在磁盘上的绝对路径：
       浏览器拿不到 File 的真实路径，若本机跑着 serve.py / bridge，
       就按“文件名 + 大小”在本地数据目录下反查（命中才填，静默失败） */
    App.prototype.locateSource = function (layer)
    {
        /* 只在「还没有路径」时反查。URL 载入也走这里 —— 用 ?url= 打开
         * 数据目录里的文件时，同样能补出真实路径。 */
        if (layer.absPath || !layer.sourceFile || !global.fetch)
        {
            return;
        }
        var f = layer.sourceFile;
        var base = /^https?:$/i.test(global.location.protocol) ? '' : 'http://127.0.0.1:8790';
        var url = base + '/locate?name=' + encodeURIComponent(f.name) + '&size=' + (f.size || 0);

        global.fetch(url, { cache: 'no-store' }).then(function (resp)
        {
            return resp.ok ? resp.json() : null;
        }).then(function (j)
        {
            if (j && j.path)
            {
                layer.absPath = j.path;
                if (global.MV.ui.upgradeRecentPath)
                {
                    // 让历史里那条「需重新选择」变成可按路径重开
                    global.MV.ui.upgradeRecentPath(f.name, f.size, j.path);
                }
                global.MV.ui.refreshUI();
            }
        }).catch(function ()
        {
            /* 服务未启动等情况直接忽略 */
        });
    };

    /* 载入前守卫：估算 →（超预算）弹窗 → 决策；编排职责集中在 app 层 */
    App.prototype.guardFile = async function (file)
    {
        var mg = global.MV.memguard;
        if (!mg || !mg.estimate)
        {
            return { opts: {}, cancel: false };
        }

        var est = mg.estimate(file);
        var limit = mg.budget();
        if (est.bytes <= limit)
        {
            return { opts: {}, cancel: false, est: est, limit: limit };
        }

        var ans = await global.MV.ui.askDownsample(file, est, limit);
        return mg.decide(ans, est, limit);
    };

    /* 取消正在进行的载入（Esc）：解析器是分块异步的，下一次进度回调时抛出中止信号 */
    App.prototype.cancelLoad = function ()
    {
        if (this.loading)
        {
            this._abortLoad = true;
            global.MV.ui.setInfo('正在取消载入…');
        }
    };

    App.prototype.loadOne = async function (file, slots, limitOpts)
    {
        var self = this;
        var UI = global.MV.ui;
        var tOpen = UI.nowMs();
        var dlMs = file._downloadMs || 0;
        /* 是否来自「载入 → 最近」：日志里标出来，便于区分重开与首次导入 */
        var fromRecent = !!this._recentLoading;

        /* 自动适配的判据是「**该视图**导入前是空的」，不是「全局没有图层」。
         *
         * 原来用 `this.layers.length === 0`：双窗下先载 A（视图 0 有数据）、
         * 再载 B 时全局已非空 → 视图 1 不做 fit，相机还停在 fitView 给的兜底
         * 距离（500），B 稍大或稍远就完全不在画面里 —— 用户看到的是
         * "载入成功了但什么都没有"。左右半屏分别拖放也是同一个问题。 */
        var empty0 = !this.viewHasLayers(0);
        var empty1 = !this.viewHasLayers(1);

        global.MV.ui.setProgress(true, '读取 ' + file.name, 0);

        var tParse = UI.nowMs();
        var parseOpts = {
            maxTriangles: (limitOpts && limitOpts.maxTriangles) ||
                this.urlMaxTri || global.MV.loaders.DEFAULT_MAX_TRIANGLES,
            maxPoints: (limitOpts && limitOpts.maxPoints) ||
                this.urlMaxPts || global.MV.loaders.DEFAULT_MAX_POINTS
        };
        var onParseProgress = function (frac, text)
        {
            global.MV.ui.setProgress(true, (text || '读取中') + ' · ' + file.name, frac);
        };

        /* 解析 + 预处理都在 Worker 内完成；file:// 下回退主线程 */
        var data = await self.parseInWorker(file, parseOpts, onParseProgress);
        var parsedInWorker = !!data;
        if (!data)
        {
            data = await global.MV.loaders.loadFile(file, parseOpts,
                async function (frac, text)
                {
                    if (self._abortLoad) { throw new Error('__abort__'); }
                    onParseProgress(frac, text);
                    await new Promise(function (r) { setTimeout(r, 0); });
                },
                function (info)
                {
                    if (self.noConfirmColumns)
                    {
                        return global.MV.ui.autoColumnPlan(info);
                    }
                    return global.MV.ui.showColumnDialog(info);
                });
        }

        var parseMs = UI.nowMs() - tParse;

        /* LOD 缓存：命中则跳过重新聚类简化；未命中则异步回写 */
        if (data && data.kind === 'mesh') { await self.applyLodCache(data, file); }

        if (!data)
        {
            global.MV.ui.setProgress(false, '');
            global.MV.ui.setInfo('已取消导入 ' + file.name, false, 'warn');
            this.loading = false;
            return;
        }

        /* Worker 解析时已顺带完成预处理；仅主线程回退路径才需要补做 */
        if (!parsedInWorker && data.kind === 'mesh')
        {
            var tPre = UI.nowMs();
            await self.preprocessMesh(data);
            global.MV.ui.setProgress(true, '整理 ' + file.name, 0.95);
            data.preprocessMs = UI.nowMs() - tPre;
        }

        var baseName = file.name.replace(/\.[^.]+$/, '');
        var firstLayer = null;

        for (var i = 0; i < slots.length; i++)
        {
            var layer = self.createLayer(baseName, slots[i], data, file.name + '|' + file.size);
            // 记住原始文件：供本地扩展上传原始字节
            layer.sourceFile = file;
            layer.sourceUrl = file.sourceUrl || '';   // 来源地址（?url= 载入时有值）

            /* /file?path= 这类地址的参数里就是真实绝对路径，直接落成 absPath：
             * 不必再等 /locate 去「按名字猜」，也保证了属性面板一定有路径可显示 */
            if (layer.sourceUrl)
            {
                try
                {
                    var su0 = new global.URL(layer.sourceUrl, global.location.href);
                    if (su0.pathname === '/file')
                    {
                        var pp0 = su0.searchParams.get('path');
                        if (pp0) { layer.absPath = pp0; }
                    }
                }
                catch (e0) { /* 非标准地址，忽略 */ }
            }
            // 拖入 / 选择来的文件持有一个文件句柄（浏览器不给路径，但能重开）
            layer.hasFileRef = !!(global.MV.ui.handleOf && global.MV.ui.handleOf(file));
            self.locateSource(layer);                 // 异步补全磁盘绝对路径（能查到才显示）
            if (layer.kind === 'mesh')
            {
                layer.showFaces = this.urlFaces !== false;
                layer.showWire = !!this.urlWire;
                layer.showVerts = !!this.urlVerts;
                layer.showNormals = !!this.urlNormals;
                if (this.urlShade >= 0)
                {
                    layer.shadeMode = this.urlShade;
                }
                if (this.urlBoundary)
                {
                    layer.showBoundary = true;
                }
            }
            else if (layer.kind === 'points')
            {
                if (this.urlPointColor >= 0)
                {
                    layer.pointColorMode = this.urlPointColor;
                }
                layer.sfIndex = this.urlSF || 0;
                layer.sfMin = this.urlSfMin;
                layer.sfMax = this.urlSfMax;
                layer.sfRamp = this.urlSfRamp || 0;
            }
            if (firstLayer && firstLayer.gpu)
            {
                // 同时载入两侧时共享 GPU 资源，避免显存翻倍
                layer.gpu = firstLayer.gpu;
                firstLayer.gpu.refs++;
            }
            else
            {
                self.renderer.uploadLayer(layer);
            }
            self.layers.push(layer);
            /* 拾取网格后台预建：首次点选大模型时不卡 */
            self.schedulePickGrid(layer);

        // 调试钩子：首个图层就绪时立刻执行（事件驱动，不依赖定时器）
        if (!self._dbgFired && global.MV.config)
        {
            if (global.MV.config.selone)
            {
                self._dbgFired = true;
                self.selectLayer(layer.id);
                var pcmv = (global.MV.config || {}).pcm;
                if (typeof pcmv === 'number' && pcmv >= 0)
                {
                    layer.pointColorMode = pcmv;
                }

                // 标量场范围（便于验证与分享链接）
                // 注意：不能用 init() 里的 params，这里不在其作用域
                var q = new global.URLSearchParams(global.location.search);
                function pf(k)
                {
                    var v = parseFloat(q.get(k));
                    return isFinite(v) ? v : null;
                }
                var qmin = pf('sfmin'), qmax = pf('sfmax');
                var qcmin = pf('sfcolmin'), qcmax = pf('sfcolmax');
                if (qmin !== null) { layer.sfMin = qmin; }
                if (qmax !== null) { layer.sfMax = qmax; }
                if (qcmin !== null) { layer.sfColMin = qcmin; }
                if (qcmax !== null) { layer.sfColMax = qcmax; }
                if (q.has('sfout'))
                {
                    layer.sfOutMode = parseInt(q.get('sfout'), 10) || 1;
                }

                if (global.MV.ui) { global.MV.ui.renderProps(); }
                self.markDirty();
            }
            else if (global.MV.config.preview)
            {
                self._dbgFired = true;
                self.selectedId = layer.id;
                global.MV.ui.renderTree();
                self.previewVertices(layer.id);
            }
            else if (global.MV.config.mkverts)
            {
                self._dbgFired = true;
                self.selectedId = layer.id;
                global.MV.ui.renderProps();
                self.extractVertices();
            }
        }
            if (!firstLayer)
            {
                firstLayer = layer;
            }
        }

        /* 记入载入历史：URL 来源直接记完整地址；磁盘来源先记「残条目」，
         * 等 /locate 反查到绝对路径后再升级成可重开的 path 条目。
         * 自动化场景（?demo=）不写，避免污染列表。 */
        if (global.MV.ui && global.MV.ui.pushRecent &&
            !(global.MV.config && global.MV.config.demo))
        {
            var fromHistory = self._recentLoading;
            self._recentLoading = null;

            /* 拿到句柄就存进 IndexedDB —— 句柄是对文件的真实引用，
             * 下次从历史重开时不需要路径、也不需要按文件名去猜。 */
            var fh = global.MV.ui.handleOf ? global.MV.ui.handleOf(file) : null;
            var handleId = '';
            if (fh && global.MV.ui.saveHandle)
            {
                handleId = 'h' + Date.now().toString(36) +
                    Math.random().toString(36).slice(2, 7);
                global.MV.ui.saveHandle(handleId, fh);
            }

            if (fromHistory)
            {
                // 从历史点开的：沿用原条目，别被 /file 地址覆盖成新的 url 记录
                global.MV.ui.pushRecent({
                    kind: fromHistory.kind,
                    path: fromHistory.path,
                    url: fromHistory.url,
                    handleId: fromHistory.handleId || handleId,
                    name: fromHistory.name,
                    size: fromHistory.size,
                    slot: slots[0],
                    t: Date.now()
                });
            }
            else if (handleId)
            {
                global.MV.ui.pushRecent({
                    kind: 'handle',
                    handleId: handleId,
                    name: file.name,
                    size: file.size,
                    slot: slots[0],
                    t: Date.now()
                });
            }
            else
            {
                global.MV.ui.pushRecent({
                    kind: file.sourceUrl ? 'url' : 'disk',
                    url: file.sourceUrl || '',
                    name: file.name,
                    size: file.size,
                    slot: slots[0],
                    t: Date.now()
                });
            }
        }

        if (this.selectedId === null && firstLayer)
        {
            /* 没有选中图层时，新导入的数据自动选中；
             * 已有选中项则保持不动，避免打断当前编辑/对比对象。 */
            this.selectLayer(firstLayer.id);
        }

        /* 只适配「本次之前还是空的那几个视图」：
         * 已有数据的视图不动，避免打断正在看/正在对比的画面。
         *
         * 但**相机是共享的**，所以不能分别 fit —— 用并集一次框住：
         * 双窗先载 A 再载 B 时，第二次要把 A 的范围也算进来，
         * 否则相机只框着 B，A 直接从视图里消失。 */
        /* 导入后自动适配「本次之前还是空的那几个视图」。
         *
         * 注意：这段必须保持完整的 if/else 结构。曾经为了"关闭自动适配"
         * 把它压成 `(void)empty0; (void)empty1;` 两行占位，结果 app.js
         * 解析失败（SyntaxError），MV.app 变成 undefined —— 页面能显示，
         * 但所有交互失效，连主题都切不了。 */
        if (this.settings.syncCam || this.settings.singleView)
        {
            if (empty0 || (!this.settings.singleView && empty1))
            {
                this.fitView(0, false, this.mergedSlots(), FIT_TOKEN);
            }
        }
        else
        {
            if (empty0) { this.fitView(0, false, null, FIT_TOKEN); }
            if (empty1) { this.fitView(1, false, null, FIT_TOKEN); }
        }

        document.getElementById('drop-hint').classList.add('hidden');

        var info = data.format + ' · ' +
            (data.kind === 'mesh' ? (data.count + ' 三角形') : (data.count + ' 点'));
        if (data.note)
        {
            info += ' · ' + data.note;
        }
        global.MV.ui.setInfo(file.name + ' — ' + info);

        /* 载入是唯一「进度条走完就什么都没留下」的耗时操作，
         * 这里补一条汇总：总时长 + 三段明细，方便回看换机/换数据后的差异 */
        var allMs = UI.nowMs() - tOpen + dlMs;
        var buildMs = Math.max(0, allMs - dlMs - parseMs);
        var segs = [];
        if (dlMs > 0) { segs.push('下载 ' + UI.fmtDur(dlMs)); }
        segs.push('解析 ' + UI.fmtDur(parseMs));
        segs.push('建层 ' + UI.fmtDur(buildMs));
        UI.logTiming((fromRecent ? '载入（历史）' : '载入') + ' ' + file.name,
            allMs, segs.join(' / '), true);

        await new Promise(function (r) { setTimeout(r, 0); });
    };

    /* ---------------- 截图 ---------------- */
    /* 把当前画面合成为一张可导出的位图。
     *
     * 双窗模式下两个视图之间有一条分隔线，但它是 #split-line 这个 DOM 元素，
     * 浮在 WebGL 画布之上 —— 直接 canvas.toBlob() 是截不到它的。
     * 这里先复制一份画布内容，再按视图矩形把空隙填成主题色，得到与屏幕一致的图。 */
    App.prototype.grabImage = function ()
    {
        var src = this.canvas;

        if (this.settings.singleView || !this.views || this.views.length < 2)
        {
            return src;
        }

        var r0 = this.views[0].rect;
        var r1 = this.views[1].rect;
        if (!r0 || !r1) { return src; }

        // 两个视图之间的空隙（canvas 像素）
        var gx = r0.x + r0.w;
        var gw = r1.x - gx;
        if (gw <= 0) { return src; }

        var out = document.createElement('canvas');
        out.width = src.width;
        out.height = src.height;

        var g = out.getContext('2d');
        g.drawImage(src, 0, 0);

        // 取主题里定义的分隔线颜色，保持与界面一致
        var splitColor = 'rgba(88, 166, 255, .42)';
        try
        {
            var v = global.getComputedStyle(document.documentElement)
                .getPropertyValue('--split').trim();
            if (v) { splitColor = v; }
        }
        catch (e) { /* 取不到就用默认值 */ }

        g.fillStyle = splitColor;
        g.fillRect(gx, 0, gw, src.height);

        return out;
    };

    App.prototype.screenshot = function ()
    {
        this.renderFrame();

        var stamp = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var name = 'view_' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
            '_' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + '.png';

        this.grabImage().toBlob(function (blob)
        {
            if (!blob)
            {
                global.MV.ui.setInfo('截图失败：无法生成 PNG');
                return;
            }

            // 1) 下载到浏览器默认下载目录（页面无法指定绝对路径）
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 5000);

            var msg = '已导出 ' + name + '（浏览器下载目录）';

            // 2) 同步写入系统剪贴板（需 https 或 http://localhost）
            var clip = global.navigator && global.navigator.clipboard;
            if (global.ClipboardItem && clip && clip.write)
            {
                clip.write([new global.ClipboardItem({ 'image/png': blob })]).then(function ()
                {
                    global.MV.ui.setInfo(msg + ' · 已复制到剪贴板');
                }, function ()
                {
                    global.MV.ui.setInfo(msg + ' · 剪贴板不可用（file:// 需用 serve.bat 打开）');
                });
            }
            else
            {
                global.MV.ui.setInfo(msg + ' · 当前环境不支持剪贴板');
            }
        }, 'image/png');
    };

    /* 统一的 Blob 下载：网页拿不到绝对路径，只能交给浏览器下载目录 */
    App.prototype.downloadBlob = function (blob, fileName)
    {
        var url = global.URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 5000);
    };

    /* 导出当前选中图层；fmt: raw / stl / obj / csv / xyz */
    App.prototype.exportSelected = function (fmt)
    {
        var l = this.getSelected();
        if (!l)
        {
            global.MV.ui.setInfo('先在场景树里选中一个图层');
            return false;
        }

        var E = global.MV.exporters;
        if (!E) { global.MV.ui.setInfo('导出模块未加载'); return false; }

        var blob = null;
        var fileName = '';
        var tExp = global.MV.ui.nowMs();

        try
        {
            if (fmt === 'raw')
            {
                if (!l.sourceFile)
                {
                    throw new Error('该图层没有原始文件（URL 载入或派生的图层）');
                }
                blob = l.sourceFile;
                fileName = l.sourceFile.name;
            }
            else if (fmt === 'stl')
            {
                blob = E.stlBinary(l.data);
                fileName = this.exportName(l, 'stl');
            }
            else if (fmt === 'obj')
            {
                blob = E.objText(l.data);
                fileName = this.exportName(l, 'obj');
            }
            else if (fmt === 'csv')
            {
                blob = E.pointsText(l.data, ',', true);
                fileName = this.exportName(l, 'csv');
            }
            else if (fmt === 'xyz')
            {
                blob = E.pointsText(l.data, ' ', false);
                fileName = this.exportName(l, 'xyz');
            }
            else if (fmt === 'ply')
            {
                blob = E.ply(l.data);
                fileName = this.exportName(l, 'ply');
            }
            else if (fmt === 'pcd')
            {
                blob = E.pcd(l.data);
                fileName = this.exportName(l, 'pcd');
            }
            else if (fmt === 'glb')
            {
                blob = E.glb(l.data);
                fileName = this.exportName(l, 'glb');
            }
            else
            {
                throw new Error('未知的导出格式');
            }
        }
        catch (err)
        {
            global.MV.ui.setInfo('导出失败：' + err.message, false, 'fail');
            return false;
        }

        this.downloadBlob(blob, fileName);
        global.MV.ui.setInfo('已导出 ' + fileName + '（浏览器下载目录）');
        global.MV.ui.logTiming('导出 ' + fmt.toUpperCase(), global.MV.ui.nowMs() - tExp,
            global.MV.memguard ? global.MV.memguard.fmtBytes(blob.size) : (blob.size + ' B'));
        return true;
    };

    /* 用图层名做文件名：去掉路径分隔符等非法字符 */
    App.prototype.exportName = function (layer, ext)
    {
        var base = String(layer.name || 'layer')
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, '_')
            .replace(/\.[^.]*$/, '');

        return (base || 'layer') + '.' + ext;
    };

    /* 恢复默认朝向（回到初始的斜 45° 俯视） */
    App.prototype.resetView = function ()
    {
        var vi = this.settings.singleView ? 0 : (this.lastActiveView >= 0 ? this.lastActiveView : 0);
        var cams = this.settings.syncCam ? [this.views[0].camera] : [this.views[vi].camera];
        for (var i = 0; i < cams.length; i++)
        {
            cams[i].setOrientation(-Math.PI * 0.25, 0.55);
        }
        this.markDirty();
        global.MV.ui.setInfo('已恢复默认视角');
    };

    /* 凸多边形法向（Newell 法，对含共线点的面也稳定） */
    /* ---------------- 渲染 ---------------- */
    App.prototype.buildContext = function ()
    {
        var ctx = {
            dpr: this.dpr,
            settings: this.settings,
            views: []
        };
        // 全场景包围盒：地面网格与坐标轴统一按它生成，两视图尺寸一致
        ctx.sceneBBox = this.computeBBox(null);

        if (this.settings.singleView)
        {
            var single = [];
            for (var si = 0; si < this.layers.length; si++)
            {
                var sl = this.layers[si];
                if (sl.visible)
                {
                    single.push({ layer: sl, ghost: false });
                }
            }
            var sr = this.views[0].rect;
            ctx.views.push({
                x: sr.x,
                y: sr.y,
                w: sr.w,
                h: sr.h,
                camera: this.views[0].camera,
                layers: single,
                bbox: this.computeBBox(null)
            });
            return ctx;
        }

        for (var vi = 0; vi < this.views.length; vi++)
        {
            var v = this.views[vi];
            var list = [];

            // 绘制顺序很重要：depthFunc 是 LEQUAL，同深度的后画者覆盖先画者。
            // 因此先推 ghost（对面模型），再推本视图主图 —— 保证每窗的主图始终压在叠加层之上。
            // 两窗的「主图」本身不同（左 A / 右 B），所以两个列表的内容顺序天然相反。
            var li, l;

            // 第一轮：叠加的对面模型
            for (li = 0; li < this.layers.length; li++)
            {
                l = this.layers[li];
                if (!l.visible || v.slots[l.slot])
                {
                    continue;
                }
                if (this.settings.ghost && l.slot !== 'S')
                {
                    list.push({ layer: l, ghost: true });
                }
            }

            // 第二轮：本视图主图（后画 = 在上）
            for (li = 0; li < this.layers.length; li++)
            {
                l = this.layers[li];
                if (l.visible && v.slots[l.slot])
                {
                    list.push({ layer: l, ghost: false });
                }
            }

            ctx.views.push({
                x: v.rect.x,
                y: v.rect.y,
                w: v.rect.w,
                h: v.rect.h,
                camera: v.camera,
                layers: list,
                bbox: this.computeBBox(v.slots)
            });
        }
        return ctx;
    };

    /* 兜底自愈：任何图层缺 bbox 都就地补算。
     * 渲染、拾取、视锥剔除、适应视图都依赖它；缺一个就会让整帧抛错，
     * 画面冻结在上一帧 —— 从现象上看就是"某个图层怎么都不显示"。 */
    App.prototype.healBBoxes = function ()
    {
        var fixed = 0;

        for (var i = 0; i < this.layers.length; i++)
        {
            var L = this.layers[i];
            var d = L ? L.data : null;
            if (!d || !d.positions || d.positions.length < 3) { continue; }

            if (d.bbox && d.bbox.min && d.bbox.max && isFinite(d.bbox.min[0])) { continue; }

            var mnx = Infinity, mny = Infinity, mnz = Infinity;
            var mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
            var p = d.positions;

            for (var k = 0; k < p.length; k += 3)
            {
                var x = p[k], y = p[k + 1], z = p[k + 2];
                if (x < mnx) { mnx = x; }
                if (y < mny) { mny = y; }
                if (z < mnz) { mnz = z; }
                if (x > mxx) { mxx = x; }
                if (y > mxy) { mxy = y; }
                if (z > mxz) { mxz = z; }
            }

            if (isFinite(mnx))
            {
                d.bbox = { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] };
                fixed++;
            }
        }
        return fixed;
    };

    App.prototype.renderFrame = function ()
    {
        /* resize() 会同步调用这里补画，而 tick 里也会调 —— 加一层重入保护，
         * 避免极端时序下同一帧被绘制两次（也顺带防止将来互相调用成环）。 */
        if (this._inFrame) { return; }
        this._inFrame = true;
        try { this.renderFrameInner(); }
        finally { this._inFrame = false; }

        /* 比例尺跟着视口走：相机移动、分栏拖动、窗口缩放都会经过这里 */
        this.updateScaleHud();
    };

    /* 取 1 / 2 / 5 × 10^n 里最接近 v 的那个，用作"整"刻度值 */
    function niceLength(v)
    {
        if (!(v > 0) || !isFinite(v)) { return 0; }
        var e = Math.floor(Math.log(v) / Math.LN10);
        var base = Math.pow(10, e);
        var f = v / base;
        var m = (f < 1.5) ? 1 : (f < 3.5) ? 2 : (f < 7.5) ? 5 : 10;
        return m * base;
    }

    /* 刻度文字：避免出现 1.0000001 这类小数尾巴 */
    function fmtScaleLen(v)
    {
        if (v >= 100) { return String(Math.round(v)); }
        if (v >= 10) { return String(Math.round(v * 10) / 10); }
        if (v >= 1) { return String(Math.round(v * 100) / 100); }
        if (v >= 0.01) { return String(Math.round(v * 1000) / 1000); }
        return v.toExponential(1);
    }

    /* 亮出「像素尺寸」，3 秒后淡出。
     *
     * 只在**视口尺寸真正变化**时调用（resize）。到期判断放在每帧的
     * updateScaleHud 里做，用时间戳而不是 setTimeout：
     *   - resize 会连续触发（拖分栏、窗口缩放），定时器会被反复重置；
     *   - 页面在后台时 setTimeout 可能被节流，时间戳不受影响。
     * 旋转 / 缩放不改变视口尺寸，因此不会打扰。 */
    App.prototype.flashPixelSize = function ()
    {
        if (!this._hud) { return; }

        var until = Date.now() + 3000;
        for (var i = 0; i < this._hud.length; i++)
        {
            var h = this._hud[i];
            if (!h || !h.px) { continue; }
            h.pxUntil = until;
            h.px.classList.remove('is-off');
        }
    };

    /* 视口尺寸是否变了（边沿检测）。用它驱动"显示 3 秒"，而不是让 resize 去推：
     * resize / ResizeObserver 在拖拽时会高频触发，每次推 3 秒等于永远不隐藏。 */
    function sizeChanged(h, wCss, hCss)
    {
        var key = Math.round(wCss) + 'x' + Math.round(hCss);
        if (h.lastSize === key) { return false; }
        h.lastSize = key;
        return true;
    }

    /* 视口右下角：比例尺（当前缩放下 86 CSS px 对应的世界长度取整）+ 视口像素尺寸。
     * 双窗各一个、单窗只留左边那个；DOM 写入按值变化去重，避免每帧触发重排。 */
    App.prototype.updateScaleHud = function ()
    {
        if (!this._hud)
        {
            this._hud = [
                { box: document.getElementById('scale-hud-0'),
                  bar: null, label: null, px: null, last: '' },
                { box: document.getElementById('scale-hud-1'),
                  bar: null, label: null, px: null, last: '' }
            ];
            for (var k = 0; k < 2; k++)
            {
                var b = this._hud[k].box;
                if (!b) { continue; }
                this._hud[k].bar = b.querySelector('.hud-bar');
                this._hud[k].label = b.querySelector('.hud-label');
                this._hud[k].px = document.getElementById('scale-px-' + k);
            }

            /* 首次建立时亮一次，让用户知道这里有尺寸信息 */
            this.flashPixelSize();
        }

        var dpr = this.dpr || 1;

        for (var i = 0; i < 2; i++)
        {
            var h = this._hud[i];
            var v = this.views[i];
            if (!h || !h.box || !v || !v.rect || !v.camera) { continue; }

            var r = v.rect;
            /* 单窗时视图 1 的 rect 是 1×1 的占位，直接按"不可见"处理 */
            var show = (r.w > 8 && r.h > 8) && !(this.settings.singleView && i === 1);
            if (!show)
            {
                if (h.last !== 'hidden')
                {
                    h.box.classList.add('hidden');
                    if (h.px) { h.px.classList.add('hidden'); }
                    h.last = 'hidden';
                }
                continue;
            }
            h.box.classList.remove('hidden');
            var wCss = r.w / dpr;
            var hCss = r.h / dpr;

            if (h.px)
            {
                h.px.classList.remove('hidden');

                /* 视口尺寸一变就把到期时间推后 3 秒并亮起（拖分栏时持续显示） */
                if (sizeChanged(h, wCss, hCss))
                {
                    h.pxUntil = Date.now() + 3000;
                    h.px.classList.remove('is-off');
                }
                /* 到期隐藏；尺寸不再变化时 3 秒后走到这里 */
                else if (h.pxUntil && Date.now() > h.pxUntil)
                {
                    h.px.classList.add('is-off');
                    h.pxUntil = 0;
                }
            }

            /* 每 CSS 像素对应的世界长度：视口高 / (2·d·tan(fov/2))。
             * 这是垂直于视线方向的比例，对透视相机足够准；
             * 斜看时的透视缩短不参与计算，比例尺标注的是"屏幕尺度"。 */
            var cam = v.camera;
            var fov = cam.fov || 0.785;
            var pxPerUnit = hCss / (2 * Math.max(1e-6, cam.distance) * Math.tan(fov * 0.5));

            var targetPx = 86;
            var nice = niceLength(targetPx / pxPerUnit);
            var barPx = Math.max(8, Math.round(nice * pxPerUnit));

            var labelTxt = fmtScaleLen(nice);
            var pxTxt = Math.round(wCss) + ' × ' + Math.round(hCss) + ' px';

            /* 边距 14 CSS px；rect 是设备像素，换算成 CSS 像素。
             * 比例尺贴**右下**，像素尺寸贴**左下**。 */
            var barLeft = Math.round((r.x + r.w) / dpr - 14);
            var barTop = Math.round((r.y + r.h) / dpr - 14);
            var pxLeft = Math.round(r.x / dpr + 14);
            var pxTop = Math.round((r.y + r.h) / dpr - 14);

            /* 位置也纳入去重：每帧写 left/top 会触发样式重算，静止时不该有开销 */
            var key = barPx + '|' + labelTxt + '|' + pxTxt + '|' +
                      barLeft + '|' + barTop + '|' + pxLeft + '|' + pxTop;

            if (h.last !== key)
            {
                h.last = key;
                h.bar.style.width = barPx + 'px';
                h.label.textContent = labelTxt;
                h.box.style.left = barLeft + 'px';
                h.box.style.top = barTop + 'px';
                if (h.px)
                {
                    h.px.textContent = pxTxt;
                    h.px.style.left = pxLeft + 'px';
                    h.px.style.top = pxTop + 'px';
                }
            }
        }
    };

    App.prototype.renderFrameInner = function ()
    {
        // 入口处再兜一次：无论谁调用 renderFrame，缺 bbox 都不会崩
        this.healBBoxes();

        if (!this.renderer || !this.renderer.ready)
        {
            return;
        }
        var ctx = this.buildContext();
        this.renderer.render(ctx);
        this.lastStats = this.renderer.stats;

        if (this.renderer.glError && !this.glErrorShown)
        {
            this.glErrorShown = true;
            global.MV.ui.setInfo('WebGL 错误 code=0x' + this.renderer.glError.toString(16));
        }

        global.MV.ui.updateColorBar();
        this.drawAxisCube();

        if (this.debug && this.layers.length)
        {
            var l0 = this.layers[0];
            var g0 = l0.gpu || {};
            global.MV.ui.setInfo('dbg meshA=' + this.renderer.meshA.pos +
                ' lineA=' + this.renderer.lineA.pos +
                ' pointA=' + this.renderer.pointA.pos +
                ' show=' + (l0.showFaces ? 'F' : '-') + (l0.showWire ? 'W' : '-') + (l0.showVerts ? 'V' : '-') +
                ' wc=' + (g0.wireCount || 0) +
                ' vc=' + (g0.vertCount || 0) +
                ' nc=' + (g0.normalCount || 0) +
                ' idx=' + (this.renderer && this.renderer.idxOk === false ? 'BAD' : 'ok') +
                ' blocks=' + (this.lastStats.chunksDrawn || 0) + '/' + (this.lastStats.chunksTotal || 0) +
                ' calls=' + this.lastStats.meshCalls + '/' + this.lastStats.wireCalls + '/' +
                this.lastStats.vertCalls + '/' + this.lastStats.normalCalls + '/' +
                (this.lastStats.boundaryCalls || 0) +
                ' sync=' + (this.settings.syncCam ? ('v' + this.lastActiveView) : 'off') +
                ' c0=' + this.camTag(0) + ' c1=' + this.camTag(1) +
                ' err=' + (this.renderer.glError || 0));
        }
    };

    App.prototype.camTag = function (vi)
    {
        var c = this.views[vi].camera;
        return (c.yaw * 180 / Math.PI).toFixed(0) + '/' + (c.pitch * 180 / Math.PI).toFixed(0) +
            '/' + c.distance.toFixed(1);
    };

    App.prototype.tick = function (now)
    {
        requestAnimationFrame(this.tickBound);

        // 尺寸测量已改为事件驱动（window.resize / ResizeObserver）：
        // 原先每帧读 clientWidth 会强制浏览器 flush 布局，144Hz 下每秒 144 次。
        // updateRects 是纯计算，保留每帧调用以覆盖单双窗切换。
        this.updateRects();

        /* 比例尺与像素尺寸每帧都要跟上（相机移动、分栏拖动）。
         * 而且"3 秒淡出"的到期判断也在这里 —— 画面静止时 renderFrame 不跑，
         * 靠它触发就永远等不到淡出。 */
        this.updateScaleHud();

        if (this.dirty)
        {
            this.healBBoxes();
            this.renderFrame();
            this.dirty = false;

            /* 逐帧叠加层（N-N 序号标签）必须和画面同帧更新。
             *
             * 挂在这里而不是自己起 rAF/定时器：自带节流的 DOM 叠加层会落后于
             * 相机（实测 50ms 定时器在拖视角时肉眼可见地"黏"在后面），
             * 而且这一帧的相机矩阵此刻才是定稿的，投影结果与画面严格一致。 */
            if (this.onAfterRender) { this.onAfterRender(); }
        }

        this.frameCount++;
        if (now - this.fpsStamp >= 500)
        {
            this.fps = Math.round(this.frameCount * 1000 / Math.max(now - this.fpsStamp, 1));
            this.frameCount = 0;
            this.fpsStamp = now;
        }

        if (now - this.statStamp >= 400)
        {
            this.statStamp = now;
            var rs = this.renderer && this.renderer.stats;
            var detail = rs ? (' · ' + rs.chunksDrawn + '/' + rs.chunksTotal +
                ' chunks · L' + rs.lod0 + '/' + rs.lod1 + '/' + rs.lod2) : '';
            global.MV.ui.setStats(this.fps, this.layers.length, this.lastStats.triangles, this.lastStats.points, detail);
        }
    };

    /* ---------------- 交互 ---------------- */
    App.prototype.viewIndexAt = function (clientX)
    {
        if (this.settings.singleView)
        {
            return 0;
        }
        var r = this.canvas.getBoundingClientRect();
        return (clientX - r.left) < r.width * 0.5 ? 0 : 1;
    };

    /* 主题：同步 CSS（body class）与 WebGL 画布底色 */
    App.prototype.setTheme = function (light)
    {
        light = !!light;
        this.settings.themeLight = light;
        // 与 CSS 的 --bg-deep 对齐：#eef1f5 / #0d1117
        this.settings.bg = light ? [0.933, 0.945, 0.961] : [0.051, 0.067, 0.090];

        // 「背景」色板控件显示的是当前画布色，切主题时同步
        var bgInp = document.getElementById('opt-bg');
        if (bgInp)
        {
            bgInp.value = light ? '#eef1f5' : '#0d1117';
        }

        // 网格线与 ghost 叠加都是 WebGL 画的，跟着主题走
        // （浅色画布上浅灰 + 16% 透明度几乎不可见，改用更深的中灰并提高不透明度）
        if (this.renderer)
        {
            this.renderer.gridColor = light ? [0.72, 0.76, 0.82] : [0.22, 0.26, 0.32];
            this.renderer.ghostColor = light ? [0.42, 0.47, 0.55] : [0.62, 0.68, 0.78];
            this.renderer.ghostAlpha = light ? 0.26 : 0.16;
        }

        /* 图层色跟着主题走：深色的亮蓝/亮橙在白底上会发虚，
         * 由 recolorLayers 把「没被手动改过色」的图层换到另一套色卡的同索引位置。
         * 放在 applyTheme 之前 —— CSS 变量先切，图层色再跟上，避免中间态闪一下。 */
        this.recolorLayers();

        if (global.MV.ui && global.MV.ui.applyTheme)
        {
            global.MV.ui.applyTheme(light);
        }

        // 范围条 / 标量条都是 canvas，颜色写死在绘制里，切主题必须重画一遍
        if (global.MV.ui && global.MV.ui.renderProps)
        {
            global.MV.ui.renderProps();
        }
        try
        {
            global.localStorage.setItem('viewer3d.theme', light ? 'light' : 'dark');
        }
        catch (e) { /* file:// 下可能禁用 */ }

        this.markDirty();
    };

    /* 相机锁：框选过程中禁止旋转/平移/缩放，避免选区随视角漂移 */
    App.prototype.setCameraLock = function (on)
    {
        this.cameraLocked = !!on;
        if (typeof this.setPickCursor === 'function') { this.setPickCursor(on); }
    };

    App.prototype.bindPointer = function ()
    {
        var self = this;
        var canvas = this.canvas;

        canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        canvas.addEventListener('pointerdown', function (e)
        {
            if (self.cameraLocked)
            {
                return;                          // 框选中：不响应旋转/平移
            }
            if (e.button !== 0 && e.button !== 1 && e.button !== 2)
            {
                return;
            }
            var vi = self.viewIndexAt(e.clientX);
            self.lastActiveView = vi;
            self.drag = {
                vi: vi,
                mode: (e.button === 0) ? 'orbit' : 'pan',
                x: e.clientX,
                y: e.clientY,
                sx: e.clientX,
                sy: e.clientY,
                moved: 0
            };
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            canvas.classList.add('dragging');
            e.preventDefault();
        });

        canvas.addEventListener('pointermove', function (e)
        {
            var d = self.drag;
            if (!d)
            {
                return;
            }
            var dx = e.clientX - d.x;
            var dy = e.clientY - d.y;
            d.x = e.clientX;
            d.y = e.clientY;
            d.moved += Math.abs(dx) + Math.abs(dy);

            var cam = self.views[d.vi].camera;
            if (d.mode === 'orbit')
            {
                cam.orbit(dx, dy);
            }
            else
            {
                cam.pan(dx, dy, self.cssH);
            }

            self.markDirty();
        });

        function endDrag(e)
        {
            if (!self.drag)
            {
                return;
            }
            var d = self.drag;
            self.drag = null;
            canvas.classList.remove('dragging');
            try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }

            /* Ctrl + 单击，或点过「重设旋转中心」按钮后的单击：拾取表面点作为新的旋转中心。
             *
             * `suppressPick` 由上层（N-N 选点模式）设置：那时左键单击的语义是
             * "选一个配准点"，不能再顺手改旋转中心、也不能加拾取点 ——
             * 否则同一次单击会同时被两个功能接走。app 不判断 UI 的模式，
             * 只认这个开关（分层：下层提供能力，开关由上层控制）。 */
            var still = d.mode === 'orbit' && (d.moved || 0) < 5;

            /* 视口里「点中某个图层」就把它设为当前对象。
             *
             * W / N / V / B 这些快捷键原来是作用在 app.getSelected() 上的，
             * 而 getSelected() 只跟左侧树的选中项走 —— 用户在视口里对着 B 图层
             * 选点、移动之后按 W，线框却开在树里上一次选中的那个图层上，
             * 看起来像"快捷键没反应"。
             *
             * 只在「没拖动过的单击」时做，避免旋转视角时不停 raycast。 */
            if (still && self.rayPick && self.selectLayer)
            {
                var hitSel = self.rayPick(d.sx, d.sy);
                if (hitSel && hitSel.layer &&
                    (!self.getSelected || self.getSelected() !== hitSel.layer))
                {
                    self.selectLayer(hitSel.layer.id);
                }
            }
            var wantPick = (e.ctrlKey || self.pickMode) && still && !self.suppressPick;
            if (wantPick)
            {
                self.pickMode = false;
                canvas.style.cursor = '';
                self.pickTarget(d.sx, d.sy);
            }
            else if (self.pickInfo && still && !self.suppressPick)
            {
                self.addPickPoint(d.sx, d.sy);
            }
        }

        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);

        canvas.addEventListener('wheel', function (e)
        {
            if (self.cameraLocked)
            {
                e.preventDefault();
                return;                      // 框选中：不响应缩放
            }

            e.preventDefault();
            var vi = self.viewIndexAt(e.clientX);
            self.lastActiveView = vi;
            var cam = self.views[vi].camera;
            var delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
            cam.zoom(delta);
            self.markDirty();
        }, { passive: false });

        canvas.addEventListener('dblclick', function (e)
        {
            /* 拾取模式 / N-N 选点模式下双击仍作"取点"，不重设旋转中心：
             * 双击必然伴随两次单击，那两次已经各自取了一个点。 */
            if (self.pickInfo || self.suppressPick)
            {
                return;
            }

            // 双击模型表面 → 在该处重设旋转中心；双击空白 → 视图自适应
            var hit = self.rayPick ? self.rayPick(e.clientX, e.clientY) : null;
            if (hit)
            {
                self.views[self.viewIndexAt(e.clientX)].camera.target = hit.pos.slice();
                self.markDirty();
                global.MV.ui.setInfo('旋转中心已设为 (' +
                    hit.pos[0].toFixed(2) + ', ' + hit.pos[1].toFixed(2) + ', ' +
                    hit.pos[2].toFixed(2) + ')');
                return;
            }
            self.fitView(self.viewIndexAt(e.clientX), true, null, FIT_TOKEN);
        });
    };

    App.prototype.bindKeys = function ()
    {
        /* 键位表与守卫统一在 js/keys.js：这里只负责触发初始化。
         * 这里曾挂着一个 window keydown 处理 F/W/N/P/Delete/Esc，
         * 现已全部搬走，避免同一个键两处响应。 */
        if (global.MV.keys && global.MV.keys.init) { global.MV.keys.init(); }
    };


    /* ---------------- 启动 ---------------- */
    global.MV.App = App;

    // 安装下层模块提供的 App 方法（拾取 / 视角器 / 拖放）
    if (global.MV.algo && global.MV.algo.installAppMethods) { global.MV.algo.installAppMethods(); }
    if (global.MV.render && global.MV.render.installAppMethods) { global.MV.render.installAppMethods(); }
    if (global.MV.ui && global.MV.ui.installAppMethods) { global.MV.ui.installAppMethods(); }

    // 下层模块的 UI 通知钩子（分层契约：下层不直接调 MV.ui）
    var uiHooks = {
        notify: global.MV.ui.setInfo,
        refreshTree: global.MV.ui.renderTree,
        refreshProps: global.MV.ui.renderProps,
        renderPickBar: global.MV.ui.renderPickBar,
        // 裁剪应用后回收源图层显存
        releaseGpu: function (layer)
        {
            if (global.MV.app && global.MV.app.renderer && layer)
            {
                global.MV.app.renderer.releaseLayer(layer);
            }
        },
        // 裁剪交互用的三件事：canvas、选择框 DOM、按钮状态 —— 都由界面层实现
        canvas: function () { return document.getElementById('gl'); },
        createOverlay: global.MV.ui.createSegOverlay,
        syncSegButtons: global.MV.ui.syncSegButtons,
        segState: global.MV.ui.updateSegBar,
        cameraLock: function (on) { global.MV.app.setCameraLock(on); }
    };
    if (global.MV.algo && global.MV.algo.bindHooks) { global.MV.algo.bindHooks(uiHooks); }
    if (global.MV.ioBindHooks) { global.MV.ioBindHooks(uiHooks); }
    if (global.MV.render && global.MV.render.bindHooks)
    {
        global.MV.render.bindHooks({
            refreshTree: global.MV.ui.renderTree, notify: global.MV.ui.setInfo,
            refreshProps: global.MV.ui.renderProps,
            invalidate: function () { if (global.MV.app) { global.MV.app.markDirty(); } } });
    }

    window.addEventListener('load', function ()
    {
        var app = new App();
        global.MV.app = app;
        app.init();

        // ?tab=view 落到视图设置 Tab（config 此时已建立）
        var cfgTab = (global.MV.config || {}).tab;
        if ((cfgTab === 'view' || cfgTab === 'props') &&
            global.MV.ui && global.MV.ui.showSideTab)
        {
            global.MV.ui.showSideTab(cfgTab);
        }

        // 恢复上次选的主题（默认深色）
        var savedTheme = null;
        try { savedTheme = global.localStorage.getItem('viewer3d.theme'); } catch (e) { /* ignore */ }
        // URL 优先：?theme=light / ?theme=dark（便于截图与分享）
        var qs = global.location.search || '';
        if (qs.indexOf('theme=light') >= 0) { savedTheme = 'light'; }
        if (qs.indexOf('theme=dark') >= 0) { savedTheme = 'dark'; }
        app.setTheme(savedTheme === 'light');

        // 裁剪交互接线：algo 只提供纯逻辑，按钮与键盘都在这里绑
        (function bindSegmentUi()
        {
            var A = global.MV.algo;
            if (!A)
            {
                return;
            }

            function on(id, fn)
            {
                var el = document.getElementById(id);
                if (el) { el.addEventListener('click', fn); }
            }

            var themeBtn = document.getElementById('btn-theme');
            if (themeBtn)
            {
                themeBtn.addEventListener('click', function ()
                {
                    app.setTheme(!app.settings.themeLight);
                });
            }

            on('btn-seg', function () { A.setMode('rect'); });
            on('seg-btn-rect', function () { A.setMode('rect'); });
            on('seg-btn-poly', function () { A.setMode('poly'); });
            on('seg-btn-preview', function () { A.togglePreview(); });
            on('seg-btn-append', function () { A.beginAppend(); });
            on('seg-btn-apply', function () { A.applySplit(); });
            on('seg-btn-undo', function () { A.undoSelection(); });
            on('seg-btn-exit', function () { A.cancelEdit(); });

            window.addEventListener('keydown', function (ev)
            {
                if (A.currentMode() && (ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z'))
                {
                    ev.preventDefault();
                    A.undoSelection();
                    return;
                }

                if (A.onKey(ev) && (ev.key === ' ' || ev.code === 'Space'))
                {
                    // 应用后把焦点从按钮挪走，避免下一次空格又触发按钮 click
                    var ae = document.activeElement;
                    if (ae && ae.blur)
                    {
                        ae.blur();
                    }
                }
            });

            if (A.demoIfRequested) { A.demoIfRequested(); }

        })();
    });

})(window);
