/* L3 算法层 | algo：纯计算
 * 允许依赖：core（MV.math）
 * 禁止依赖：GL / MV.app 状态（App 方法通过 installAppMethods 注入）
 * 内容：① 三维裁剪（框选/多边形 → 棱柱半空间）② 拾取与测量（射线求交）
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    /* ---- 分层契约：本层不直接碰 UI，通过 app 注入的 hooks 通知 ---- */
    var hooks = {
        notify: function () {},
        refreshTree: function () {},
        refreshProps: function () {},
        renderPickBar: function () {},
        releaseGpu: function () {}, // 由上层释放某图层的显存（裁剪应用后回收源图层）
        canvas: null,               // 由界面层提供，返回主 canvas
        createOverlay: null,        // 由界面层创建裁剪选择框
        syncSegButtons: null        // 由界面层同步裁剪按钮状态
    };

    function bindHooks(h)
    {
        if (!h) { return; }
        // 遍历注入对象（而不是 hooks 自身），否则新增的 hook 永远进不来
        for (var k in h)
        {
            if (typeof h[k] === 'function')
            {
                hooks[k] = h[k];
            }
        }
    }

    /* ==================== 三维裁剪（原 segment.js） ==================== */

    // ===== 功能开关：改 false 即整体关闭 =====
    var ENABLE_SEGMENT = true;
    if (!ENABLE_SEGMENT)
    {
        return;
    }

    var NS = 'http://www.w3.org/2000/svg';
    var overlay = null;
    var rectEl = null;
    var polyEl = null;

    var mode = null;          // 'rect' | 'poly' | null
    var rect = null;          // {x0,y0,x1,y1}（CSS px，相对画布左上角）
    var poly = [];            // [{x,y}] CSS px
    var dragging = false;
    var startPt = null;
    var preview = null;       // { layer, seg, rem, planes } —— planes 记录每次追加的棱柱
    var pendingAppend = false; // 等待用户框选「第二块」

    function app()
    {
        return global.MV && global.MV.app;
    }

    function say(msg)
    {
        try
        {
            hooks.notify(msg);
        }
        catch (e)
        {
            /* ignore */
        }
    }

    function toCanvasCSS(ev)
    {
        // canvas 由界面层提供（algo 不碰 DOM）
        var cv = hooks.canvas ? hooks.canvas() : null;
        if (!cv)
        {
            return { x: 0, y: 0 };
        }
        var r = cv.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function ensureOverlay()
    {
        if (overlay)
        {
            return overlay;
        }
        // 选择框由界面层创建（ui.createSegOverlay），algo 只拿引用做几何绘制
        var made = hooks.createOverlay ? hooks.createOverlay() : null;
        if (!made)
        {
            return null;
        }
        overlay = made.overlay;
        rectEl = made.rect;
        polyEl = made.poly;

        bindEvents();
        return overlay;
    }

    /* 选择框是否吃指针事件：
     *   true  → 框选中，锁住相机（事件被 overlay 接走）
     *   false → 选区已定，事件穿透到 canvas，可以自由转视角看高亮 */
    function setOverlayInteractive(on)
    {
        if (!overlay)
        {
            return;
        }
        overlay.style.pointerEvents = on ? 'auto' : 'none';
        overlay.style.cursor = on ? 'crosshair' : '';
        if (hooks.cameraLock)
        {
            hooks.cameraLock(!!on);
        }
    }

    function redrawShape()
    {
        if (!overlay)
        {
            return;
        }
        if (mode === 'rect' && rect)
        {
            var x = Math.min(rect.x0, rect.x1);
            var y = Math.min(rect.y0, rect.y1);
            rectEl.setAttribute('x', x);
            rectEl.setAttribute('y', y);
            rectEl.setAttribute('width', Math.abs(rect.x1 - rect.x0));
            rectEl.setAttribute('height', Math.abs(rect.y1 - rect.y0));
            rectEl.style.display = '';
        }
        else
        {
            rectEl.style.display = 'none';
        }

        if (mode === 'poly' && poly.length)
        {
            var pts = poly.map(function (p) { return p.x + ',' + p.y; }).join(' ');
            polyEl.setAttribute('points', pts);
            polyEl.style.display = '';
        }
        else
        {
            polyEl.style.display = 'none';
        }
    }

    /* 只清「正在拖拽的临时形状」，不动已算出的 preview
     * （preview 的清空由 setMode(null) / computePreview 的空结果 / applySplit 负责） */
    function clearShape()
    {
        rect = null;
        poly = [];
        dragging = false;
        if (rectEl) { rectEl.style.display = 'none'; }
        if (polyEl) { polyEl.style.display = 'none'; }
    }

    /* ---------------- 模式切换 ---------------- */

    function setMode(m)
    {
        // 幂等：已是目标模式则不变，避免重复点「矩形选择」清空已有选区或退出
        if (mode === m)
        {
            return;
        }
        ensureOverlay();
        mode = m;

        if (!m)
        {
            clearShape();
            preview = null;
            pendingAppend = false;
            setOverlayInteractive(false);
            var a0 = app();
            if (a0 && a0.renderer)
            {
                a0.renderer.setPreview(null);
                a0.markDirty();
            }
            syncButtons();
            return;
        }

        var a = app();
        if (!a)
        {
            return;
        }
        var layer = a.getSelected();
        if (!layer)
        {
            // 未选中时自动选中第一个可见的可裁剪图层，降低使用门槛
            // （不再要求用户先手动去场景树里点一下）
            for (var i = 0; i < a.layers.length; i++)
            {
                var cand = a.layers[i];
                if ((cand.kind === 'mesh' || cand.kind === 'points') && cand.visible !== false)
                {
                    layer = cand;
                    if (typeof a.selectLayer === 'function')
                    {
                        a.selectLayer(cand.id);
                    }
                    else
                    {
                        a.selectedId = cand.id;
                    }
                    break;
                }
            }
        }
        if (!layer)
        {
            say('请先导入要裁剪的网格或点云');
            mode = null;
            syncButtons();
            return;
        }

        clearShape();
        setOverlayInteractive(true);
        syncButtons();
        say(m === 'rect'
            ? '矩形选择：拖动框选（松手预览），再点「应用拆分」'
            : '多边形选择：单击加点，双击闭合，再点「应用拆分」（Esc 取消）');
    }

    function syncButtons()
    {
        if (hooks.syncSegButtons)
        {
            hooks.syncSegButtons(mode, !!preview);
        }
        if (hooks.segState)
        {
            hooks.segState({
                visible: !!mode,
                mode: mode,
                hasPreview: hasPreview(),
                count: selectionCount(),
                canUndo: selectionCount() > 0,
                appending: pendingAppend
            });
        }
    }

    /* ---------------- 屏幕 → 世界 ---------------- */

    function mvpOf(vi)
    {
        var a = app();
        var v = a.views[vi];
        var M = global.MV.math.Mat4;
        var vm = new Float32Array(16);
        var pm = new Float32Array(16);
        var mvp = new Float32Array(16);
        v.camera.viewMatrix(vm);
        v.camera.projMatrix(pm, v.w / Math.max(v.h, 1));
        M.multiply(mvp, pm, vm);
        return mvp;
    }

    function projectIndex(mvp, rect, pos, i, out)
    {
        var o = i * 3;
        var x = pos[o], y = pos[o + 1], z = pos[o + 2];
        var cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
        var cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
        var cz = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
        var cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
        if (!(cw > 1e-6))
        {
            return false;
        }
        out[0] = rect.x + (cx / cw * 0.5 + 0.5) * rect.w;      // 设备像素
        out[1] = rect.y + (0.5 - cy / cw * 0.5) * rect.h;
        out[2] = cz / cw;
        return true;
    }

    function insidePoly(px, py, pts)
    {
        var inside = false;
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++)
        {
            var xi = pts[i].x, yi = pts[i].y;
            var xj = pts[j].x, yj = pts[j].y;
            if (((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
            {
                inside = !inside;
            }
        }
        return inside;
    }

    /* 选择区域（CSS px）→ 统一为点数组 */
    function selPoints()
    {
        if (mode === 'rect' && rect)
        {
            var x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
            var y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
            return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
        }
        if (mode === 'poly' && poly.length >= 3)
        {
            return poly.slice();
        }
        return null;
    }

    /* 选择多边形 → 过视点的棱柱平面（内侧 = dot(n,p) <= d） */
    function prismPlanes(sel, dev, mvp)
    {
        var V = global.MV.math.Vec3;
        var a = app();
        var vi = a.lastActiveView >= 0 ? a.lastActiveView : 0;
        var cam = a.views[vi].camera;
        var rect = a.views[vi].rect;
        var dpr = a.dpr || 1;
        var eye = cam.getPosition();
        var b = cam.basis();
        var tanH = Math.tan(cam.fov * 0.5);
        var aspect = rect.w / Math.max(rect.h, 1);

        function dirOf(p)
        {
            var nx = (p.x * dpr - rect.x) / Math.max(rect.w, 1) * 2 - 1;
            var ny = 1 - (p.y * dpr - rect.y) / Math.max(rect.h, 1) * 2;
            return V.normalize([
                b.forward[0] + b.right[0] * nx * tanH * aspect + b.up[0] * ny * tanH,
                b.forward[1] + b.right[1] * nx * tanH * aspect + b.up[1] * ny * tanH,
                b.forward[2] + b.right[2] * nx * tanH * aspect + b.up[2] * ny * tanH
            ]);
        }

        var cx = 0, cy = 0;
        for (var k = 0; k < sel.length; k++)
        {
            cx += sel[k].x;
            cy += sel[k].y;
        }
        var center = dirOf({ x: cx / sel.length, y: cy / sel.length });

        var planes = [];
        for (var i = 0; i < sel.length; i++)
        {
            var d0 = dirOf(sel[i]);
            var d1 = dirOf(sel[(i + 1) % sel.length]);
            var n = V.normalize(V.cross(d0, d1));
            // 内侧判据为 dot(n,p) <= d，所以 n 必须指向多边形外侧：
            // 与“中心方向”同向时取反
            if (V.dot(n, center) > 0)
            {
                n = [-n[0], -n[1], -n[2]];
            }
            planes.push({ n: n, d: V.dot(n, eye) });
        }
        return planes;
    }

    function bboxOf(pos)
    {
        var min = [Infinity, Infinity, Infinity];
        var max = [-Infinity, -Infinity, -Infinity];
        for (var i = 0; i < pos.length; i += 3)
        {
            for (var k = 0; k < 3; k++)
            {
                var v = pos[i + k];
                if (v < min[k]) { min[k] = v; }
                if (v > max[k]) { max[k] = v; }
            }
        }
        if (!isFinite(min[0]))
        {
            return { min: [0, 0, 0], max: [0, 0, 0] };
        }
        return { min: min, max: max };
    }

    /* 网格按棱柱选区拆分：按三角形「质心」整体判定归属，不做几何切割。
     *
     * 与逐平面裁剪 + 三角化的做法不同，这里原始三角形原样复制到 seg 或 rem 一侧：
     *   - 顶点数恒等于 面数 × 3，拓扑完全不变，不会产生新的交点顶点；
     *   - 代价是选区边界以三角形为粒度（边界处整片三角形归入某一侧）。
     *
     * 判据：质心对所有平面都满足 n·v <= d 即视为落在选区内。
     * 面片与选区判定所需的平面表示与点云拆分（splitPointsByPlanes）一致。 */
    function splitMesh(layer, planes)
    {
        var pos = layer.data.positions;
        var tri = Math.floor(pos.length / 9);
        var segOut = [];
        var remOut = [];
        var np = planes.length;

        for (var t = 0; t < tri; t++)
        {
            var o = t * 9;

            // 质心
            var cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
            var cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
            var cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;

            var inside = true;
            for (var p = 0; p < np; p++)
            {
                var nm = planes[p].n;
                if (nm[0] * cx + nm[1] * cy + nm[2] * cz > planes[p].d)
                {
                    inside = false;
                    break;
                }
            }

            var dst = inside ? segOut : remOut;
            dst.push(pos[o], pos[o + 1], pos[o + 2],
                     pos[o + 3], pos[o + 4], pos[o + 5],
                     pos[o + 6], pos[o + 7], pos[o + 8]);
        }

        return {
            seg: {
                kind: 'mesh',
                positions: new Float32Array(segOut),
                count: segOut.length / 9,
                format: layer.data.format || 'MESH'
            },
            rem: {
                kind: 'mesh',
                positions: new Float32Array(remOut),
                count: remOut.length / 9,
                format: layer.data.format || 'MESH'
            }
        };
    }

    function subPoints(d, idx)
    {
        var n = idx.length;
        var out = {
            kind: 'points',
            count: n,
            format: d.format || 'POINTS'
        };
        var p = new Float32Array(n * 3);
        for (var i = 0; i < n; i++)
        {
            var s = idx[i] * 3;
            p[i * 3] = d.positions[s];
            p[i * 3 + 1] = d.positions[s + 1];
            p[i * 3 + 2] = d.positions[s + 2];
        }
        out.positions = p;

        if (d.normals)
        {
            var nm = new Float32Array(n * 3);
            for (var j = 0; j < n; j++)
            {
                var q = idx[j] * 3;
                nm[j * 3] = d.normals[q];
                nm[j * 3 + 1] = d.normals[q + 1];
                nm[j * 3 + 2] = d.normals[q + 2];
            }
            out.normals = nm;
        }
        if (d.tags)
        {
            var tg = new Float32Array(n);
            for (var k = 0; k < n; k++)
            {
                tg[k] = d.tags[idx[k]];
            }
            out.tags = tg;
        }
        if (d.scalars && d.scalars.length)
        {
            out.scalars = [];
            for (var si = 0; si < d.scalars.length; si++)
            {
                var src = d.scalars[si];
                var vals = new Float32Array(n);
                for (var m = 0; m < n; m++)
                {
                    vals[m] = src.values[idx[m]];
                }
                var mn = Infinity;
                var mx = -Infinity;
                for (var m2 = 0; m2 < n; m2++)
                {
                    if (vals[m2] < mn) { mn = vals[m2]; }
                    if (vals[m2] > mx) { mx = vals[m2]; }
                }
                if (!isFinite(mn)) { mn = 0; }
                if (!isFinite(mx)) { mx = mn + 1; }
                out.scalars.push({ name: src.name, values: vals, min: mn, max: mx });
            }
        }
        out.bbox = bboxOf(out.positions);
        return out;
    }

    /* 按棱柱半空间分类点（与网格共用同一套平面，避免屏幕投影误差） */
    function splitPointsByPlanes(layer, planes)
    {
        var d = layer.data;
        var pos = d.positions;
        var n = d.count || Math.floor(pos.length / 3);
        var segIdx = [];
        var remIdx = [];

        for (var i = 0; i < n; i++)
        {
            var x = pos[i * 3];
            var y = pos[i * 3 + 1];
            var z = pos[i * 3 + 2];
            var inside = true;

            for (var p = 0; p < planes.length; p++)
            {
                var nm = planes[p].n;
                if (nm[0] * x + nm[1] * y + nm[2] * z > planes[p].d)
                {
                    inside = false;
                    break;
                }
            }
            (inside ? segIdx : remIdx).push(i);
        }

        return { seg: subPoints(d, segIdx), rem: subPoints(d, remIdx) };
    }

    /* ---------------- 预览 ---------------- */

    function computePreview()
    {
        if (pendingAppend)
        {
            doAppend();
            return;
        }

        var a = app();
        var layer = a.getSelected();
        if (!layer)
        {
            say('请先选中要编辑的图层');
            return;
        }

        var sel = selPoints();
        if (!sel)
        {
            say('选区太小或未完成');
            return;
        }

        var vi = a.lastActiveView >= 0 ? a.lastActiveView : 0;
        var v = a.views[vi];
        var mvp = mvpOf(vi);
        var dpr = a.dpr || 1;

        var res;
        var planes = prismPlanes(sel, null, mvp);
        if (layer.kind === 'mesh')
        {
            res = splitMesh(layer, planes);
        }
        else
        {
            res = splitPointsByPlanes(layer, planes);
        }

        if (!res.seg.positions.length)
        {
            say('选区内没有数据，请重新框选');
            a.renderer.setPreview(null);
            a.markDirty();
            preview = null;
            syncButtons();
            return;
        }

        preview = { layer: layer, seg: res.seg, rem: res.rem, planes: [planes] };

        // 点云：预览只用状态栏数字，不做 GPU 高亮（点云预览与属性状态易冲突）
        refreshPreviewVisual();

        // 选区已确定：框不再需要（高亮已经表达了范围），清掉屏幕空间的矩形/多边形
        clearShape();
        // 解锁相机，允许转动查看高亮
        setOverlayInteractive(false);
        syncButtons();

        var segCount = res.seg.positions.length / 3;
        var remCount = res.rem.positions.length / 3;
        say('预览：选区 ' + (res.seg.kind === 'mesh'
            ? (segCount / 3).toFixed(0) + ' 面'
            : segCount + ' 点') +
            '，剩余 ' + (res.seg.kind === 'mesh'
                ? (remCount / 3).toFixed(0) + ' 面'
                : remCount + ' 点') +
            ' — 点「应用拆分」生成图层');
    }

    /* ---------------- 追加选区 / 撤销 ---------------- */

    /* 两个 mesh 顶点数组拼接（seg 累积用） */
    function concatMesh(a, b)
    {
        var n1 = a.positions.length;
        var n2 = b.positions.length;
        var out = new Float32Array(n1 + n2);
        out.set(a.positions, 0);
        out.set(b.positions, n1);
        return {
            kind: 'mesh',
            positions: out,
            count: (n1 + n2) / 9,
            format: a.format || b.format || 'MESH'
        };
    }

    function hasPreview()
    {
        return !!(preview && preview.seg && preview.seg.positions.length);
    }

    /* 预览高亮的显示开关（编辑栏上的「预览」按钮） */
    var previewVisible = true;

    /* 所有预览高亮的刷新都走这里，保证「隐藏」状态下不会被其它操作意外点亮 */
    function refreshPreviewVisual()
    {
        var a = app();
        if (!a || !a.renderer)
        {
            return;
        }
        if (previewVisible && preview && preview.seg &&
            preview.seg.positions && preview.seg.positions.length)
        {
            var L = preview.layer || {};
            a.renderer.setPreview({
                kind: preview.seg.kind,
                positions: preview.seg.positions,
                seg: preview.seg,
                rem: preview.rem,
                layerId: L.id,
                color: L.colorRgb,
                backColor: L.backColorRgb,
                shade: L.shadeMode
            });
        }
        else
        {
            a.renderer.setPreview(null);
        }
        a.markDirty();
    }

    function togglePreview()
    {
        previewVisible = !previewVisible;
        refreshPreviewVisual();
        syncButtons();
        say(previewVisible ? '预览：显示' : '预览：已隐藏');
    }

    function selectionCount()
    {
        return preview && preview.planes ? preview.planes.length : 0;
    }

    /* 「继续裁剪」：进入等待第二次框选的状态（不动当前选区） */
    function beginAppend()
    {
        if (!preview)
        {
            say('请先框选一块，再点「继续裁剪」');
            return;
        }
        if (preview.layer.kind !== 'mesh')
        {
            say('点云暂不支持追加选区，请应用后重新框选');
            return;
        }

        pendingAppend = true;
        clearShape();
        setOverlayInteractive(true);     // 追加时重新锁相机等第二次框选
        syncButtons();
        say('追加选区：再框一块，会并入当前选区（重叠部分不重复计入）');
    }

    /* 真正追加：只对「剩余部分」再裁，天然不会重复 */
    function doAppend()
    {
        var a = app();
        var sel = selPoints();
        if (!sel)
        {
            say('选区太小或未完成');
            pendingAppend = false;
            syncButtons();
            return;
        }

        var vi = a.lastActiveView >= 0 ? a.lastActiveView : 0;
        var mvp = mvpOf(vi);
        var planes = prismPlanes(sel, null, mvp);

        var pseudo = {
            kind: 'mesh',
            data: { positions: preview.rem.positions, format: preview.layer.data.format }
        };
        var r = splitMesh(pseudo, planes);

        pendingAppend = false;

        if (!r.seg.positions.length)
        {
            say('追加区域内没有数据，选区保持 ' + selectionCount() + ' 块');
            syncButtons();
            return;
        }

        preview.seg = concatMesh(preview.seg, r.seg);
        preview.rem = r.rem;
        preview.planes.push(planes);

        refreshPreviewVisual();
        clearShape();
        setOverlayInteractive(false);
        syncButtons();
        say('已追加：选区 ' + (preview.seg.positions.length / 9).toFixed(0) +
            ' 面（' + preview.planes.length + ' 块）');
    }

    /* 撤销一步：弹出最后一个平面，从原始数据重放剩下的 */
    function undoSelection()
    {
        if (!preview || !preview.planes || !preview.planes.length)
        {
            return;
        }

        preview.planes.pop();
        pendingAppend = false;

        var layer = preview.layer;
        var seg = null;
        var rem = { positions: layer.data.positions };

        for (var i = 0; i < preview.planes.length; i++)
        {
            var r = splitMesh({
                kind: 'mesh',
                data: { positions: rem.positions, format: layer.data.format }
            }, preview.planes[i]);
            seg = seg ? concatMesh(seg, r.seg) : r.seg;
            rem = r.rem;
        }

        var a = app();
        if (!seg)
        {
            preview = null;
            a.renderer.setPreview(null);
            a.markDirty();
            syncButtons();
            say('已撤销到空选区');
            return;
        }

        preview.seg = seg;
        preview.rem = rem;
        refreshPreviewVisual();
        syncButtons();
        say('已撤销一步，剩 ' + preview.planes.length + ' 块 · ' +
            (seg.positions.length / 9).toFixed(0) + ' 面');
    }

    /* ---------------- 应用 ---------------- */

    function applySplit()
    {
        var tSplit = global.MV.ui.nowMs();
        if (!preview)
        {
            say('还没有可应用的预览');
            return;
        }

        var a = app();
        var src = preview.layer;
        var seg = preview.seg;
        var rem = preview.rem;

        if (!seg.positions.length || !rem.positions.length)
        {
            say('拆分结果为空，请调整选区');
            return;
        }

        seg.bbox = bboxOf(seg.positions);
        rem.bbox = bboxOf(rem.positions);

        var key = src.name + '|' + Date.now();
        var lSeg = a.createLayer(src.name + '_segmented', src.slot, seg, key + '|seg');
        var lRem = a.createLayer(src.name + '_remaining', src.slot, rem, key + '|rem');
        lSeg.parentId = src.id;      // 结果挂到源图层的下一级
        lRem.parentId = src.id;

        a.renderer.uploadLayer(lSeg);
        a.renderer.uploadLayer(lRem);
        a.layers.push(lSeg);
        a.layers.push(lRem);

        src.visible = false;

        // 源图层已隐藏且不再参与渲染：释放其显存（data 仍在内存，重新勾选会自动重建）
        if (hooks.releaseGpu) { hooks.releaseGpu(src); }

        a.selectedId = lSeg.id;
        a.renderer.setPreview(null);
        preview = null;
        pendingAppend = false;
        setOverlayInteractive(false);

        hooks.refreshTree();
        hooks.refreshProps();
        a.markDirty();
        setMode(null);
        say('已拆分：' + lSeg.name + ' / ' + lRem.name + '（原图层已隐藏）');

        var totalV = seg.positions.length + rem.positions.length;
        var keepPct = totalV > 0 ? Math.round(seg.positions.length * 100 / totalV) : 0;
        global.MV.ui.logTiming('裁剪拆分', global.MV.ui.nowMs() - tSplit, '保留 ' + keepPct + '%');
    }

    /* ---------------- 事件 ---------------- */

    function bindEvents()
    {
        overlay.addEventListener('pointerdown', function (ev)
        {
            if (!mode)
            {
                return;
            }
            ev.preventDefault();
            var p = toCanvasCSS(ev);

            if (mode === 'rect')
            {
                dragging = true;
                startPt = p;
                rect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
                redrawShape();
            }
            else
            {
                poly.push(p);
                redrawShape();
            }
        });

        overlay.addEventListener('pointermove', function (ev)
        {
            if (mode !== 'rect' || !dragging || !rect)
            {
                return;
            }
            var p = toCanvasCSS(ev);
            rect.x1 = p.x;
            rect.y1 = p.y;
            redrawShape();
        });

        overlay.addEventListener('pointerup', function (ev)
        {
            if (mode !== 'rect' || !dragging)
            {
                return;
            }
            dragging = false;
            if (Math.abs(rect.x1 - rect.x0) > 3 && Math.abs(rect.y1 - rect.y0) > 3)
            {
                computePreview();
            }
            else
            {
                rect = null;
                redrawShape();
                say('框选太小，请重新拖动');
            }
        });

        overlay.addEventListener('dblclick', function (ev)
        {
            if (mode !== 'poly')
            {
                return;
            }
            ev.preventDefault();
            // 双击会产生两次 pointerdown，去掉重复点
            if (poly.length >= 2)
            {
                var a = poly[poly.length - 1];
                var b = poly[poly.length - 2];
                if (Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3)
                {
                    poly.pop();
                }
            }
            if (poly.length >= 3)
            {
                computePreview();
            }
            else
            {
                say('多边形至少需要 3 个点');
            }
        });
    }

    /* ---------------- 导出 ---------------- */

    /* 自测 / 演示：?demo=seg 自动框选模型左侧一块（&segapply=1 直接应用拆分） */
    function demoIfRequested()
    {
        var cfg = global.MV.config || {};
        if (cfg.demo !== 'seg')
        {
            return;
        }

        var tries = 0;
        function tick()
        {
            var a = app();
            var target = null;
            if (a)
            {
                for (var i = 0; i < a.layers.length; i++)
                {
                    if ((a.layers[i].kind === 'mesh' || a.layers[i].kind === 'points') &&
                        a.layers[i].visible)
                    {
                        target = a.layers[i];
                        break;
                    }
                }
            }
            var v0 = a && a.views[0];
            if (!target || !v0 || !v0.rect || !(v0.rect.w > 0) || tries++ > 60)
            {
                // 用 setTimeout 而非 rAF：无头浏览器里 rAF 可能不再推进，导致 demo 永不执行
                return global.setTimeout(tick, 16);
            }

            a.selectedId = target.id;
            hooks.refreshTree();
            hooks.refreshProps();

            setMode('rect');

            var cv = hooks.canvas ? hooks.canvas() : null;
            var w = (cv && cv.clientWidth) || 800;
            var h = (cv && cv.clientHeight) || 600;
            rect = { x0: w * 0.44, y0: h * 0.36, x1: w * 0.66, y1: h * 0.70 };
            redrawShape();
            computePreview();

            // 无头浏览器里 rAF 可能不再推进，这里主动画一帧
            try
            {
                a.renderFrame();
            }
            catch (e)
            {
                /* ignore */
            }


            if (cfg.segapply)
            {
                applySplit();
            }
        }
        global.requestAnimationFrame(tick);
    }

    /* 交互接线交给 app：这里只暴露纯逻辑入口 */
    function currentMode()
    {
        return mode;
    }

    function toggleMode(m)
    {
        setMode(mode === m ? null : m);
    }

    function cancelEdit()
    {
        setMode(null);
        say('已取消编辑');
    }

    function onKey(ev)
    {
        // 空格 = 继续选中：保留当前高亮，再框一块追加进去（与「继续裁剪」按钮一致）
        // 裁剪模式下**一律**吃掉默认行为：否则空格会触发焦点所在按钮的 click
        if ((ev.key === ' ' || ev.code === 'Space') && mode)
        {
            ev.preventDefault();
            if (preview)
            {
                beginAppend();
            }
            return true;
        }

        if (ev.key === 'Escape' && mode)
        {
            setMode(null);
            return true;
        }
        if (ev.key === 'Enter' && mode === 'poly' && poly.length >= 3)
        {
            computePreview();
            return true;
        }
        return false;
    }

    /* ==================== 拾取与测量（原 pick.js）（App 方法，由 app.js 启动时安装） ==================== */
    /* 拾取相关的 App 方法，分三组安装。
     *
     * 「安装」这一步是必要的：algo.js 在 app.js 之前加载，那时
     * global.MV.App 还不存在，无法在模块顶层直接挂原型方法。
     * 原来 13 个方法 + 4 个辅助函数全塞在一个 799 行的函数里，
     * LSP 跳不过去、git blame 一改就牵动整块，所以按职责拆开。
     * 辅助函数（rayTriangle / rayAabb / ensurePickGrid / pickCandidates）
     * 不依赖 App，已提到模块作用域。 */

function rayTriangle(ox, oy, oz, dx, dy, dz, pos, o)
{
    var ax = pos[o];
    var ay = pos[o + 1];
    var az = pos[o + 2];
    var e1x = pos[o + 3] - ax;
    var e1y = pos[o + 4] - ay;
    var e1z = pos[o + 5] - az;
    var e2x = pos[o + 6] - ax;
    var e2y = pos[o + 7] - ay;
    var e2z = pos[o + 8] - az;

    var px = dy * e2z - dz * e2y;
    var py = dz * e2x - dx * e2z;
    var pz = dx * e2y - dy * e2x;

    var det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12)
    {
        return -1;
    }
    var inv = 1 / det;

    var tx = ox - ax;
    var ty = oy - ay;
    var tz = oz - az;
    var u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1)
    {
        return -1;
    }

    var qx = ty * e1z - tz * e1y;
    var qy = tz * e1x - tx * e1z;
    var qz = tx * e1y - ty * e1x;
    var v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1)
    {
        return -1;
    }

    var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-6 ? t : -1;
}

function rayAabb(ox, oy, oz, dx, dy, dz, mnx, mny, mnz, mxx, mxy, mxz)
{
    var t0 = 0;
    var t1 = Infinity;

    function slab(o, d, lo, hi)
    {
        if (Math.abs(d) < 1e-12)
        {
            return o >= lo && o <= hi;
        }
        var a = (lo - o) / d;
        var b = (hi - o) / d;
        if (a > b) { var tmp = a; a = b; b = tmp; }
        if (a > t0) { t0 = a; }
        if (b < t1) { t1 = b; }
        return t1 >= t0;
    }

    return slab(ox, dx, mnx, mxx) && slab(oy, dy, mny, mxy) && slab(oz, dz, mnz, mxz);
}

var PICK_GRID_N = 8;

var PICK_GRID_MIN_TRIS = 4000;      // 少于这个数直接全量，构建不划算

function ensurePickGrid(layer, tri)
{
    if (layer._pickGrid && layer._pickGrid.tri === tri)
    {
        return layer._pickGrid;
    }

    var pos = layer.data.positions;
    var mnx = Infinity, mny = Infinity, mnz = Infinity;
    var mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    var i;
    for (i = 0; i < tri * 9; i += 3)
    {
        var x = pos[i], y = pos[i + 1], z = pos[i + 2];
        if (x < mnx) { mnx = x; } if (x > mxx) { mxx = x; }
        if (y < mny) { mny = y; } if (y > mxy) { mxy = y; }
        if (z < mnz) { mnz = z; } if (z > mxz) { mxz = z; }
    }

    var N = PICK_GRID_N;
    var sx = ((mxx - mnx) / N) || 1;
    var sy = ((mxy - mny) / N) || 1;
    var sz = ((mxz - mnz) / N) || 1;
    var cells = new Array(N * N * N);

    for (var t = 0; t < tri; t++)
    {
        var o = t * 9;
        var tx0 = Math.min(pos[o], pos[o + 3], pos[o + 6]);
        var tx1 = Math.max(pos[o], pos[o + 3], pos[o + 6]);
        var ty0 = Math.min(pos[o + 1], pos[o + 4], pos[o + 7]);
        var ty1 = Math.max(pos[o + 1], pos[o + 4], pos[o + 7]);
        var tz0 = Math.min(pos[o + 2], pos[o + 5], pos[o + 8]);
        var tz1 = Math.max(pos[o + 2], pos[o + 5], pos[o + 8]);

        var i0 = Math.min(N - 1, Math.max(0, Math.floor((tx0 - mnx) / sx)));
        var i1 = Math.min(N - 1, Math.max(0, Math.floor((tx1 - mnx) / sx)));
        var j0 = Math.min(N - 1, Math.max(0, Math.floor((ty0 - mny) / sy)));
        var j1 = Math.min(N - 1, Math.max(0, Math.floor((ty1 - mny) / sy)));
        var k0 = Math.min(N - 1, Math.max(0, Math.floor((tz0 - mnz) / sz)));
        var k1 = Math.min(N - 1, Math.max(0, Math.floor((tz1 - mnz) / sz)));

        for (var ci = i0; ci <= i1; ci++)
        {
            for (var cj = j0; cj <= j1; cj++)
            {
                for (var ck = k0; ck <= k1; ck++)
                {
                    var key = (ci * N + cj) * N + ck;
                    if (!cells[key]) { cells[key] = []; }
                    cells[key].push(t);
                }
            }
        }
    }

    layer._pickGrid = {
        tri: tri, N: N,
        mnx: mnx, mny: mny, mnz: mnz,
        sx: sx, sy: sy, sz: sz,
        cells: cells
    };
    return layer._pickGrid;
}

function pickCandidates(layer, eye, dir, tri)
{
    if (tri < PICK_GRID_MIN_TRIS)
    {
        return null;
    }

    var g = ensurePickGrid(layer, tri);
    var N = g.N;
    var out = [];
    var seen = null;

    for (var ci = 0; ci < N; ci++)
    {
        var x0 = g.mnx + ci * g.sx;
        for (var cj = 0; cj < N; cj++)
        {
            var y0 = g.mny + cj * g.sy;
            for (var ck = 0; ck < N; ck++)
            {
                var key = (ci * N + cj) * N + ck;
                var list = g.cells[key];
                if (!list)
                {
                    continue;
                }
                var z0 = g.mnz + ck * g.sz;
                if (!rayAabb(eye[0], eye[1], eye[2], dir[0], dir[1], dir[2],
                        x0, y0, z0, x0 + g.sx, y0 + g.sy, z0 + g.sz))
                {
                    continue;
                }
                for (var q = 0; q < list.length; q++)
                {
                    out.push(list[q]);
                }
            }
        }
    }

    // 块遍历顺序不保证深度优先，命中的三角形仍需逐个求交取最近（bestT 保证正确）
    return out;
}

    /* 射线基础：屏幕坐标与相机互转 */
    function installRayMethods()
    {
        var App = global.MV && global.MV.App;
        if (!App) { return; }

    App.prototype.worldToScreen = function (p, vi)
    {
        vi = vi || 0;
        var v = this.views && this.views[vi];
        if (!v || !v.camera) { return null; }

        var cam = v.camera;
        var rect = v.rect;
        var dpr = this.dpr || 1;
        var b = cam.basis();

        var dx = p[0] - b.eye[0];
        var dy = p[1] - b.eye[1];
        var dz = p[2] - b.eye[2];

        var zc = dx * b.forward[0] + dy * b.forward[1] + dz * b.forward[2];
        if (zc <= 1e-9) { return null; }            // 在相机背后

        var xc = dx * b.right[0] + dy * b.right[1] + dz * b.right[2];
        var yc = dx * b.up[0] + dy * b.up[1] + dz * b.up[2];

        var tanH = Math.tan(cam.fov * 0.5);
        var aspect = rect.w / Math.max(rect.h, 1);

        var px = ((xc / (zc * tanH * aspect)) + 1) / 2 * rect.w + rect.x;
        var py = (1 - (yc / (zc * tanH))) / 2 * rect.h + rect.y;

        /* 落在本视图矩形外就不返回 —— 双视图并排时，
         * 一个点只应出现在真正看得到它的那一侧。 */
        if (px < rect.x || px > rect.x + rect.w ||
            py < rect.y || py > rect.y + rect.h)
        {
            return null;
        }

        return { x: px / dpr, y: py / dpr, depth: zc };
    };

    App.prototype.rayFromScreen = function (clientX, clientY)
    {
        var V = global.MV.math.Vec3;
        var vi = this.viewIndexAt(clientX);
        var v = this.views[vi];
        var cam = v.camera;
        var rect = v.rect;
        var cr = this.canvas.getBoundingClientRect();
        var dpr = this.dpr || 1;

        var px = (clientX - cr.left) * dpr - rect.x;
        var py = (clientY - cr.top) * dpr - rect.y;
        var ndcX = px / Math.max(rect.w, 1) * 2 - 1;
        var ndcY = 1 - py / Math.max(rect.h, 1) * 2;

        // 用相机自身的基（自由旋转会带来滚转，不能再用世界 Z 求 right/up）
        var b = cam.basis();
        var tanH = Math.tan(cam.fov * 0.5);
        var aspect = rect.w / Math.max(rect.h, 1);

        return {
            eye: b.eye,
            vi: vi,
            dir: V.normalize([
                b.forward[0] + b.right[0] * ndcX * tanH * aspect + b.up[0] * ndcY * tanH,
                b.forward[1] + b.right[1] * ndcX * tanH * aspect + b.up[1] * ndcY * tanH,
                b.forward[2] + b.right[2] * ndcX * tanH * aspect + b.up[2] * ndcY * tanH
            ])
        };
    };

    }

    /* 拾取查询：按层求交、十字判定、命中信息组装 */
    function installPickQueryMethods()
    {
        var App = global.MV && global.MV.App;
        if (!App) { return; }

    App.prototype.rayPickLayer = function (clientX, clientY, layerId)
    {
        if (!this.layers || !this.layers.length) { return null; }

        var V = global.MV.math.Vec3;
        var ray = this.rayFromScreen(clientX, clientY);
        var eye = ray.eye;
        var dir = ray.dir;
        var bestT = Infinity;
        var hit = null;

        /* 当前视图能作为「主图」显示的槽位。
         * 渲染时左视图只画 A + S、右视图只画 B + S，
         * 不属于本视图的图层根本不绘制 —— 对它求交等于打向看不见的东西，
         * 拿到的 3D 点与用户视觉上的点击位置完全无关。 */
        var viL = this.viewIndexAt(clientX);
        var v = this.views && this.views[viL];

        for (var li = 0; li < this.layers.length; li++)
        {
            var l = this.layers[li];

            if (!l || l.id !== layerId) { continue; }
            if (!l.visible || !l.gpu) { continue; }
            if (v && v.slots && !(this.settings && this.settings.singleView) &&
                !v.slots[l.slot])
            {
                // 叠层例外：ghost 开启时对面槽位在本视图里也是可见的
                var asGhostL = !!(this.settings && this.settings.ghost) && l.slot !== 'S';
                if (!asGhostL) { continue; }
            }

            if (l.kind === 'mesh')
            {
                var pos = l.data.positions;
                var tri = l.gpu.triCount;
                var cand = pickCandidates(l, eye, dir, tri);
                var nCand = cand ? cand.length : tri;

                for (var ci = 0; ci < nCand; ci++)
                {
                    var t = cand ? cand[ci] : ci;
                    var o = t * 9;
                    var tt = rayTriangle(eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], pos, o);

                    if (tt > 0 && tt < bestT)
                    {
                        bestT = tt;
                        var e1 = [pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]];
                        var e2 = [pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]];

                        hit = {
                            layer: l,
                            pos: [eye[0] + dir[0] * tt, eye[1] + dir[1] * tt, eye[2] + dir[2] * tt],
                            normal: V.normalize(V.cross(e1, e2)),
                            tag: null,
                            scalars: null,
                            tri: t
                        };
                    }
                }
            }
            else
            {
                var pp = l.data.positions;
                var cnt = l.gpu.count;
                var shapeL = this.pickShape(l, viL);
                var coreL = shapeL.core;
                var armL = shapeL.arm;
                var thickL = shapeL.thick;
                var camBL = (this.views && this.views[viL])
                    ? this.views[viL].camera.basis() : null;

                var localCrossL = Infinity;
                var localTL = Infinity;
                var localPiL = -1;

                for (var pi = 0; pi < cnt; pi++)
                {
                    var ax = pp[pi * 3] - eye[0];
                    var ay = pp[pi * 3 + 1] - eye[1];
                    var az = pp[pi * 3 + 2] - eye[2];
                    var tp = ax * dir[0] + ay * dir[1] + az * dir[2];

                    /* 同 rayPick：不能用深度剪枝，否则会挤掉正中心的点 */
                    if (tp <= 0) { continue; }

                    var cx2 = ax - dir[0] * tp;
                    var cy2 = ay - dir[1] * tp;
                    var cz2 = az - dir[2] * tp;

                    var auL, avL;
                    if (camBL)
                    {
                        var duL = cx2 * camBL.right[0] + cy2 * camBL.right[1] + cz2 * camBL.right[2];
                        var dvL = cx2 * camBL.up[0] + cy2 * camBL.up[1] + cz2 * camBL.up[2];
                        auL = Math.abs(duL);
                        avL = Math.abs(dvL);
                    }
                    else
                    {
                        auL = avL = Math.sqrt(cx2 * cx2 + cy2 * cy2 + cz2 * cz2);
                    }

                    var inCoreL = (auL * auL + avL * avL) <= coreL * coreL;
                    var distCrossL;

                    if (inCoreL)
                    {
                        distCrossL = Math.sqrt(auL * auL + avL * avL);
                    }
                    else
                    {
                        if (auL > armL || avL > armL) { continue; }
                        if (auL <= thickL) { distCrossL = avL; }
                        else if (avL <= thickL) { distCrossL = auL; }
                        else { continue; }
                    }

                    if (distCrossL < localCrossL ||
                        (distCrossL === localCrossL && tp < localTL))
                    {
                        localCrossL = distCrossL;
                        localTL = tp;
                        localPiL = pi;
                    }
                }

                if (localPiL >= 0)
                {
                    bestT = localTL;
                    hit = {
                        layer: l,
                        pos: [pp[localPiL * 3], pp[localPiL * 3 + 1], pp[localPiL * 3 + 2]],
                        normal: [0, 0, 1],
                        tag: null,
                        scalars: null,
                        tri: -1
                    };
                }
            }
        }

        return hit;
    };

    App.prototype.pickShape = function (layer, vi)
    {
        /* bbox 缺失时不能用 BBox.radius(null)，那会直接抛错、
         * 让整个 rayPick 失效 —— 表现就是"完全拾取不到数据"。 */
        var bb0 = layer.data && layer.data.bbox;
        var fallbackR = (bb0 && bb0.min && bb0.max)
            ? Math.max(global.MV.math.BBox.radius(bb0) * 0.012, 1e-6)
            : 1.0;

        var v = this.views && this.views[vi];
        if (!v || !v.camera || !v.rect)
        {
            return { core: fallbackR, arm: fallbackR, thick: fallbackR, perPx: fallbackR / 8 };
        }

        var bb = layer.data.bbox;
        if (!bb || !bb.min || !bb.max)
        {
            return { core: fallbackR, arm: fallbackR, thick: fallbackR, perPx: fallbackR / 8 };
        }

        var b = v.camera.basis();
        var cx = (bb.min[0] + bb.max[0]) * 0.5 - b.eye[0];
        var cy = (bb.min[1] + bb.max[1]) * 0.5 - b.eye[1];
        var cz = (bb.min[2] + bb.max[2]) * 0.5 - b.eye[2];

        var depth = cx * b.forward[0] + cy * b.forward[1] + cz * b.forward[2];
        if (depth <= 1e-6) { depth = Math.sqrt(cx * cx + cy * cy + cz * cz); }
        if (depth <= 1e-6)
        {
            return { core: fallbackR, arm: fallbackR, thick: fallbackR, perPx: fallbackR / 8 };
        }

        var viewH = Math.max(v.rect.h / (this.dpr || 1), 1);
        var perPx = 2 * depth * Math.tan(v.camera.fov * 0.5) / viewH;

        /* 点的屏幕半径（CSS 像素）：与渲染用的是同一套换算
         *   devicePx = pointSize * pointScale * dpr
         * 拾取只看 CSS 像素，所以 dpr 不参与。 */
        var scale = (this.settings && this.settings.pointScale) || 1;
        var ptPx = (layer.pointSize || 3) * scale;
        var radiusPx = Math.max(ptPx * 0.5, 1);

        /* 吸附区 = 中心圆 + 十字臂。
         *
         * 只有十字带时，斜向偏差稍大就会落空，实际操作很难瞄准；
         * 只给圆形又会让斜向"不该吸"的点被吸进来。
         * 两者叠加：中心一圈圆形兜底（容易点中），外侧靠十字臂延伸（精确）。
         *
         *   corePx   圆形半径：至少 12px
         *   thickPx  臂半宽：  至少 6px（带宽 12px）
         *   armPx    臂半长：  至少 22px（十字总长 44px）
         * 三者都随点尺寸增长，点画得越大越容易点中。 */
        var corePx = Math.max(radiusPx + 8, 12);
        var thickPx = Math.max(radiusPx + 4, 6);
        var armPx = Math.max(radiusPx + 16, 22);

        return {
            core: perPx * corePx,
            arm: perPx * armPx,
            thick: perPx * thickPx,
            perPx: perPx
        };
    };

    App.prototype.rayPick = function (clientX, clientY)
    {
        var V = global.MV.math.Vec3;
        var ray = this.rayFromScreen(clientX, clientY);
        var eye = ray.eye;
        var dir = ray.dir;
        var bestT = Infinity;
        var hit = null;
        var viPick = this.viewIndexAt(clientX);
        var vPick = this.views && this.views[viPick];

        for (var li = 0; li < this.layers.length; li++)
        {
            var l = this.layers[li];
            if (!l.visible || !l.gpu)
            {
                continue;
            }

            /* 与渲染保持同一套可见性判断：不属于本视图槽位的图层不参与拾取，
             * 否则射线会打到"屏幕上看不见的那一层"的背面。
             *
             * 但有一个例外：开启「叠加对面模型」时，对面槽位的图层会以半透明
             * 形式画在本视图里（渲染的第一轮循环）—— 既然看得见，就必须能点。
             * 早先只判断 slots 会把这类叠层一并挡掉，表现为"明明看得到却拾取不到"。 */
            /* 单视图模式下渲染会把所有可见图层一起画（无视 slot），
             * 拾取必须跟着放开，否则 B 槽的图层"看得见却点不到"。 */
            if (vPick && vPick.slots && !(this.settings && this.settings.singleView) &&
                !vPick.slots[l.slot])
            {
                var asGhost = !!(this.settings && this.settings.ghost) && l.slot !== 'S';
                if (!asGhost)
                {
                    continue;
                }
            }

            if (l.kind === 'mesh')
            {
                var pos = l.data.positions;
                var tri = l.gpu.triCount;
                // 分块粗筛：大模型只对射线穿过的块内三角形求交
                var cand = pickCandidates(l, eye, dir, tri);
                var nCand = cand ? cand.length : tri;
                for (var ci2 = 0; ci2 < nCand; ci2++)
                {
                    var t = cand ? cand[ci2] : ci2;
                    var o = t * 9;
                    var tt = rayTriangle(eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], pos, o);
                    if (tt > 0 && tt < bestT)
                    {
                        bestT = tt;

                        // 面法向（三角形两条边的叉积）
                        var e1 = [pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]];
                        var e2 = [pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]];

                        hit = {
                            layer: l,
                            pos: [eye[0] + dir[0] * tt, eye[1] + dir[1] * tt, eye[2] + dir[2] * tt],
                            normal: V.normalize(V.cross(e1, e2)),
                            tag: null,
                            scalars: null,
                            tri: t
                        };
                    }
                }
            }
            else
            {
                var pp = l.data.positions;
                var cnt = l.gpu.count;
                var shape = this.pickShape(l, viPick);
                var coreW = shape.core;
                var armW = shape.arm;
                var thickW = shape.thick;

                /* 相机平面内的两个轴，用来把「点到射线的垂足向量」
                 * 分解成屏幕上的 (u, v) 偏移。 */
                var camB = (this.views && this.views[viPick])
                    ? this.views[viPick].camera.basis() : null;

                /* 十字形判定：落在竖臂或横臂上才算命中，
                 * 候选之间按「沿臂方向离十字中心的距离」排序 ——
                 * 正中心最近，沿臂越远越靠后；斜向超出臂宽的点不参与。 */
                var localCross = Infinity;
                var localT = Infinity;
                var localPi = -1;

                for (var pi = 0; pi < cnt; pi++)
                {
                    var ax = pp[pi * 3] - eye[0];
                    var ay = pp[pi * 3 + 1] - eye[1];
                    var az = pp[pi * 3 + 2] - eye[2];
                    var tp = ax * dir[0] + ay * dir[1] + az * dir[2];

                    /* 这里【不能】用 tp >= bestT 剪枝。
                     * bestT 是「已命中的最近深度」，而点云要选的是
                     * 「十字上离中心最近」的点 —— 后者可能比已命中的更远。
                     * 剪枝会让正中心的点被一个更近但偏心的点挤掉。 */
                    if (tp <= 0)
                    {
                        continue;
                    }
                    var ddx = ax - dir[0] * tp;
                    var ddy = ay - dir[1] * tp;
                    var ddz = az - dir[2] * tp;

                    var au, av;
                    if (camB)
                    {
                        var du = ddx * camB.right[0] + ddy * camB.right[1] + ddz * camB.right[2];
                        var dv = ddx * camB.up[0] + ddy * camB.up[1] + ddz * camB.up[2];
                        au = Math.abs(du);
                        av = Math.abs(dv);
                    }
                    else
                    {
                        au = av = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
                    }

                    /* 中心圆内：一律算命中，距离用欧氏距离；
                     * 圆外但仍落在十字臂上：按「沿臂偏移」计距离。
                     * 这样中心附近好点，稍远时十字臂还能兜住。 */
                    var inCore = (au * au + av * av) <= coreW * coreW;
                    var distCross;

                    if (inCore)
                    {
                        distCross = Math.sqrt(au * au + av * av);
                    }
                    else
                    {
                        if (au > armW || av > armW) { continue; }
                        if (au <= thickW) { distCross = av; }        // 竖臂
                        else if (av <= thickW) { distCross = au; }   // 横臂
                        else { continue; }                            // 十字之外
                    }

                    if (distCross < localCross ||
                        (distCross === localCross && tp < localT))
                    {
                        localCross = distCross;
                        localT = tp;
                        localPi = pi;
                    }
                }

                if (localPi >= 0)
                {
                    bestT = localT;
                    var d = l.data;
                    hit = {
                        layer: l,
                        pos: [pp[localPi * 3], pp[localPi * 3 + 1], pp[localPi * 3 + 2]],
                        normal: d.normals
                            ? [d.normals[localPi * 3], d.normals[localPi * 3 + 1], d.normals[localPi * 3 + 2]]
                            : null,
                        tag: (d.tags && d.tags.length > localPi) ? d.tags[localPi] : null,
                        scalars: null,
                        index: localPi
                    };

                    if (d.scalars && d.scalars.length)
                    {
                        hit.scalars = [];
                        for (var si = 0; si < d.scalars.length; si++)
                        {
                            hit.scalars.push({
                                name: d.scalars[si].name,
                                value: d.scalars[si].values[localPi]
                            });
                        }
                    }
                }
            }
        }

        return hit;
    };

    }

    /* 拾取状态：光标、模式开关、点列表、旋转中心 */
    function installPickStateMethods()
    {
        var App = global.MV && global.MV.App;
        if (!App) { return; }

    App.prototype.pickTarget = function (clientX, clientY)
    {
        var hit = this.rayPick(clientX, clientY);
        if (!hit)
        {
            hooks.notify('未拾取到数据（Ctrl + 左键单击模型，或先点「重设」）');
            return;
        }

        this.views[this.viewIndexAt(clientX)].camera.target = hit.pos.slice();
        this.markDirty();
        hooks.notify('旋转中心已设为 (' + hit.pos[0].toFixed(2) + ', ' +
            hit.pos[1].toFixed(2) + ', ' + hit.pos[2].toFixed(2) + ')');
    };

    App.prototype.setPickCursor = function (on)
    {
        if (!this.canvas) { return; }
        if (on) { this.canvas.classList.add('picking'); }
        else { this.canvas.classList.remove('picking'); }
    };

    App.prototype.setPickInfo = function (on)
    {
        this.pickInfo = !!on;
        if (this.pickInfo)
        {
            this.pickPoints = this.pickPoints || [];
            this.setPickCursor(true);
            hooks.notify('拾取模式：在数据上单击取点，Esc 退出');
        }
        else
        {
            /* 退出即清空。原来只切光标、保留 pickPoints，于是：
             *   - 三维视图里的十字标记一直挂着
             *   - renderPickBar 的判断是「未激活且无点才隐藏」，
             *     点还在就照样显示，信息栏也留在那儿
             * 下次进入拾取模式还会看到上次的残留。 */
            this.pickPoints = [];
            this.setPickCursor(false);
            hooks.notify('已退出拾取模式');
        }

        // pickPoints 已清空，这里传进去的就是空数组，信息栏随之隐藏
        hooks.renderPickBar(this.pickPoints || [], this.pickInfo);

        /* 直接同步给渲染器，不等下一帧 ——
         * 渲染循环虽然也会同步，但它依赖帧调度；退出时用户期望
         * 标记立刻消失，不该有一帧的延迟。 */
        if (this.renderer)
        {
            this.renderer.pickMarks = this.pickPoints;
        }

        this.markDirty();
    };

    App.prototype.togglePickInfo = function ()
    {
        this.setPickInfo(!this.pickInfo);
    };

    App.prototype.addPickPoint = function (clientX, clientY)
    {
        var hit = this.rayPick(clientX, clientY);
        if (!hit)
        {
            hooks.notify('未拾取到数据（点在模型或点云上）');
            return;
        }

        this.pickPoints = this.pickPoints || [];
        /* 不限个数：距离 / 角度取前几个点计算，其余照样在信息栏列出坐标。
         * 原来超过 3 个就 shift() 掉最早的，等于不能多点参照。 */
        this.pickPoints.push(hit);

        hooks.renderPickBar(this.pickPoints, true);
        hooks.notify('已拾取 ' + this.pickPoints.length + ' 个点（Esc 退出）');
        this.markDirty();
    };

    App.prototype.clearPicks = function ()
    {
        this.pickPoints = [];
        if (this.renderer) { this.renderer.pickMarks = this.pickPoints; }
        hooks.renderPickBar([], this.pickInfo);
        this.markDirty();
    };

    App.prototype.beginPickCenter = function ()
    {
        this.pickMode = true;
        if (this.canvas)
        {
            this.setPickCursor(true);
        }
        hooks.notify('点击模型表面设置旋转中心（Esc 取消）');
    };

    App.prototype.cancelPickCenter = function ()
    {
        if (!this.pickMode)
        {
            return;
        }
        this.pickMode = false;
        if (this.canvas)
        {
            this.canvas.style.cursor = '';
        }
        hooks.notify('已取消设置旋转中心');
    };

    }

    function installPickMethods()
    {
        installRayMethods();
        installPickQueryMethods();
        installPickStateMethods();
    }

    global.MV.algo = global.MV.algo || {};
    global.MV.algo.installAppMethods = installPickMethods;
    global.MV.algo.bindHooks = bindHooks;

    /* 裁剪的交互入口（app 绑定按钮 / 键盘后调用） */
    global.MV.algo.currentMode = currentMode;
    global.MV.algo.toggleMode = toggleMode;
    global.MV.algo.applySplit = applySplit;
    global.MV.algo.cancelEdit = cancelEdit;
    global.MV.algo.onKey = onKey;
    global.MV.algo.demoIfRequested = demoIfRequested;

    /* 裁剪改造：追加选区 / 撤销 / 状态查询 */
    global.MV.algo.setMode = setMode;
    global.MV.algo.togglePreview = togglePreview;
    global.MV.algo.beginAppend = beginAppend;
    global.MV.algo.undoSelection = undoSelection;
    global.MV.algo.hasPreview = hasPreview;
    global.MV.algo.selectionCount = selectionCount;

})(window);


/* ==================== ICP 精配准（原 js/icp.js） ==================== */

/* Symmetric ICP
 *
 * 参考：Szymon Rusinkiewicz, "A Symmetric Objective Function for ICP"
 *       (SIGGRAPH 2019)；实现思路对应 trimesh2 的 ICP.cpp / SymmetricICPEstep。
 *
 * 与经典 ICP 的差别在目标函数：对每个对应点，残差同时投影到
 * **目标法向 n** 和**源法向 m** 两个方向 ——
 *
 *     r1 = (p − q)·n
 *     r2 = (p − q)·m
 *
 * 这样既不依赖单侧法向的朝向，也能让两者在部分重叠、法向有噪声时互相约束。
 *
 * 线性化：令 p' = p + ω×p + v（小角度），
 *     (ω×p)·n = ω·(p×n)
 * 于是每个点贡献两行
 *     [ (p×n)ᵀ , nᵀ ] · [ω; v] = −(p − q)·n
 *     [ (p×m)ᵀ , mᵀ ] · [ω; v] = −(p − q)·m
 * 累加成 6×6 正规方程，Cholesky 求解，更新 R ← exp([ω]×)·R，t ← exp([ω]×)·t + v。
 *
 * 两侧都没有法向时退化为点到点（每点 3 行）。
 *
 * 提供两个入口：
 *   symmetric()     一次性跑完（同步，适合脚本/自测）
 *   createSolver()  按轮驱动（step()），供界面分帧执行，避免长时间阻塞主线程
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    /* ---------------- 线性代数小工具 ---------------- */

    /* 6×6 对称正定系统，Cholesky 分解；非正定返回 null */
    function solve6(A, b)
    {
        var L = new Float64Array(36);
        var i, j, k, sum;

        for (i = 0; i < 6; i++)
        {
            for (j = 0; j <= i; j++)
            {
                sum = A[i * 6 + j];
                for (k = 0; k < j; k++) { sum -= L[i * 6 + k] * L[j * 6 + k]; }

                if (i === j)
                {
                    if (sum <= 0) { return null; }
                    L[i * 6 + j] = Math.sqrt(sum);
                }
                else
                {
                    L[i * 6 + j] = sum / L[j * 6 + j];
                }
            }
        }

        // L·y = b
        var y = new Float64Array(6);
        for (i = 0; i < 6; i++)
        {
            sum = b[i];
            for (k = 0; k < i; k++) { sum -= L[i * 6 + k] * y[k]; }
            y[i] = sum / L[i * 6 + i];
        }

        // Lᵀ·x = y
        var x = new Float64Array(6);
        for (i = 5; i >= 0; i--)
        {
            sum = y[i];
            for (k = i + 1; k < 6; k++) { sum -= L[k * 6 + i] * x[k]; }
            x[i] = sum / L[i * 6 + i];
        }
        return x;
    }

    /* 旋转向量 → 旋转矩阵（Rodrigues），返回 3×3 行主序 */
    function expSO3(wx, wy, wz, out)
    {
        var th2 = wx * wx + wy * wy + wz * wz;

        if (th2 < 1e-24)
        {
            out[0] = 1;      out[1] = -wz;   out[2] = wy;
            out[3] = wz;     out[4] = 1;     out[5] = -wx;
            out[6] = -wy;    out[7] = wx;    out[8] = 1;
            return out;
        }

        var th = Math.sqrt(th2);
        var kx = wx / th, ky = wy / th, kz = wz / th;
        var c = Math.cos(th), s = Math.sin(th), v = 1 - c;

        out[0] = c + kx * kx * v;        out[1] = kx * ky * v - kz * s;   out[2] = kx * kz * v + ky * s;
        out[3] = ky * kx * v + kz * s;   out[4] = c + ky * ky * v;        out[5] = ky * kz * v - kx * s;
        out[6] = kz * kx * v - ky * s;   out[7] = kz * ky * v + kx * s;   out[8] = c + kz * kz * v;
        return out;
    }

    /* 3×3 相乘 a·b（行主序） */
    function mul3(a, b, out)
    {
        for (var r = 0; r < 3; r++)
        {
            for (var c = 0; c < 3; c++)
            {
                out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
            }
        }
        return out;
    }

    /* 累加一行到正规方程 A += row·rowᵀ, b += row·rhs
     * 必须填满整个 6×6：solve6 的 Cholesky 会同时读上下三角，
     * 只填上三角等于解错方程组（曾导致 ICP 每轮残差指数级放大）。 */
    function addRow6(A, b, c0, c1, c2, n0, n1, n2, rhs)
    {
        var row = [c0, c1, c2, n0, n1, n2];
        var i, j, ri, rj;

        for (i = 0; i < 6; i++)
        {
            ri = row[i];
            for (j = 0; j < 6; j++)
            {
                rj = row[j];
                A[i * 6 + j] += ri * rj;
            }
            b[i] += ri * rhs;
        }
    }

    /* ---------------- 顶点法向 ---------------- */

    /* 由网格三角形累积顶点法向；remap 为三角形顶点索引（每三角形 3 个），可省略 */
    function computeVertexNormals(positions, remap, vertCount)
    {
        var nTri = Math.floor(positions.length / 9);
        var nv = vertCount || (remap ? (remap.length / 3) : Math.floor(positions.length / 3));

        if (remap && vertCount)
        {
            nv = vertCount;
        }
        else if (remap)
        {
            var mx = 0;
            for (var r = 0; r < remap.length; r++) { if (remap[r] > mx) { mx = remap[r]; } }
            nv = mx + 1;
        }

        var nrm = new Float32Array(nv * 3);

        for (var t = 0; t < nTri; t++)
        {
            var o = t * 9;
            var ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
            var bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
            var cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];

            var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

            var nx = e1y * e2z - e1z * e2y;
            var ny = e1z * e2x - e1x * e2z;
            var nz = e1x * e2y - e1y * e2x;

            var i0, i1, i2;
            if (remap)
            {
                i0 = remap[t * 3]; i1 = remap[t * 3 + 1]; i2 = remap[t * 3 + 2];
            }
            else
            {
                i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2;
            }

            nrm[i0 * 3] += nx; nrm[i0 * 3 + 1] += ny; nrm[i0 * 3 + 2] += nz;
            nrm[i1 * 3] += nx; nrm[i1 * 3 + 1] += ny; nrm[i1 * 3 + 2] += nz;
            nrm[i2 * 3] += nx; nrm[i2 * 3 + 1] += ny; nrm[i2 * 3 + 2] += nz;
        }

        for (var i = 0; i < nrm.length; i += 3)
        {
            var len = Math.sqrt(nrm[i] * nrm[i] + nrm[i + 1] * nrm[i + 1] + nrm[i + 2] * nrm[i + 2]);
            if (len > 1e-12)
            {
                nrm[i] /= len;
                nrm[i + 1] /= len;
                nrm[i + 2] /= len;
            }
            else
            {
                nrm[i] = 0; nrm[i + 1] = 0; nrm[i + 2] = 0;
            }
        }

        return { normals: nrm, count: nv };
    }

    /* ---------------- 求解器（可按轮驱动） ---------------- */

    /* 行向量重正交（Gram-Schmidt）。
     * expSO3 每轮左乘会累积浮点误差，几十轮后 R 不再严格正交，
     * 于是 isRigidMat 判为"非刚体"，应用矩阵时被拒绝、数据保持原位 ——
     * 表现为 ICP 明明报了 RMS=0，模型却纹丝不动。 */
    function orthonormalize(R, out)
    {
        var r0x = R[0], r0y = R[1], r0z = R[2];
        var r1x = R[3], r1y = R[4], r1z = R[5];

        var n0 = Math.sqrt(r0x * r0x + r0y * r0y + r0z * r0z);
        if (!(n0 > 0)) { return false; }
        r0x /= n0; r0y /= n0; r0z /= n0;

        var d01 = r1x * r0x + r1y * r0y + r1z * r0z;
        r1x -= d01 * r0x; r1y -= d01 * r0y; r1z -= d01 * r0z;

        var n1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
        if (!(n1 > 0)) { return false; }
        r1x /= n1; r1y /= n1; r1z /= n1;

        out[0] = r0x; out[1] = r0y; out[2] = r0z;
        out[3] = r1x; out[4] = r1y; out[5] = r1z;
        out[6] = r0y * r1z - r0z * r1y;
        out[7] = r0z * r1x - r0x * r1z;
        out[8] = r0x * r1y - r0y * r1x;
        return true;
    }

    function matOf(R, t)
    {
        // 先重正交：几十轮 expSO3 累积的浮点误差会让 R 偏离正交，
        // 上层 isRigidMat 校验不通过就不应用矩阵（表现为 RMS=0 但模型不动）
        var R2 = new Float64Array(9);
        if (orthonormalize(R, R2))
        {
            R = [R2[0], R2[1], R2[2], R2[3], R2[4], R2[5], R2[6], R2[7], R2[8]];
        }

        var m = new Float64Array(16);
        m[0] = R[0]; m[1] = R[1]; m[2] = R[2];   m[3] = t[0];
        m[4] = R[3]; m[5] = R[4]; m[6] = R[5];   m[7] = t[1];
        m[8] = R[6]; m[9] = R[7]; m[10] = R[8];  m[11] = t[2];
        m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
        return m;
    }

    /* opts 同 symmetric()；另支持 onIter(iters, rms, step) 返回 false 中止 */
    function createSolver(srcPos, srcNrm, dstPos, dstNrm, opts)
    {
        opts = opts || {};

        var maxIter = opts.maxIter || 50;
        var tol = opts.tol || 1e-7;
        var maxDist = opts.maxDist || 0;
        var normalThresh = (opts.normalThresh === undefined) ? 0.5 : opts.normalThresh;
        var onIter = opts.onIter || null;

        // 采样比例 0~1：1 表示不采样。兼容旧的整数 stride（1 表示全量）。
        var sampleRatio = 1;
        if (opts.sampleRatio !== undefined)
        {
            sampleRatio = Math.max(0.001, Math.min(1, opts.sampleRatio));
        }
        else if (opts.stride)
        {
            sampleRatio = Math.max(0.001, Math.min(1, 1 / opts.stride));
        }

        var kd = global.MV.kdtree.build(dstPos);
        if (!kd) { return null; }

        var nSrc = Math.floor(srcPos.length / 3);
        var nDst = Math.floor(dstPos.length / 3);
        if (!nSrc || !nDst) { return null; }

        var hasSrcN = !!srcNrm && srcNrm.length >= nSrc * 3;
        var hasDstN = !!dstNrm && dstNrm.length >= nDst * 3;

        var R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        var t = [0, 0, 0];

        // 初值：允许从已有的粗配准（质心/PCA/上一次 ICP）出发，
        // 镜像类变体务必先把镜像作用到点集上，这里只接受刚体部分
        if (opts.initMat)
        {
            var im = opts.initMat;
            R = [im[0], im[1], im[2], im[4], im[5], im[6], im[8], im[9], im[10]];
            t = [im[3], im[7], im[11]];
        }

        /* 随机下采样：一次性抽取固定的索引集合，之后每轮都用同一批点。
         * 若每轮重新随机，RMS 会持续抖动、收敛判据失效。
         * 不采样时 idxList 保持 null，走零开销的全量遍历。 */
        var idxList = null;
        if (sampleRatio < 0.9999)
        {
            var want = Math.max(6, Math.round(nSrc * sampleRatio));

            if (want < nSrc)
            {
                var pool = new Int32Array(nSrc);
                for (var pi2 = 0; pi2 < nSrc; pi2++) { pool[pi2] = pi2; }

                // 部分 Fisher-Yates：只需要前 want 个
                for (var pi3 = 0; pi3 < want; pi3++)
                {
                    var pj = pi3 + Math.floor(Math.random() * (nSrc - pi3));
                    var pt = pool[pi3];
                    pool[pi3] = pool[pj];
                    pool[pj] = pt;
                }

                idxList = pool.subarray(0, want);
            }
        }

        var nSamples = idxList ? idxList.length : nSrc;

        var dR = new Float64Array(9);
        var tmp = new Float64Array(9);

        var iters = 0;
        var lastRms = Infinity;
        var used = 0;
        var done = false;

        /* 跑一轮，返回 { done, iters, rms, step, used } */
        function step()
        {
            if (done || iters >= maxIter)
            {
                done = true;
                return { done: true, iters: iters, rms: lastRms, step: 0, used: used };
            }

            /* 距离阈值随迭代递减（trim-ICP 的常见做法）：
             * 前 2/3 的迭代放宽到 3 倍，用于快速拉近；之后线性收紧回设定值，
             * 避免大阈值把错配带进最终解。
             * 初始偏差较大时，固定的小阈值会让几乎所有对应被丢弃，
             * 剩下的少量重叠点给出不唯一的解（实测偏移 50 会停在 15）。 */
            var curMaxDist = maxDist;
            if (maxDist > 0 && maxIter > 1)
            {
                var decay = 1 - Math.min(1, iters / (maxIter * 0.66));
                curMaxDist = maxDist * (1 + 2 * decay);
            }

            var A = new Float64Array(36);
            var b = new Float64Array(6);
            var cnt = 0;
            var sumSq = 0;

            for (var si = 0; si < nSamples; si++)
            {
                var i = idxList ? idxList[si] : si;
                var p0 = i * 3;
                var sx = srcPos[p0], sy = srcPos[p0 + 1], sz = srcPos[p0 + 2];

                var px = R[0] * sx + R[1] * sy + R[2] * sz + t[0];
                var py = R[3] * sx + R[4] * sy + R[5] * sz + t[1];
                var pz = R[6] * sx + R[7] * sy + R[8] * sz + t[2];

                var qi = kd.nearestIndex(px, py, pz);
                if (qi < 0) { continue; }

                var q0 = qi * 3;
                var qx = dstPos[q0], qy = dstPos[q0 + 1], qz = dstPos[q0 + 2];

                var dx = px - qx, dy = py - qy, dz = pz - qz;
                var d2 = dx * dx + dy * dy + dz * dz;

                if (curMaxDist > 0 && d2 > curMaxDist * curMaxDist) { continue; }

                var nx = 0, ny = 0, nz = 0;
                if (hasDstN) { nx = dstNrm[q0]; ny = dstNrm[q0 + 1]; nz = dstNrm[q0 + 2]; }

                var mx = 0, my = 0, mz = 0;
                if (hasSrcN) { mx = srcNrm[p0]; my = srcNrm[p0 + 1]; mz = srcNrm[p0 + 2]; }

                if (hasDstN && hasSrcN && (nx * mx + ny * my + nz * mz) < normalThresh)
                {
                    continue;
                }

                if (hasDstN || hasSrcN)
                {
                    if (hasDstN)
                    {
                        addRow6(A, b,
                            py * nz - pz * ny, pz * nx - px * nz, px * ny - py * nx,
                            nx, ny, nz,
                            -(dx * nx + dy * ny + dz * nz));
                        var rn = dx * nx + dy * ny + dz * nz;
                        sumSq += rn * rn;
                        cnt++;
                    }
                    if (hasSrcN)
                    {
                        addRow6(A, b,
                            py * mz - pz * my, pz * mx - px * mz, px * my - py * mx,
                            mx, my, mz,
                            -(dx * mx + dy * my + dz * mz));
                        if (!hasDstN)
                        {
                            var rm = dx * mx + dy * my + dz * mz;
                            sumSq += rm * rm;
                            cnt++;
                        }
                    }
                }
                else
                {
                    addRow6(A, b, 0, pz, -py, 1, 0, 0, -dx);
                    addRow6(A, b, -pz, 0, px, 0, 1, 0, -dy);
                    addRow6(A, b, py, -px, 0, 0, 0, 1, -dz);
                    sumSq += d2;
                    cnt++;
                }
            }

            if (cnt < 6)
            {
                done = true;
                return { done: true, iters: iters, rms: lastRms, step: 0, used: used };
            }

            var rms = Math.sqrt(sumSq / cnt);
            used = cnt;

            var sol = solve6(A, b);
            if (!sol)
            {
                done = true;
                return { done: true, iters: iters, rms: rms, step: 0, used: used };
            }

            expSO3(sol[0], sol[1], sol[2], dR);
            mul3(dR, R, tmp);
            R = [tmp[0], tmp[1], tmp[2], tmp[3], tmp[4], tmp[5], tmp[6], tmp[7], tmp[8]];

            var ntx = dR[0] * t[0] + dR[1] * t[1] + dR[2] * t[2] + sol[3];
            var nty = dR[3] * t[0] + dR[4] * t[1] + dR[5] * t[2] + sol[4];
            var ntz = dR[6] * t[0] + dR[7] * t[1] + dR[8] * t[2] + sol[5];
            t = [ntx, nty, ntz];

            var stepLen = Math.sqrt(sol[0] * sol[0] + sol[1] * sol[1] + sol[2] * sol[2])
                        + Math.sqrt(sol[3] * sol[3] + sol[4] * sol[4] + sol[5] * sol[5]);

            iters++;

            // 相对判据：不同尺度的模型用同一个 tol 才有一致的收敛行为。
            // 绝对阈值会导致大模型永远达不到、每次都跑满 maxIter。
            var converged = (Math.abs(lastRms - rms) < tol * (1 + rms)) || (stepLen < 1e-9);
            lastRms = rms;

            if (onIter && onIter(iters, rms, stepLen) === false) { done = true; }
            if (converged) { done = true; }

            return { done: done, iters: iters, rms: rms, step: stepLen, used: cnt, converged: converged };
        }

        return {
            step: step,
            cancel: function () { done = true; },
            isDone: function () { return done; },
            result: function ()
            {
                return {
                    mat: matOf(R, t),
                    rms: lastRms,
                    iters: iters,
                    used: used,
                    hasNormals: hasSrcN || hasDstN
                };
            }
        };
    }

    /* 一次性跑完（同步） */
    function symmetric(srcPos, srcNrm, dstPos, dstNrm, opts)
    {
        var solver = createSolver(srcPos, srcNrm, dstPos, dstNrm, opts);
        if (!solver) { return null; }

        var guard = 0;
        while (!solver.isDone() && guard++ < 10000)
        {
            solver.step();
        }
        return solver.result();
    }

    /* ---------------- PCA 主轴 ---------------- */

    /* 3×3 对称矩阵 Jacobi 特征分解，返回按特征值降序的 (特征值, 主轴) */
    function jacobi3(Ain)
    {
        var A = [
            [Ain[0][0], Ain[0][1], Ain[0][2]],
            [Ain[1][0], Ain[1][1], Ain[1][2]],
            [Ain[2][0], Ain[2][1], Ain[2][2]]
        ];
        var V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        var p, q, k;

        for (var sweep = 0; sweep < 60; sweep++)
        {
            var off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
            if (off < 1e-26) { break; }

            for (p = 0; p < 2; p++)
            {
                for (q = p + 1; q < 3; q++)
                {
                    if (Math.abs(A[p][q]) < 1e-20) { continue; }

                    var theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                    var t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                    var c = 1 / Math.sqrt(t * t + 1);
                    var sn = t * c;

                    for (k = 0; k < 3; k++)
                    {
                        var akp = A[k][p], akq = A[k][q];
                        A[k][p] = c * akp - sn * akq;
                        A[k][q] = sn * akp + c * akq;
                    }
                    for (k = 0; k < 3; k++)
                    {
                        var apk = A[p][k], aqk = A[q][k];
                        A[p][k] = c * apk - sn * aqk;
                        A[q][k] = sn * apk + c * aqk;
                    }
                    for (k = 0; k < 3; k++)
                    {
                        var vkp = V[k][p], vkq = V[k][q];
                        V[k][p] = c * vkp - sn * vkq;
                        V[k][q] = sn * vkp + c * vkq;
                    }
                }
            }
        }

        var order = [0, 1, 2];
        order.sort(function (a, b) { return A[b][b] - A[a][a]; });

        var values = [];
        var axes = [];
        for (var i = 0; i < 3; i++)
        {
            var idx = order[i];
            values.push(A[idx][idx]);
            axes.push([V[0][idx], V[1][idx], V[2][idx]]);
        }

        // 确定性符号：每个主轴让绝对值最大的分量为正，
        // 两边用同一约定后矩阵才可比（简并时仍需外层枚举兜底）
        for (i = 0; i < 3; i++)
        {
            var a = axes[i];
            var best = 0;
            if (Math.abs(a[1]) > Math.abs(a[best])) { best = 1; }
            if (Math.abs(a[2]) > Math.abs(a[best])) { best = 2; }
            if (a[best] < 0)
            {
                a[0] = -a[0]; a[1] = -a[1]; a[2] = -a[2];
            }
        }

        return { values: values, axes: axes };
    }

    /* 点集的质心与主轴；stride 用于大点集抽样 */
    function pcaOf(positions, count, stride)
    {
        var n = count || Math.floor(positions.length / 3);
        var st = Math.max(1, stride || 1);

        var cx = 0, cy = 0, cz = 0, m = 0;
        var i;
        for (i = 0; i < n; i += st)
        {
            cx += positions[i * 3];
            cy += positions[i * 3 + 1];
            cz += positions[i * 3 + 2];
            m++;
        }
        if (!m) { return null; }
        cx /= m; cy /= m; cz /= m;

        var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
        for (i = 0; i < n; i += st)
        {
            var dx = positions[i * 3] - cx;
            var dy = positions[i * 3 + 1] - cy;
            var dz = positions[i * 3 + 2] - cz;
            xx += dx * dx; xy += dx * dy; xz += dx * dz;
            yy += dy * dy; yz += dy * dz; zz += dz * dz;
        }

        var cov = [[xx / m, xy / m, xz / m], [xy / m, yy / m, yz / m], [xz / m, yz / m, zz / m]];
        var eig = jacobi3(cov);

        return { center: [cx, cy, cz], axes: eig.axes, values: eig.values };
    }


    /* ---------------- 自动粗配准（Super4PCS 的简化实现） ----------------
     *
     * 论文做法：从源点集取共面 4 点，用 LCP（最大公共点集）索引在目标中
     * 快速找出与此 4 点全等的所有 4 点组，再按最优子集枚举 + RANSAC 打分。
     *
     * 这里做了三处简化，换来实现量与内存可控：
     *   1. 不做 LCP 索引，改在抽样后的目标点集上按"逐级半径查询"扩张；
     *   2. 不做最优子集枚举，每级只保留少量候选（宽基线本身已给出较强约束）；
     *   3. 打分用固定抽样点的内点率，而不是全量 LCP。
     *
     * 对"两个姿态差异很大、PCA 主轴又区分不开"的工件，这一步能把 ICP
     * 拉进收敛域，剩下的精度交给后面的对称 ICP。
     */

    /* 4×4 对称矩阵的最大特征向量（Jacobi 旋转），用于 Horn 四元数求解 */


    global.MV.icp = {
        symmetric: symmetric,
        createSolver: createSolver,
        computeVertexNormals: computeVertexNormals,
        pcaOf: pcaOf,
        jacobi3: jacobi3,
        solve6: solve6,
        expSO3: expSO3,
    };
})(window);


/* ==================== Super4PCS 全局粗配准（原 js/super4pcs.js） ==================== */

/* ------------------------------------------------------------------
 * super4pcs.js —— Super4PCS 的忠实 JS 实现
 *
 * 逐函数翻译自官方实现 nmellado/Super4PCS（Apache-2.0）：
 *   src/super4pcs/algorithms/match4pcsBase.hpp   init / ComputeTransformation /
 *                                                Perform_N_steps / TryOneBase /
 *                                                TryCongruentSet / Verify
 *   src/super4pcs/algorithms/match4pcsBase.cc    SelectQuadrilateral /
 *                                                SelectRandomTriangle /
 *                                                TryQuadrilateral /
 *                                                distSegmentToSegment
 *   src/super4pcs/algorithms/super4pcs.cc        ExtractPairs /
 *                                                FindCongruentQuadrilaterals
 *   src/super4pcs/accelerators/normalset.h/.hpp  IndexedNormalSet3D
 *   src/super4pcs/shared4pcs.h                   Match4PCSOptions 默认值
 *
 * 与原版的已知差异（均为运行环境所迫，已在各处注明）：
 *   1. ComputeRigidTransformation 用 Horn 四元数代替官方 SVD，
 *      二者都是最小二乘刚体解，数学等价；
 *   2. 单线程（官方有 OpenMP 并行验证候选）；
 *   3. 主循环提供按帧让出的分步接口，避免长时间阻塞浏览器主线程；
 *   4. 坐标统一归一化到 [0,1)，因为 IndexedNormalSet3D 的网格索引
 *      以 _egSize = 2^floor(-log2(eps)) 构建，直接用物理坐标会让
 *      _grid 规模爆炸（eps 很小时 _egSize^3 可达上亿）。
 *
 * 对外接口：
 *   MV.super4pcs.register(P, Q, options) -> Float64Array(16) | null
 *     P / Q : { positions: Float32Array|Float64Array, count: Number }
 *   返回值把 P 变换到 Q 的 4x4 刚体矩阵（列主序与行主序一致，最后一行为 0,0,0,1）
 *
 *   MV.super4pcs.createRegistration(P, Q, options) -> { step, result, isDone, cancel }
 *     分步版本，每次 step 只做一小批，供 UI 按帧驱动。
 * ------------------------------------------------------------------ */

(function (global)
{
    'use strict';

    var MV = global.MV || (global.MV = {});

    /* ---------------- Match4PCSOptions（shared4pcs.h 原值） ---------------- */
    var OPTION_DEFAULTS = {
        delta: 5.0,                     // LCP 容差，绝对长度单位
        max_normal_difference: -1,      // <0 表示不启用
        max_translation_distance: -1,
        max_angle: -1,
        max_color_distance: -1,
        sample_size: 200,               // 每侧均匀采样点数
        max_time_seconds: 60,
        overlap_estimation: 0.2,
        terminate_threshold: 1.0,

        /* —— 以下是本实现追加的运行控制项，官方没有 —— */
        maxCongruent: 300,      // 每次尝试最多验证多少个候选四边形
        maxTrials: 0            // 0 表示用官方公式算出的迭代数
    };

    /* normalset.h：IndexedNormalSet3D = IndexedNormalSet<Point3D, 3, NG_SIZE, Scalar> */
    var NG_SIZE = 7;                        // 法向每维分箱数，共 7^3 = 343
    var ANGULAR_BINS = NG_SIZE * NG_SIZE * NG_SIZE;

    /* super4pcs.cc：distance_factor = 2.0 */
    var DISTANCE_FACTOR = 2.0;

    /* match4pcsBase.h */
    var K_NUMBER_OF_DIAMETER_TRIALS = 1000;
    var K_MIN_NUMBER_OF_TRIALS = 4;

    /* 浏览器里的硬上限：无论外部传多少，尝试次数都不超过这个值。
     * 官方公式对 overlay=0.2 会算出 2 万量级，那在交互场景里不可接受。 */
    var K_MAX_TRIALS = 200;
    var K_SMALL_ERROR = 0.00001;
    var K_DIAMETER_FRACTION = 0.3;
    var K_BASE_TOO_SMALL = 0.2;
    var K_SMALL_NUMBER = 0.0001;

    var IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    /* ================= 基础工具 ================= */

    function nowMs()
    {
        return (global.performance && global.performance.now)
            ? global.performance.now() : Date.now();
    }

    /* 混合基数线性化：id = Σ coord[i] * base^i，任一维越界返回 -1
     * 对应官方 Utils::UnrollIndexLoop<VALIDATE_INDICES>(coord, dim-1, base) */
    function unrollIndexLoop(cx, cy, cz, base)
    {
        var bx = Math.floor(cx);
        var by = Math.floor(cy);
        var bz = Math.floor(cz);

        if (bx < 0 || bx >= base || by < 0 || by >= base || bz < 0 || bz >= base)
        {
            return -1;
        }

        return bx + by * base + bz * base * base;
    }

    /* ================= IndexedNormalSet3D ================= */
    /*
     * normalset.h / .hpp 的直译。
     *   _grid : AngularGrid[_egSize^dim]，_egSize 为每维位置格子数
     *   AngularGrid = vector<unsigned>[343]，每个位置格子挂一张角度网格
     * 位置与法向都必须先归一化；空体素惰性分配（官方注释即"内存高效"）。
     */
    function IndexedNormalSet3D(epsilon)
    {
        this.ngSize = NG_SIZE;
        this.nepsilon = 1 / NG_SIZE + 0.00001;      // 略大于 1/NG_SIZE，使 floor 不越界

        /* 官方把 epsilon 向下对齐到 2 的幂：gridDepth = -log2(eps) */
        var gridDepth = Math.floor(-Math.log2(epsilon));
        if (!isFinite(gridDepth)) { gridDepth = 0; }
        if (gridDepth < 1) { gridDepth = 1; }
        if (gridDepth > 10) { gridDepth = 10; }     // 兜底：10^3 = 1024 格，避免内存失控

        this.egSize = Math.pow(2, gridDepth);
        this.epsilon = 1 / this.egSize;

        this.grid = new Array(Math.pow(this.egSize, 3));   // 惰性分配，初值全 undefined
    }

    IndexedNormalSet3D.prototype.coordinatesPos = function (x, y, z)
    {
        var inv = 1 / this.epsilon;
        return [x * inv, y * inv, z * inv];
    };

    IndexedNormalSet3D.prototype.coordinatesNormal = function (nx, ny, nz)
    {
        var inv = 1 / this.nepsilon;
        return [(nx / 2 + 0.5) * inv, (ny / 2 + 0.5) * inv, (nz / 2 + 0.5) * inv];
    };

    IndexedNormalSet3D.prototype.indexPos = function (x, y, z)
    {
        var c = this.coordinatesPos(x, y, z);
        return unrollIndexLoop(c[0], c[1], c[2], this.egSize);
    };

    IndexedNormalSet3D.prototype.indexNormal = function (nx, ny, nz)
    {
        var c = this.coordinatesNormal(nx, ny, nz);
        return unrollIndexLoop(c[0], c[1], c[2], this.ngSize);
    };

    IndexedNormalSet3D.prototype.addElement = function (px, py, pz, nx, ny, nz, id)
    {
        var pId = this.indexPos(px, py, pz);
        if (pId === -1) { return false; }

        var nId = this.indexNormal(nx, ny, nz);
        if (nId === -1) { return false; }

        var cell = this.grid[pId];
        if (!cell)
        {
            cell = new Array(ANGULAR_BINS);
            this.grid[pId] = cell;
        }

        var bucket = cell[nId];
        if (!bucket) { bucket = []; cell[nId] = bucket; }
        bucket.push(id);

        return true;
    };

    /* 重载 3：位置格子 + 沿"以 n 为极轴、半角 alpha 的圆锥母线圆周"采样
     * 官方用这套圆环光栅化代替"枚举锥内所有角度格"，查询代价与点云规模无关。
     *
     * 官方源码写的是 std::atan(alpha)，按单位球几何应为 sin(alpha)
     * （圆周半径 = sinα）。这里保留官方的 atan 写法并在采样数上取
     * max(4, ...) 保证不因 alpha 很小而漏采。 */
    IndexedNormalSet3D.prototype.getNeighbors = function (px, py, pz, nx, ny, nz, cosAlpha, tryReverse, out)
    {
        var pId = this.indexPos(px, py, pz);
        if (pId === -1) { return; }

        var cell = this.grid[pId];
        if (!cell) { return; }

        var alpha = Math.acos(Math.max(-1, Math.min(1, cosAlpha)));
        var perimeter = 2 * Math.PI * Math.atan(alpha);
        var nbSample = 2 * Math.ceil(perimeter * NG_SIZE / 2);
        if (!(nbSample >= 4)) { nbSample = 4; }

        var angleStep = 2 * Math.PI / nbSample;
        var sinAlpha = Math.sin(alpha);
        var cosA = Math.cos(alpha);

        /* 构造把 +Z 旋到 n 的四元数（官方 setFromTwoVectors）
         * 这里直接用它旋转局部坐标，避免引入完整四元数类型。 */
        var axis = rotateZTo(nx, ny, nz);

        var colored = Object.create(null);
        var a, theta, dx, dy, dz, id;

        for (a = 0; a < nbSample; a++)
        {
            theta = a * angleStep;

            var lx = sinAlpha * Math.cos(theta);
            var ly = sinAlpha * Math.sin(theta);
            var lz = cosA;

            dx = axis[0] * lx + axis[3] * ly + axis[6] * lz;
            dy = axis[1] * lx + axis[4] * ly + axis[7] * lz;
            dz = axis[2] * lx + axis[5] * ly + axis[8] * lz;

            var il = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
            dx *= il; dy *= il; dz *= il;

            id = this.indexNormal(dx, dy, dz);
            if (id >= 0 && cell[id] && cell[id].length) { colored[id] = 1; }

            if (tryReverse)
            {
                id = this.indexNormal(-dx, -dy, -dz);
                if (id >= 0 && cell[id] && cell[id].length) { colored[id] = 1; }
            }
        }

        for (var k in colored)
        {
            var bucket = cell[k];
            for (var i = 0; i < bucket.length; i++) { out.push(bucket[i]); }
        }
    };

    /* 旋转矩阵：把 +Z 轴转到单位向量 n（setFromTwoVectors 的矩阵形式） */
    function rotateZTo(nx, ny, nz)
    {
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(len > 1e-12)) { return IDENT4.slice(0, 9); }
        nx /= len; ny /= len; nz /= len;

        var dot = nz;                 // (0,0,1)·n
        if (dot > 0.9999999) { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
        if (dot < -0.9999999) { return [-1, 0, 0, 0, -1, 0, 0, 0, 1]; }   // 绕 X 转 180°

        // axis = z × n = (-ny, nx, 0)
        var ax = -ny, ay = nx, az = 0;
        var s = Math.sqrt(ax * ax + ay * ay + az * az);
        ax /= s; ay /= s; az /= s;

        var c = dot;
        var t = 1 - c;

        return [
            t * ax * ax + c,      t * ax * ay - s * az, t * ax * az + s * ay,
            t * ax * ay + s * az, t * ay * ay + c,      t * ay * az - s * ax,
            t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c
        ];
    }

    /* ================= 均匀采样（sampling.h 的 UniformDistSampler） ================= */

    /* 随机抽取 count 个互不相同的索引（部分 Fisher-Yates）。 */
    function pickIdx(total, count)
    {
        var i;

        if (count >= total)
        {
            var all = new Int32Array(total);
            for (i = 0; i < total; i++) { all[i] = i; }
            return all;
        }

        var pool = new Int32Array(total);
        for (i = 0; i < total; i++) { pool[i] = i; }

        for (i = 0; i < count; i++)
        {
            var j = i + Math.floor(Math.random() * (total - i));
            var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }

        return pool.subarray(0, count);
    }

        function uniformSample(pos, count, sampleSize)
    {
        if (count <= sampleSize)
        {
            var all = new Float64Array(count * 3);
            for (var q = 0; q < count * 3; q++) { all[q] = pos[q]; }
            return { pos: all, count: count, idx: null };
        }

        var pool = new Int32Array(count);
        var i;
        for (i = 0; i < count; i++) { pool[i] = i; }

        // 部分 Fisher-Yates：只取前 sampleSize 个
        for (i = 0; i < sampleSize; i++)
        {
            var j = i + Math.floor(Math.random() * (count - i));
            var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }

        var out = new Float64Array(sampleSize * 3);
        for (i = 0; i < sampleSize; i++)
        {
            out[i * 3] = pos[pool[i] * 3];
            out[i * 3 + 1] = pos[pool[i] * 3 + 1];
            out[i * 3 + 2] = pos[pool[i] * 3 + 2];
        }

        return { pos: out, count: sampleSize, idx: null };
    }

    /* ================= 点云包围辅助 ================= */

    function bboxOf(pos, count)
    {
        var mn = [Infinity, Infinity, Infinity];
        var mx = [-Infinity, -Infinity, -Infinity];

        for (var i = 0; i < count; i++)
        {
            for (var d = 0; d < 3; d++)
            {
                var v = pos[i * 3 + d];
                if (v < mn[d]) { mn[d] = v; }
                if (v > mx[d]) { mx[d] = v; }
            }
        }

        return { min: mn, max: mx };
    }

    function centroidOf(pos, count)
    {
        var cx = 0, cy = 0, cz = 0;
        for (var i = 0; i < count; i++)
        {
            cx += pos[i * 3];
            cy += pos[i * 3 + 1];
            cz += pos[i * 3 + 2];
        }
        return [cx / count, cy / count, cz / count];
    }

    /* ================= Horn 四元数求刚体变换 ================= */
    /*
     * 官方 ComputeRigidTransformation 用 SVD；这里用 Horn 的四元数闭式解，
     * 目标函数同为「最小化对应点距离平方和」，结果是同一个刚体变换。
     * pairs: [[sx,sy,sz, dx,dy,dz], ...]
     */
    function jacobi4Vec(Ain)
    {
        var A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
        var V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
        var i, j, k;

        for (i = 0; i < 4; i++)
        {
            for (j = 0; j < 4; j++) { A[i][j] = Ain[i][j]; }
        }

        for (var sweep = 0; sweep < 40; sweep++)
        {
            var off = 0;
            for (i = 0; i < 4; i++)
            {
                for (j = i + 1; j < 4; j++) { off += A[i][j] * A[i][j]; }
            }
            if (off < 1e-26) { break; }

            for (i = 0; i < 4; i++)
            {
                for (j = i + 1; j < 4; j++)
                {
                    if (Math.abs(A[i][j]) < 1e-20) { continue; }

                    var theta = (A[j][j] - A[i][i]) / (2 * A[i][j]);
                    var tt = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                    var c = 1 / Math.sqrt(tt * tt + 1);
                    var sn = tt * c;

                    for (k = 0; k < 4; k++)
                    {
                        var aik = A[i][k], ajk = A[j][k];
                        A[i][k] = c * aik - sn * ajk;
                        A[j][k] = sn * aik + c * ajk;
                    }
                    for (k = 0; k < 4; k++)
                    {
                        var aki = A[k][i], akj = A[k][j];
                        A[k][i] = c * aki - sn * akj;
                        A[k][j] = sn * aki + c * akj;
                    }
                    for (k = 0; k < 4; k++)
                    {
                        var vki = V[k][i], vkj = V[k][j];
                        V[k][i] = c * vki - sn * vkj;
                        V[k][j] = sn * vki + c * vkj;
                    }
                }
            }
        }

        var bi = 0;
        for (i = 1; i < 4; i++) { if (A[i][i] > A[bi][bi]) { bi = i; } }
        return [V[0][bi], V[1][bi], V[2][bi], V[3][bi]];
    }

    function solveRigid(pairs)
    {
        var n = pairs.length;
        if (n < 3) { return null; }

        var scx = 0, scy = 0, scz = 0, dcx = 0, dcy = 0, dcz = 0, i, k;
        for (i = 0; i < n; i++)
        {
            scx += pairs[i][0]; scy += pairs[i][1]; scz += pairs[i][2];
            dcx += pairs[i][3]; dcy += pairs[i][4]; dcz += pairs[i][5];
        }
        scx /= n; scy /= n; scz /= n;
        dcx /= n; dcy /= n; dcz /= n;

        var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (i = 0; i < n; i++)
        {
            var a0 = pairs[i][0] - scx, a1 = pairs[i][1] - scy, a2 = pairs[i][2] - scz;
            var b0 = pairs[i][3] - dcx, b1 = pairs[i][4] - dcy, b2 = pairs[i][5] - dcz;
            S[0][0] += a0 * b0; S[0][1] += a0 * b1; S[0][2] += a0 * b2;
            S[1][0] += a1 * b0; S[1][1] += a1 * b1; S[1][2] += a1 * b2;
            S[2][0] += a2 * b0; S[2][1] += a2 * b1; S[2][2] += a2 * b2;
        }

        var Sxx = S[0][0], Sxy = S[0][1], Sxz = S[0][2];
        var Syx = S[1][0], Syy = S[1][1], Syz = S[1][2];
        var Szx = S[2][0], Szy = S[2][1], Szz = S[2][2];

        var N = [
            [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
            [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
            [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
            [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]
        ];

        var q = jacobi4Vec(N);
        if (!q) { return null; }

        var w = q[0], x = q[1], y = q[2], z = q[3];

        var M = new Float64Array(16);
        M[0] = 1 - 2 * (y * y + z * z); M[1] = 2 * (x * y - w * z);     M[2] = 2 * (x * z + w * y);
        M[4] = 2 * (x * y + w * z);     M[5] = 1 - 2 * (x * x + z * z); M[6] = 2 * (y * z - w * x);
        M[8] = 2 * (x * z - w * y);     M[9] = 2 * (y * z + w * x);     M[10] = 1 - 2 * (x * x + y * y);

        M[3] = dcx - (M[0] * scx + M[1] * scy + M[2] * scz);
        M[7] = dcy - (M[4] * scx + M[5] * scy + M[6] * scz);
        M[11] = dcz - (M[8] * scx + M[9] * scy + M[10] * scz);
        M[12] = 0; M[13] = 0; M[14] = 0; M[15] = 1;

        return M;
    }

    /* 3x3 部分重正交，抵消多次四元数乘法的浮点漂移 */
    function orthonormalize(M)
    {
        var r0 = [M[0], M[1], M[2]];
        var r1 = [M[4], M[5], M[6]];

        var l0 = Math.sqrt(r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2]);
        if (!(l0 > 1e-12)) { return M; }
        r0[0] /= l0; r0[1] /= l0; r0[2] /= l0;

        var d = r1[0] * r0[0] + r1[1] * r0[1] + r1[2] * r0[2];
        r1[0] -= d * r0[0]; r1[1] -= d * r0[1]; r1[2] -= d * r0[2];

        var l1 = Math.sqrt(r1[0] * r1[0] + r1[1] * r1[1] + r1[2] * r1[2]);
        if (!(l1 > 1e-12)) { return M; }
        r1[0] /= l1; r1[1] /= l1; r1[2] /= l1;

        var r2 = [
            r0[1] * r1[2] - r0[2] * r1[1],
            r0[2] * r1[0] - r0[0] * r1[2],
            r0[0] * r1[1] - r0[1] * r1[0]
        ];

        M[0] = r0[0]; M[1] = r0[1]; M[2] = r0[2];
        M[4] = r1[0]; M[5] = r1[1]; M[6] = r1[2];
        M[8] = r2[0]; M[9] = r2[1]; M[10] = r2[2];
        return M;
    }

    /* ================= 主类 ================= */

    function Registration(P, Q, options)
    {
        var o = {};
        var key;
        for (key in OPTION_DEFAULTS) { o[key] = OPTION_DEFAULTS[key]; }
        if (options) { for (key in options) { o[key] = options[key]; } }
        this.options = o;

        this.P = P;
        this.Q = Q;

        this.sampledP = null;      // 居中 + 归一化后的采样点
        this.sampledQ = null;
        this.countP = 0;
        this.countQ = 0;
        this.scale = 1;
        this.centroidP = [0, 0, 0];
        this.centroidQ = [0, 0, 0];
        this.kdTree = null;        // 建在 sampledQ 上

        this.base = [null, null, null, null];
        this.baseIds = [0, 0, 0, 0];
        this.bestLCP = 0;
        this.baselineLCP = 0;
        this.kdEval = null;
        this.evalPos = null;
        this.evalDense = 0;
        this.bestTransform = null;
        this.bestPairs = null;

        this.numberOfTrials = 0;
        this.currentTrial = 0;
        this.startTime = 0;
        this.cancelled = false;
        this.lastStats = { quarterAndCount: 0, congruent: 0, verify: 0 };

        /* 单次尝试的诊断快照：用来定位"效果不好"卡在哪个环节 */
        this.diag = {
            pairs1: 0,          // 第一条基线抽到多少等长点对
            pairs2: 0,          // 第二条基线抽到多少等长点对
            quads: 0,           // 索引组合出多少个候选四边形
            truncated: false,   // 候选是否被 maxCongruent 截断
            rmsPass: 0,         // 通过 rms 门限的候选数
            verifyRun: 0,       // 实际执行 verify 的次数
            lcpBest: 0,         // 本次尝试拿到的最好 LCP
            baseFail: 0,        // 基选取失败次数
            pairFail: 0         // 点对提取为空的次数
        };
    }

    /* match4pcsBase.hpp : init */
    Registration.prototype.init = function ()
    {
        var o = this.options;

        var sp = uniformSample(this.P.positions, this.P.count, o.sample_size);
        var sq = uniformSample(this.Q.positions, this.Q.count, o.sample_size);

        this.countP = sp.count;
        this.countQ = sq.count;

        /* 归一化必须落在 [0,1)：IndexedNormalSet3D 的 indexPos 用
         *   floor(p / _epsilon)，_epsilon = 1/_egSize，
         * 一旦坐标是负数就被判为越界、整批点被拒收，索引直接是空的。
         * 所以这里用「减 bbox 最小点 / 除以最大跨度」而不是「减质心」——
         * 保证每个分量都在 [0,1]。 */
        var bp = bboxOf(sp.pos, sp.count);
        var bq = bboxOf(sq.pos, sq.count);

        var cP = centroidOf(sp.pos, sp.count);
        var cQ = centroidOf(sq.pos, sq.count);
        this.centroidP = cP;
        this.centroidQ = cQ;

        var spanPX = bp.max[0] - bp.min[0], spanPY = bp.max[1] - bp.min[1], spanPZ = bp.max[2] - bp.min[2];
        var spanQX = bq.max[0] - bq.min[0], spanQY = bq.max[1] - bq.min[1], spanQZ = bq.max[2] - bq.min[2];

        var scale = Math.max(spanPX, spanPY, spanPZ, spanQX, spanQY, spanQZ, 1e-6);
        this.scale = scale;

        /* 归一化必须以【质心】为基准 —— 它是旋转不变的。
         * 若改用 bbox 最小点，旋转后同一块几何会落到不同坐标，
         * 不变量 r1/r2 就失去意义了。
         *
         * 但 IndexedNormalSet3D 的 indexPos 要求坐标 ∈ [0,1)（内部 floor(p/_epsilon)），
         * 质心系下坐标是 [-0.5, 0.5]。两者用一个常数偏移衔接：
         *     索引坐标 = 变换坐标 + (centroid − bboxMin) / scale
         * 偏移是常数，不影响任何距离与比值，只用于满足索引的非负要求。 */
        this.indexShiftP = [
            (cP[0] - bp.min[0]) / scale,
            (cP[1] - bp.min[1]) / scale,
            (cP[2] - bp.min[2]) / scale
        ];
        this.indexShiftQ = [
            (cQ[0] - bq.min[0]) / scale,
            (cQ[1] - bq.min[1]) / scale,
            (cQ[2] - bq.min[2]) / scale
        ];

        var i;
        this.sampledP = new Float64Array(sp.count * 3);
        for (i = 0; i < sp.count; i++)
        {
            this.sampledP[i * 3] = (sp.pos[i * 3] - cP[0]) / scale;
            this.sampledP[i * 3 + 1] = (sp.pos[i * 3 + 1] - cP[1]) / scale;
            this.sampledP[i * 3 + 2] = (sp.pos[i * 3 + 2] - cP[2]) / scale;
        }

        this.sampledQ = new Float64Array(sq.count * 3);
        for (i = 0; i < sq.count; i++)
        {
            this.sampledQ[i * 3] = (sq.pos[i * 3] - cQ[0]) / scale;
            this.sampledQ[i * 3 + 1] = (sq.pos[i * 3 + 1] - cQ[1]) / scale;
            this.sampledQ[i * 3 + 2] = (sq.pos[i * 3 + 2] - cQ[2]) / scale;
        }

        /* 两棵 KD 树，用途不同：
         *   kdTreeQ —— ExtractPairs 在目标点云里找"与基线等长的点对"
         *   kdTreeP —— Verify 把变换后的 Q 点拿去 P 里查，统计命中率
         *
         * 之前只建了一棵（都在 Q 上），Verify 于是变成"Q 自己查自己"：
         * 单位阵下每个查询点就是它本身，距离恒为 0，LCP 永远 1.0 ——
         * 算法一开始就认为"已经配准好了"，一次搜索都不做。 */
        this.kdTreeQ = MV.kdtree.build(this.sampledQ);
        if (!this.kdTreeQ) { return false; }

        this.kdTreeP = MV.kdtree.build(this.sampledP);
        if (!this.kdTreeP) { return false; }

        /* 评分专用密集点云（建在 Q 上，与 sampledQ 同坐标系）。
         *
         * 为什么必须分开：verify 的命中容差是 delta，而 sample_size 只有
         * 2000 点，间距约 scale/sqrt(2000)。若 delta 小于这个间距，
         * 即使【完全对齐】也只有一半点能命中 —— bestLCP 的天花板被锁在 50%
         * 附近，而初始基准（原始位姿）随手就能达到这个量级，
         * 于是任何候选都超不过基准，搜索等于空转。
         *
         * 用 evalDense 点建树后，间距 = scale/sqrt(evalDense)，
         * delta 才有意义。 */
        /* 必须从【原始点云】抽样，不能从 sq 抽 ——
         * sq 已经是 sample_size（例如 2000）抽稀后的结果，
         * 从它再抽只能得到更稀疏的子集，间距一点没变。
         * 这正是"密集评分树"名不副实、delta 失去区分力的原因。 */
        var evalDense = Math.min(o.evalDense || 20000, this.Q.count);
        this.evalDense = evalDense;

        var evalIdx = pickIdx(this.Q.count, evalDense);
        this.evalPos = new Float64Array(evalDense * 3);

        for (i = 0; i < evalDense; i++)
        {
            this.evalPos[i * 3] = (this.Q.positions[evalIdx[i] * 3] - cQ[0]) / scale;
            this.evalPos[i * 3 + 1] = (this.Q.positions[evalIdx[i] * 3 + 1] - cQ[1]) / scale;
            this.evalPos[i * 3 + 2] = (this.Q.positions[evalIdx[i] * 3 + 2] - cQ[2]) / scale;
        }

        this.kdEval = MV.kdtree.build(this.evalPos);
        if (!this.kdEval) { return false; }

        /* 归一化后的各项距离 */
        this.deltaN = o.delta / scale;
        this.distFactorN = DISTANCE_FACTOR * this.deltaN;

        /* 直径估计：1000 次随机点对取最大（官方注释即"近似"） */
        var diameter = 0;
        for (i = 0; i < K_NUMBER_OF_DIAMETER_TRIALS; i++)
        {
            var at = (Math.random() * this.countQ) | 0;
            var bt = (Math.random() * this.countQ) | 0;
            var dx = this.sampledQ[at * 3] - this.sampledQ[bt * 3];
            var dy = this.sampledQ[at * 3 + 1] - this.sampledQ[bt * 3 + 1];
            var dz = this.sampledQ[at * 3 + 2] - this.sampledQ[bt * 3 + 2];
            var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (l > diameter) { diameter = l; }
        }
        if (!(diameter > 0)) { diameter = 1; }

        this.pDiameter = diameter;
        this.maxBaseDiameter = diameter;      // 官方：max_base_diameter_ = P_diameter_

        /* RANSAC 迭代数：log(1e-5) / log(1 − overlap^4) × (D/0.3)/D */
        var overlap = Math.max(1e-6, Math.min(0.999, o.overlap_estimation));
        var first = Math.log(K_SMALL_ERROR) / Math.log(1 - Math.pow(overlap, K_MIN_NUMBER_OF_TRIALS));
        this.numberOfTrials = Math.round(first * (this.pDiameter / K_DIAMETER_FRACTION) / this.maxBaseDiameter);
        if (!(this.numberOfTrials >= K_MIN_NUMBER_OF_TRIALS))
        {
            this.numberOfTrials = K_MIN_NUMBER_OF_TRIALS;
        }

        /* 迭代数硬上限：外部可再收紧，但不能突破 K_MAX_TRIALS */
        var cap = (o.maxTrials && o.maxTrials > 0)
            ? Math.min(o.maxTrials, K_MAX_TRIALS)
            : K_MAX_TRIALS;

        if (this.numberOfTrials > cap) { this.numberOfTrials = cap; }
        this.formulaTrials = this.numberOfTrials;

        this.currentTrial = 0;
        this.bestLCP = 0;
        this.bestTransform = null;
        this.bestPairs = null;
        this.startTime = nowMs();

        /* 基准：原始位姿（单位阵）在下采样点上的覆盖率。
         * 后续任何候选必须严格超过它才会被采纳 —— 这就是
         * "算出来的还不如原始位姿就直接用原始位姿" 的实现方式。 */
        this.bestLCP = this.verify(IDENT4);
        this.baselineLCP = this.bestLCP;

        return true;
    };

    /* match4pcsBase.cc : distSegmentToSegment
     * 两条 3D 线段的最近点对，输出归一化参数 r1 / r2，并返回最近距离 */
    function distSegmentToSegment(p1, p2, q1, q2, out)
    {
        var ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2];
        var vx = q2[0] - q1[0], vy = q2[1] - q1[1], vz = q2[2] - q1[2];
        var wx = p1[0] - q1[0], wy = p1[1] - q1[1], wz = p1[2] - q1[2];

        var a = ux * ux + uy * uy + uz * uz;
        var b = ux * vx + uy * vy + uz * vz;
        var c = vx * vx + vy * vy + vz * vz;
        var d = ux * wx + uy * wy + uz * wz;
        var e = vx * wx + vy * wy + vz * wz;

        var f = a * c - b * b;
        var s1 = 0, s2 = f, t1 = 0, t2 = f;

        if (f < K_SMALL_NUMBER)
        {
            s1 = 0; s2 = 1; t1 = e; t2 = c;
        }
        else
        {
            s1 = b * e - c * d;
            t1 = a * e - b * d;

            if (s1 < 0) { s1 = 0; t1 = e; t2 = c; }
            else if (s1 > s2) { s1 = s2; t1 = e + b; t2 = c; }
        }

        if (t1 < 0)
        {
            t1 = 0;
            if (-d < 0) { s1 = 0; }
            else if (-d > a) { s1 = s2; }
            else { s1 = -d; s2 = a; }
        }
        else if (t1 > t2)
        {
            t1 = t2;
            if ((-d + b) < 0) { s1 = 0; }
            else if ((-d + b) > a) { s1 = s2; }
            else { s1 = -d + b; s2 = a; }
        }

        var r1 = (Math.abs(s1) < K_SMALL_NUMBER) ? 0 : (s2 !== 0 ? s1 / s2 : 0);
        var r2 = (Math.abs(t1) < K_SMALL_NUMBER) ? 0 : (t2 !== 0 ? t1 / t2 : 0);

        var ddx = wx + r1 * ux - r2 * vx;
        var ddy = wy + r1 * uy - r2 * vy;
        var ddz = wz + r1 * uz - r2 * vz;

        out.r1 = r1;
        out.r2 = r2;
        return Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    }

    /* match4pcsBase.cc : SelectRandomTriangle
     * 固定一点，随机取两点，保留叉积模最大（面积最大）的组合 */
    Registration.prototype.selectRandomTriangle = function (out)
    {
        var n = this.countP;
        var S = this.sampledP;
        var maxD = this.maxBaseDiameter;
        var maxD2 = maxD * maxD;

        var i1 = (Math.random() * n) | 0;
        var bestWide = -1;
        var b1 = -1, b2 = -1;

        for (var k = 0; k < K_NUMBER_OF_DIAMETER_TRIALS; k++)
        {
            var i2 = (Math.random() * n) | 0;
            var i3 = (Math.random() * n) | 0;
            if (i2 === i1 || i3 === i1 || i2 === i3) { continue; }

            var ux = S[i2 * 3] - S[i1 * 3];
            var uy = S[i2 * 3 + 1] - S[i1 * 3 + 1];
            var uz = S[i2 * 3 + 2] - S[i1 * 3 + 2];
            var wx = S[i3 * 3] - S[i1 * 3];
            var wy = S[i3 * 3 + 1] - S[i1 * 3 + 1];
            var wz = S[i3 * 3 + 2] - S[i1 * 3 + 2];

            var uu = ux * ux + uy * uy + uz * uz;
            var ww = wx * wx + wy * wy + wz * wz;
            if (uu > maxD2 || ww > maxD2) { continue; }

            var cx = uy * wz - uz * wy;
            var cy = uz * wx - ux * wz;
            var cz = ux * wy - uy * wx;
            var wide = Math.sqrt(cx * cx + cy * cy + cz * cz);

            if (wide > bestWide) { bestWide = wide; b1 = i2; b2 = i3; }
        }

        if (b1 < 0 || !(bestWide > 0)) { return false; }

        out[0] = i1; out[1] = b1; out[2] = b2;
        return true;
    };

    /* match4pcsBase.cc : SelectQuadrilateral
     * 前三点来自 SelectRandomTriangle，第 4 点全局扫描取"离平面最近" */
    Registration.prototype.selectQuadrilateral = function ()
    {
        var S = this.sampledP;
        var n = this.countP;
        var tri = [0, 0, 0];

        if (!this.selectRandomTriangle(tri)) { return false; }

        var i1 = tri[0], i2 = tri[1], i3 = tri[2];

        var x1 = S[i1 * 3], y1 = S[i1 * 3 + 1], z1 = S[i1 * 3 + 2];
        var x2 = S[i2 * 3], y2 = S[i2 * 3 + 1], z2 = S[i2 * 3 + 2];
        var x3 = S[i3 * 3], y3 = S[i3 * 3 + 1], z3 = S[i3 * 3 + 2];

        /* 平面 Ax+By+Cz=1 的系数（官方按 Cramer 展开） */
        var denom = (-x3 * y2 * z1 + x2 * y3 * z1 + x3 * y1 * z2
                   - x1 * y3 * z2 - x2 * y1 * z3 + x1 * y2 * z3);
        if (denom === 0) { return false; }

        var A = (-y3 * z2 + y2 * z3 + y3 * z1 - y1 * z3 - y2 * z1 + y1 * z2) / denom;
        var B = (x3 * z2 - x2 * z3 - x3 * z1 + x1 * z3 + x2 * z1 - x1 * z2) / denom;
        var C = (-x3 * y2 + x2 * y3 + x3 * y1 - x1 * y3 - x2 * y1 + x1 * y2) / denom;

        var tooSmall = Math.pow(this.maxBaseDiameter * K_BASE_TOO_SMALL, 2);
        var bestDist = Infinity;
        var i4 = -1;

        for (var i = 0; i < n; i++)
        {
            if (i === i1 || i === i2 || i === i3) { continue; }

            var px = S[i * 3], py = S[i * 3 + 1], pz = S[i * 3 + 2];

            var d1 = (px - x1) * (px - x1) + (py - y1) * (py - y1) + (pz - z1) * (pz - z1);
            if (d1 < tooSmall) { continue; }
            var d2 = (px - x2) * (px - x2) + (py - y2) * (py - y2) + (pz - z2) * (pz - z2);
            if (d2 < tooSmall) { continue; }
            var d3 = (px - x3) * (px - x3) + (py - y3) * (py - y3) + (pz - z3) * (pz - z3);
            if (d3 < tooSmall) { continue; }

            var dist = Math.abs(A * px + B * py + C * pz - 1);
            if (dist < bestDist) { bestDist = dist; i4 = i; }
        }

        if (i4 < 0) { return false; }

        return this.tryQuadrilateral(i1, i2, i3, i4);
    };

    /* match4pcsBase.cc : TryQuadrilateral
     * 枚举 12 种两两配对，取"两条线段最接近相交"的那一组，输出 r1/r2 */
    Registration.prototype.tryQuadrilateral = function (i1, i2, i3, i4)
    {
        var S = this.sampledP;
        var ids = [i1, i2, i3, i4];
        var pts = [
            [S[i1 * 3], S[i1 * 3 + 1], S[i1 * 3 + 2]],
            [S[i2 * 3], S[i2 * 3 + 1], S[i2 * 3 + 2]],
            [S[i3 * 3], S[i3 * 3 + 1], S[i3 * 3 + 2]],
            [S[i4 * 3], S[i4 * 3 + 1], S[i4 * 3 + 2]]
        ];

        var minDist = Infinity;
        var best = null;
        var tmp = { r1: 0, r2: 0 };
        var i, j, k, l;

        for (i = 0; i < 4; i++)
        {
            for (j = 0; j < 4; j++)
            {
                if (i === j) { continue; }

                k = 0; while (k === i || k === j) { k++; }
                l = 0; while (l === i || l === j || l === k) { l++; }

                var dd = distSegmentToSegment(pts[i], pts[j], pts[k], pts[l], tmp);

                if (dd < minDist)
                {
                    minDist = dd;
                    best = { a: i, b: j, c: k, d: l, r1: tmp.r1, r2: tmp.r2 };
                }
            }
        }

        if (!best) { return false; }

        this.base = [pts[best.a], pts[best.b], pts[best.c], pts[best.d]];
        this.baseIds = [ids[best.a], ids[best.b], ids[best.c], ids[best.d]];
        this.invariant1 = best.r1;
        this.invariant2 = best.r2;

        /* 两条基线的夹角余弦 —— FindCongruentQuadrilaterals 的方向约束 */
        var abx = this.base[1][0] - this.base[0][0];
        var aby = this.base[1][1] - this.base[0][1];
        var abz = this.base[1][2] - this.base[0][2];
        var cdx = this.base[3][0] - this.base[2][0];
        var cdy = this.base[3][1] - this.base[2][1];
        var cdz = this.base[3][2] - this.base[2][2];

        var la = Math.sqrt(abx * abx + aby * aby + abz * abz) || 1;
        var lc = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz) || 1;

        this.alpha = (abx / la) * (cdx / lc) + (aby / la) * (cdy / lc) + (abz / la) * (cdz / lc);

        return true;
    };

    /* ================================================================
     * IntersectionFunctor —— 官方 accelerators/pairExtraction/ 的分层求交
     *
     * 官方 ExtractPairs 不是逐点做半径查询，而是：
     *   1. 把 eps 吸附成 2 的负幂，据此确定八叉树深度 lvlMax = -log2(eps)；
     *   2. 从覆盖 [0,1]^3 的根节点逐层细分，
     *      每层【只保留与某个球壳相交的节点】，其余整枝丢弃；
     *   3. 节点内点数 <= minNodeSize 时停止分裂，存为 earlyNode；
     *   4. 第二遍按 primitive 遍历存活叶子，粗筛(2eps) + 精筛(eps) 输出点对。
     *
     * 复杂度对点数近似线性、对输出规模敏感 —— 这是 Super4PCS 能在一分钟内
     * 处理几十万点的根本原因。逐点 KD 半径查询写起来简单，但每个点都要
     * 走一趟树，实测在两片 2000 点上要跑出近 5000 万次查询。
     *
     * 本实现保留官方结构；差异只有：
     *   - 用索引数组 + 计数排序做节点切分（等价于 Node::split）；
     *   - 加了输出上限 limit。
     * ================================================================ */

    /* 官方 GetRoundedEpsilonValue：吸附到 2 的负幂 */
    function roundEpsilon(eps)
    {
        var lvlMax = Math.floor(-Math.log2(eps));
        if (!isFinite(lvlMax) || lvlMax < 1) { lvlMax = 1; }
        if (lvlMax > 9) { lvlMax = 9; }
        return { eps: 1 / Math.pow(2, lvlMax), lvlMax: lvlMax };
    }

    function shellHitsNode(pts, pi, node, r, tol)
    {
        var o = pi * 3;
        var dx = node.cx - pts[o];
        var dy = node.cy - pts[o + 1];
        var dz = node.cz - pts[o + 2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return Math.abs(d - r) <= tol;
    }

    function shellHitsPoint(pts, pi, qi, r, eps)
    {
        var a = pi * 3, b = qi * 3;
        var dx = pts[a] - pts[b];
        var dy = pts[a + 1] - pts[b + 1];
        var dz = pts[a + 2] - pts[b + 2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return Math.abs(d - r) <= eps;
    }

    /* 节点切分：按 8 卦限重排 ids[i0..i1) */
    function splitNode(pts, ids, node, out, halfEdge)
    {
        var i0 = node.i0, i1 = node.i1;
        var cnt = [0, 0, 0, 0, 0, 0, 0, 0];
        var i, o, b;

        for (i = i0; i < i1; i++)
        {
            o = ids[i] * 3;
            b = (pts[o] >= node.cx ? 1 : 0)
              | (pts[o + 1] >= node.cy ? 2 : 0)
              | (pts[o + 2] >= node.cz ? 4 : 0);
            cnt[b]++;
        }

        var start = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (i = 0; i < 8; i++) { start[i + 1] = start[i] + cnt[i]; }

        var buf = new Int32Array(i1 - i0);
        var pos = start.slice(0, 8);

        for (i = i0; i < i1; i++)
        {
            o = ids[i] * 3;
            b = (pts[o] >= node.cx ? 1 : 0)
              | (pts[o + 1] >= node.cy ? 2 : 0)
              | (pts[o + 2] >= node.cz ? 4 : 0);
            buf[pos[b]++] = ids[i];
        }
        for (i = 0; i < buf.length; i++) { ids[i0 + i] = buf[i]; }

        for (i = 0; i < 8; i++)
        {
            if (!cnt[i]) { continue; }
            out.push({
                cx: node.cx + ((i & 1) ? halfEdge : -halfEdge),
                cy: node.cy + ((i & 2) ? halfEdge : -halfEdge),
                cz: node.cz + ((i & 4) ? halfEdge : -halfEdge),
                i0: i0 + start[i],
                i1: i0 + start[i] + cnt[i]
            });
        }
    }

    /* 官方 IntersectionFunctor::process 的直译 */
    function processIntersection(pts, n, radius, epsIn, minNodeSize, limit, out)
    {
        var re = roundEpsilon(epsIn);
        var eps = re.eps;
        var lvlMax = re.lvlMax;

        var ids = new Int32Array(n);
        for (var i = 0; i < n; i++) { ids[i] = i; }

        var nodes = [];
        var children = [{ cx: 0.5, cy: 0.5, cz: 0.5, i0: 0, i1: n }];
        var early = [];
        var clvl = 0;

        /* 第一遍：自顶向下，只保留与球壳相交的格子 */
        while (clvl !== lvlMax - 1)
        {
            if (!children.length) { break; }

            var halfEdge = (1 / Math.pow(2, clvl)) / 2;

            nodes = children;
            children = [];

            for (var ni = 0; ni < nodes.length; ni++)
            {
                var nd = nodes[ni];
                var hit = false;

                for (var pi = 0; pi < n; pi++)
                {
                    if (shellHitsNode(pts, pi, nd, radius, halfEdge + eps)) { hit = true; break; }
                }
                if (!hit) { continue; }

                if (nd.i1 - nd.i0 > minNodeSize) { splitNode(pts, ids, nd, children, halfEdge); }
                else { early.push({ node: nd, tol: halfEdge + eps }); }
            }

            clvl++;
        }

        /* 调试计数（供诊断用，不影响算法） */
        processIntersection.dbg = {
            eps: eps,
            lvlMax: lvlMax,
            radius: radius,
            leaves: children.length,
            earlyLeaves: early.length,
            leafPoints: children.reduce(function (a, c) { return a + (c.i1 - c.i0); }, 0)
        };

        /* 第二遍：按 primitive 遍历存活叶子，粗筛 + 精筛 */
        for (var p = 0; p < n; p++)
        {
            var k, leaf, j, q;

            for (k = 0; k < children.length; k++)
            {
                leaf = children[k];
                if (!shellHitsNode(pts, p, leaf, radius, eps * 2)) { continue; }

                for (j = leaf.i0; j < leaf.i1; j++)
                {
                    q = ids[j];
                    if (!(p > q)) { continue; }
                    if (!shellHitsPoint(pts, p, q, radius, eps)) { continue; }

                    out.push([p, q]);
                    if (out.length >= limit) { return out; }
                }
            }

            for (k = 0; k < early.length; k++)
            {
                var e = early[k];
                if (!shellHitsNode(pts, p, e.node, radius, e.tol)) { continue; }

                for (j = e.node.i0; j < e.node.i1; j++)
                {
                    q = ids[j];
                    if (!(p > q)) { continue; }
                    if (!shellHitsPoint(pts, p, q, radius, eps)) { continue; }

                    out.push([p, q]);
                    if (out.length >= limit) { return out; }
                }
            }
        }

        return out;
    }

    /* super4pcs.cc : ExtractPairs
     * 找出"两点距离落在 [dist−eps, dist+eps] 内"的点对。
     * 官方用 PairCreationFunctor + IntersectionFunctor 的网格加速；
     * 这里用 KD 半径查询，语义等价。 */
    Registration.prototype.extractPairs = function (dist, eps, limit)
    {
        /* 走官方的分层求交（IntersectionFunctor），不再逐点做 KD 半径查询。 */
        var out = processIntersection(this.sampledQ, this.countQ, dist, eps, 50, limit, []);
        this.diag.is = processIntersection.dbg || null;
        this.diag.isOut = out.length;
        return out;
    };

    /* super4pcs.cc : FindCongruentQuadrilaterals
     * 用 IndexedNormalSet3D 把"P 侧点对 × Q 侧点对"的笛卡尔积
     * 压成「遍历 Q 点对 → 查一次索引」。 */
    Registration.prototype.findCongruentQuadrilaterals = function (pairs1, pairs2, quadrilaterals)
    {
        /* 单线程下必须给候选数上限。
         * 位置格子边长是 2δ 量级，一格里的点对数量随采样密度线性增长；
         * 官方靠 OpenMP 并行验证这些候选，串行跑会直接把帧时间吃掉。
         * 超上限就停：这是召回率与耗时的取舍，不是算法本身的一部分。 */
        var maxCongruent = this.options.maxCongruent || 300;

        var Q = this.sampledQ;
        var distThreshold = this.distFactorN;
        var eps = Math.max(1e-6, distThreshold);       // getNormalizedEpsilon

        var nset = new IndexedNormalSet3D(eps);
        var i;

        /* P 侧建索引：按 invariant1 插值得到"交点位置"，点对方向作为法向 */
        for (i = 0; i < pairs1.length; i++)
        {
            var a = pairs1[i][0] * 3, b = pairs1[i][1] * 3;
            var p1x = Q[a], p1y = Q[a + 1], p1z = Q[a + 2];
            var p2x = Q[b], p2y = Q[b + 1], p2z = Q[b + 2];

            var dx = p2x - p1x, dy = p2y - p1y, dz = p2z - p1z;
            var dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (!(dl > 1e-12)) { continue; }
            dx /= dl; dy /= dl; dz /= dl;

            var sh = this.indexShiftQ;
            var ix = p1x + this.invariant1 * (p2x - p1x) + sh[0];
            var iy = p1y + this.invariant1 * (p2y - p1y) + sh[1];
            var iz = p1z + this.invariant1 * (p2z - p1z) + sh[2];

            nset.addElement(ix, iy, iz, dx, dy, dz, i);
        }

        /* Q 侧查询：按 invariant2 插值 */
        var nei = [];
        var seen = Object.create(null);
        var alphaCos = this.alpha;

        for (i = 0; i < pairs2.length; i++)
        {
            var c = pairs2[i][0] * 3, d = pairs2[i][1] * 3;
            var q1x = Q[c], q1y = Q[c + 1], q1z = Q[c + 2];
            var q2x = Q[d], q2y = Q[d + 1], q2z = Q[d + 2];

            var ex = q1x + this.invariant2 * (q2x - q1x);
            var ey = q1y + this.invariant2 * (q2y - q1y);
            var ez = q1z + this.invariant2 * (q2z - q1z);

            var ndx = q2x - q1x, ndy = q2y - q1y, ndz = q2z - q1z;
            var ndl = Math.sqrt(ndx * ndx + ndy * ndy + ndz * ndz);
            if (!(ndl > 1e-12)) { continue; }
            ndx /= ndl; ndy /= ndl; ndz /= ndl;

            nei.length = 0;
            var shq = this.indexShiftQ;
            nset.getNeighbors(ex + shq[0], ey + shq[1], ez + shq[2],
                              ndx, ndy, ndz, alphaCos, false, nei);

            for (var t = 0; t < nei.length; t++)
            {
                var id = nei[t];

                /* 二次校验：用 P 侧该点对按 invariant1 重算插值点，与查询点比距离 */
                var pa = pairs1[id][0] * 3, pb = pairs1[id][1] * 3;
                var vx = Q[pa] + this.invariant1 * (Q[pb] - Q[pa]);
                var vy = Q[pa + 1] + this.invariant1 * (Q[pb + 1] - Q[pa + 1]);
                var vz = Q[pa + 2] + this.invariant1 * (Q[pb + 2] - Q[pa + 2]);

                var gx = ex - vx, gy = ey - vy, gz = ez - vz;
                if (gx * gx + gy * gy + gz * gz > distThreshold * distThreshold) { continue; }

                var key = id + ':' + i;
                if (seen[key]) { continue; }
                seen[key] = 1;

                quadrilaterals.push([pairs1[id][0], pairs1[id][1], pairs2[i][0], pairs2[i][1]]);

                if (quadrilaterals.length >= maxCongruent) { return true; }
            }
        }

        return quadrilaterals.length > 0;
    };

    /* match4pcsBase.cc : Verify（LCP 打分，带增量早停） */
    Registration.prototype.verify = function (M)
    {
        /* 方向必须是 P -> Q。
         *
         * M 由 solveRigid(base(P 侧四点), quad(Q 侧四点)) 求出，语义是
         * "把 P 变换到 Q"。所以拿【P 的点】做变换、在【Q 的密集树】里查。
         *
         * 之前写成了"变换 Q 的点、在 P 树里查"，方向相反 ——
         * 只有单位阵时两个方向恰好等价，所以初始基准看着正常（54%），
         * 但任何非单位阵的候选都会被这个反向度量判成低分，永远超不过基准。
         */
        var S = this.sampledP;
        var kd = this.kdEval;          // Q 侧密集树
        var n = this.countP;
        var delta = this.deltaN;

        var terminate = this.bestLCP * n;
        var good = 0;

        for (var i = 0; i < n; i++)
        {
            var px = S[i * 3], py = S[i * 3 + 1], pz = S[i * 3 + 2];

            var tx = M[0] * px + M[1] * py + M[2] * pz + M[3];
            var ty = M[4] * px + M[5] * py + M[6] * pz + M[7];
            var tz = M[8] * px + M[9] * py + M[10] * pz + M[11];

            var cand = kd.radius(tx, ty, tz, delta, 0);
            if (cand && cand.length) { good++; }

            /* 剩余点全中也追不上当前最优 → 放弃（官方 Verify 的增量早停） */
            if (n - i + good < terminate) { break; }
        }

        return good / n;
    };

    /* match4pcsBase.hpp : TryCongruentSet
     * 对每个候选四边形：求变换 → rms < 2δ 过滤 → Verify → 更新最优 */
    Registration.prototype.tryCongruentSet = function (quads)
    {
        var Q = this.sampledQ;
        var b = this.base;
        var rmsLimit = this.distFactorN;

        var maxVerify = this.options.maxCongruent || 300;

        for (var i = 0; i < quads.length && i < maxVerify; i++)
        {
            if (this.cancelled) { return false; }

            var q = quads[i];
            var qx = [
                [Q[q[0] * 3], Q[q[0] * 3 + 1], Q[q[0] * 3 + 2]],
                [Q[q[1] * 3], Q[q[1] * 3 + 1], Q[q[1] * 3 + 2]],
                [Q[q[2] * 3], Q[q[2] * 3 + 1], Q[q[2] * 3 + 2]],
                [Q[q[3] * 3], Q[q[3] * 3 + 1], Q[q[3] * 3 + 2]]
            ];

            var M = solveRigid([
                [b[0][0], b[0][1], b[0][2], qx[0][0], qx[0][1], qx[0][2]],
                [b[1][0], b[1][1], b[1][2], qx[1][0], qx[1][1], qx[1][2]],
                [b[2][0], b[2][1], b[2][2], qx[2][0], qx[2][1], qx[2][2]],
                [b[3][0], b[3][1], b[3][2], qx[3][0], qx[3][1], qx[3][2]]
            ]);

            if (!M) { continue; }

            /* rms 门限（官方 rms < distance_factor * delta） */
            var rms = 0, r;
            for (r = 0; r < 4; r++)
            {
                var pr = b[r];
                var tx = M[0] * pr[0] + M[1] * pr[1] + M[2] * pr[2] + M[3];
                var ty = M[4] * pr[0] + M[5] * pr[1] + M[6] * pr[2] + M[7];
                var tz = M[8] * pr[0] + M[9] * pr[1] + M[10] * pr[2] + M[11];
                var dx = tx - qx[r][0], dy = ty - qx[r][1], dz = tz - qx[r][2];
                rms += dx * dx + dy * dy + dz * dz;
            }
            rms = Math.sqrt(rms / 4);
            if (!(rms < rmsLimit)) { continue; }

            this.lastStats.congruent++;
            this.diag.rmsPass++;

            var lcp = this.verify(M);
            this.lastStats.verify++;
            this.diag.verifyRun++;
            if (lcp > this.diag.lcpBest) { this.diag.lcpBest = lcp; }

            if (lcp > this.bestLCP)
            {
                this.bestTransform = M;
                this.bestPairs = q.slice();
                this.bestLCP = lcp;

                if (this.bestLCP >= this.options.terminate_threshold) { return true; }
            }
        }

        return this.bestLCP >= this.options.terminate_threshold;
    };

    /* match4pcsBase.hpp : TryOneBase —— 一次完整 RANSAC 迭代 */
    Registration.prototype.tryOneBase = function ()
    {
        if (!this.selectQuadrilateral()) { this.diag.baseFail++; return false; }

        var b = this.base;
        var dab = Math.sqrt(
            Math.pow(b[1][0] - b[0][0], 2) +
            Math.pow(b[1][1] - b[0][1], 2) +
            Math.pow(b[1][2] - b[0][2], 2));
        var dcd = Math.sqrt(
            Math.pow(b[3][0] - b[2][0], 2) +
            Math.pow(b[3][1] - b[2][1], 2) +
            Math.pow(b[3][2] - b[2][2], 2));

        if (!(dab > 1e-9) || !(dcd > 1e-9)) { return false; }

        var pairLimit = this.options.pairLimit || 20000;
        var pairs1 = this.extractPairs(dab, this.distFactorN, pairLimit);
        this.diag.pairs1 = pairs1.length;
        if (!pairs1.length) { this.diag.pairFail++; return false; }

        var pairs2 = this.extractPairs(dcd, this.distFactorN, pairLimit);
        this.diag.pairs2 = pairs2.length;
        if (!pairs2.length) { this.diag.pairFail++; return false; }

        var quads = [];
        if (!this.findCongruentQuadrilaterals(pairs1, pairs2, quads)) { return false; }

        this.diag.quads = quads.length;
        this.diag.truncated = quads.length >= (this.options.maxCongruent || 300);

        return this.tryCongruentSet(quads);
    };

    /* match4pcsBase.hpp : Perform_N_steps —— RANSAC 主循环 */
    Registration.prototype.performSteps = function (n)
    {
        var o = this.options;
        var ok = false;
        var end = Math.min(this.currentTrial + n, this.numberOfTrials);

        for (var i = this.currentTrial; i < end; i++)
        {
            ok = this.tryOneBase();

            var elapsed = (nowMs() - this.startTime) / 1000;
            var fractionTime = elapsed / Math.max(1e-6, o.max_time_seconds);
            var fractionTry = i / Math.max(1, this.numberOfTrials);
            var fraction = Math.max(fractionTime, fractionTry);

            if (ok || fraction >= 0.99 || this.bestLCP >= 1.0 || this.cancelled) { break; }
        }

        this.currentTrial = end;
        this.lastStats.quarterAndCount = this.currentTrial;

        return ok || this.currentTrial >= this.numberOfTrials;
    };

    /* 归一化坐标系下的变换 → 物理坐标系
     * 归一化： x' = (x − cP)/s ，M 作用在 x' 上得到 y' = (y − cQ)/s
     * 所以  y = s·M·x' + cQ = R·x + (cQ − R·cP)  （R 已含在 M 的 3x3 里）
     */
    Registration.prototype.toGlobal = function (Mn)
    {
        if (!Mn) { return null; }

        var s = this.scale;
        var cP = this.centroidP;
        var cQ = this.centroidQ;

        var G = new Float64Array(16);
        G[0] = Mn[0]; G[1] = Mn[1]; G[2] = Mn[2];
        G[4] = Mn[4]; G[5] = Mn[5]; G[6] = Mn[6];
        G[8] = Mn[8]; G[9] = Mn[9]; G[10] = Mn[10];
        G[12] = 0; G[13] = 0; G[14] = 0; G[15] = 1;

        /* 归一化： p' = (p − cP)/s ，  q' = (q − cQ)/s
         * 变换在归一化系： q' = R·p' + tN
         * 换回物理系：     q  = R·p + (cQ − R·cP + s·tN)
         * 其中 (cQ − R·cP) 正是"质心差补偿"，与官方 getGlobalTransform 一致。 */
        G[3] = Mn[3] * s + cQ[0] - (Mn[0] * cP[0] + Mn[1] * cP[1] + Mn[2] * cP[2]);
        G[7] = Mn[7] * s + cQ[1] - (Mn[4] * cP[0] + Mn[5] * cP[1] + Mn[6] * cP[2]);
        G[11] = Mn[11] * s + cQ[2] - (Mn[8] * cP[0] + Mn[9] * cP[1] + Mn[10] * cP[2]);

        return orthonormalize(G);
    };

    /* ================= 对外接口 ================= */

    MV.super4pcs = MV.super4pcs || {};
    MV.super4pcs.OPTION_DEFAULTS = OPTION_DEFAULTS;

    /* 分步版本：每次 step 只跑一小批，供 UI 按帧驱动 */
    MV.super4pcs.createRegistration = function (P, Q, options)
    {
        if (!P || !Q || !P.positions || !Q.positions) { return null; }
        if (P.count < 4 || Q.count < 4) { return null; }

        var reg = new Registration(P, Q, options);
        if (!reg.init()) { return null; }

        var batch = (options && options.batch) || 20;

        return {
            step: function ()
            {
                reg.performSteps(batch);

                return {
                    done: reg.cancelled || reg.currentTrial >= reg.numberOfTrials ||
                          reg.bestLCP >= reg.options.terminate_threshold,
                    progress: reg.numberOfTrials
                        ? Math.min(1, reg.currentTrial / reg.numberOfTrials) : 1,
                    trial: reg.currentTrial,
                    trials: reg.numberOfTrials,
                    lcp: reg.bestLCP,
                    matrix: (options && options.preview) ? reg.toGlobal(reg.bestTransform) : null
                };
            },

            isDone: function ()
            {
                return reg.cancelled || reg.currentTrial >= reg.numberOfTrials ||
                       reg.bestLCP >= reg.options.terminate_threshold;
            },

            cancel: function () { reg.cancelled = true; },

            result: function ()
            {
                /* bestTransform 为 null 有两种情况：
                 *   1. 一次候选都没有 —— 用单位阵名义变换（toGlobal 会补质心差）
                 *   2. 居中后两侧已经重合（LCP 初始即 1.0），此时"补偿质心差"
                 *      本身就是正确答案，不需要额外的旋转平移。 */
                /* bestTransform 为 null 时说明：搜完全部尝试，
                 * 没有候选能超过"原始位姿"的覆盖率 —— 此时直接返回单位阵，
                 * 这也是用户要求的"不如原始位姿就用原始位姿"。 */
                var usedBaseline = !reg.bestTransform;
                var Mres = reg.bestTransform || IDENT4;

                return {
                    matrix: reg.toGlobal(Mres),
                    lcp: reg.bestLCP,
                    baselineLcp: reg.baselineLCP,
                    usedBaseline: usedBaseline,
                    trial: reg.currentTrial,
                    trials: reg.numberOfTrials,
                    stats: reg.lastStats,
                    diag: reg.diag,
                    scale: reg.scale,
                    deltaN: reg.deltaN,
                    countP: reg.countP,
                    evalDense: reg.evalDense,
                    distFactorN: reg.distFactorN
                };
            }
        };
    };

    /* 同步版本：一次算完 */
    MV.super4pcs.register = function (P, Q, options)
    {
        var r = MV.super4pcs.createRegistration(P, Q, options);
        if (!r) { return null; }

        var guard = 0;
        while (!r.step().done && guard++ < 100000) { }

        var res = r.result();
        return res.matrix;
    };

}(this));
