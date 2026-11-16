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
             *   - 视图里的序号标签一直挂着
             *   - renderPickBar 的判断是「未激活且无点才隐藏」，
             *     点还在就照样显示，信息栏也留在那儿
             * 下次进入拾取模式还会看到上次的残留。 */
            this.pickPoints = [];
            this.setPickCursor(false);
            hooks.notify('已退出拾取模式');
        }

        // pickPoints 已清空，这里传进去的就是空数组，信息栏随之隐藏
        hooks.renderPickBar(this.pickPoints || [], this.pickInfo);


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

    /* ---------------- 确定性伪随机源（mulberry32） ----------------
     *
     * ICP 的下采样原来用 `Math.random()`，后果是**同一份数据每次配准结果都不同**：
     * 采样到的点集变了 → 参与点数变了 → RMS 与迭代次数跟着变。
     * 实测同一初值连跑三次：rms = 1.258051 / 1.261276 / 1.265164，
     * 参与点 200876 / 200760 / 200785。用户看到的就是"同一对数据，配准时好时坏"。
     *
     * 换成固定种子重播：同一个 seed（默认 0）必得同一批采样点，
     * 于是 ICP 结果可复现，回归测试才有意义。需要另一组采样时传 opts.seed。 */
    var icpRngState = 0x9E3779B9;

    function icpSeed(s)
    {
        icpRngState = (s | 0) || 0x9E3779B9;
    }

    function icpRand()
    {
        icpRngState = (icpRngState + 0x6D2B79F5) | 0;
        var t = Math.imul(icpRngState ^ (icpRngState >>> 15), 1 | icpRngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

        /* 前段"放宽容差快速拉近"的放大倍数（trim-ICP 的常见技巧）。
         *
         * 默认 2 → 首轮容差 = 3×maxDist。这是为"初值差几十毫米"准备的；
         * 但初值本来就只有 0.3mm 残差时，63mm 的容差会把薄板另一侧、
         * 孔壁、装夹面全部当对应点，反而把好位姿拉偏：实测首轮后
         * RMS 0.35 → 9.6，第二轮 → 24.2，第三轮才回到 0.47，
         * 白烧两轮（每轮 1~4 秒）。调用方知道初值好坏，可以传更小的值。 */
        var trimBoost = (opts.trimBoost === undefined) ? 2 : Math.max(0, opts.trimBoost);

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

        /* 允许复用外部建好的 KD 树：固定点集不变时（候选验证、多级 ICP、收尾轮）
         * 每建一次就是一次 O(n log n)，36 万点约几十毫秒 —— 叠起来很可观。 */
        var kd = opts.kd || global.MV.kdtree.build(dstPos);
        if (!kd) { return null; }

        var nSrc = Math.floor(srcPos.length / 3);
        var nDst = Math.floor(dstPos.length / 3);
        if (!nSrc || !nDst) { return null; }

        var hasSrcN = !!srcNrm && srcNrm.length >= nSrc * 3;
        var hasDstN = !!dstNrm && dstNrm.length >= nDst * 3;

        /* 目标点集的包围盒。
         *
         * 用途：查询点离点云很远时直接跳过 KD 查询。
         *
         * 为什么必须跳过：KD 最近邻在「查询点位于点云之外」时**没有任何剪枝机会** ——
         * 树里所有平面距离都远小于当前的 bestD2，于是两棵子树都要访问，退化成全量扫描。
         * 实测 36 万点：查询点在点云内 ≈ 0ms，偏离 3 米时约 4~6ms/次。
         * ICP 初值不准时正是这种情况：十几万个点全在远处，一次迭代就是几百秒的量级，
         * 浏览器表现为「卡死 / 无响应」。
         * 而 maxDist 之外的点本来就不该参与匹配，跳过它不改变任何结果。 */
        var bminX = Infinity, bminY = Infinity, bminZ = Infinity;
        var bmaxX = -Infinity, bmaxY = -Infinity, bmaxZ = -Infinity;
        for (var bi2 = 0; bi2 < nDst; bi2++)
        {
            var bx = dstPos[bi2 * 3], by = dstPos[bi2 * 3 + 1], bz = dstPos[bi2 * 3 + 2];
            if (bx < bminX) { bminX = bx; }
            if (bx > bmaxX) { bmaxX = bx; }
            if (by < bminY) { bminY = by; }
            if (by > bmaxY) { bmaxY = by; }
            if (bz < bminZ) { bminZ = bz; }
            if (bz > bmaxZ) { bmaxZ = bz; }
        }

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

        /* 下采样：一次性抽取固定的索引集合，之后每轮都用同一批点。
         * 若每轮重新随机，RMS 会持续抖动、收敛判据失效。
         * 不采样时 idxList 保持 null，走零开销的全量遍历。
         *
         * 采样本身也必须是**确定性**的（见 icpRand 的注释）。 */
        var idxList = null;
        if (sampleRatio < 0.9999)
        {
            var want = Math.max(6, Math.round(nSrc * sampleRatio));

            if (want < nSrc)
            {
                icpSeed(opts.seed);

                var pool = new Int32Array(nSrc);
                for (var pi2 = 0; pi2 < nSrc; pi2++) { pool[pi2] = pi2; }

                // 部分 Fisher-Yates：只需要前 want 个（用确定性随机，不用 Math.random）
                for (var pi3 = 0; pi3 < want; pi3++)
                {
                    var pj = pi3 + Math.floor(icpRand() * (nSrc - pi3));
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
        var rmsHist = [];              // 最近 5 轮的 RMS（停滞早停用）

        /* 跑一轮，返回 { done, iters, rms, step, used } */
        /* 一轮迭代的累加状态；非空表示「有一轮正在分片累加」。
         *
         * 主线程路径每帧只喂一小批查询（step(budget)），把一次 200ms 的冻结
         * 拆成若干 40~50ms 的小块 —— 这就是「时间切片」。
         * Worker 路径、symmetric()、候选验证器调用 step() 不带参数，
         * 仍然一次扫完一轮，行为与数值完全不变。 */
        var acc = null;

        function step(queriesPerCall)
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
            if (!acc)
            {
                var curMaxDist0 = maxDist;
                if (maxDist > 0 && maxIter > 1)
                {
                    var decay = 1 - Math.min(1, iters / (maxIter * 0.66));
                    curMaxDist0 = maxDist * (1 + trimBoost * decay);
                }

                acc = {
                    A: new Float64Array(36),
                    b: new Float64Array(6),
                    cnt: 0,
                    sumSq: 0,
                    si: 0,
                    curMaxDist: curMaxDist0
                };
            }

            var A = acc.A;
            var b = acc.b;
            var curMaxDist = acc.curMaxDist;
            var cnt = acc.cnt;
            var sumSq = acc.sumSq;

            /* 本次最多扫多少个点；不带参数 = 一次扫完（等于原来的行为） */
            var budget = (queriesPerCall > 0) ? (queriesPerCall | 0) : nSamples;
            var startSi = acc.si;
            var stopSi = Math.min(nSamples, startSi + budget);

            for (var si = startSi; si < stopSi; si++)
            {
                var i = idxList ? idxList[si] : si;
                var p0 = i * 3;
                var sx = srcPos[p0], sy = srcPos[p0 + 1], sz = srcPos[p0 + 2];

                var px = R[0] * sx + R[1] * sy + R[2] * sz + t[0];
                var py = R[3] * sx + R[4] * sy + R[5] * sz + t[1];
                var pz = R[6] * sx + R[7] * sy + R[8] * sz + t[2];

                /* 先做 O(1) 的包围盒剔除：超出 maxDist 的点不可能有合法对应点 */
                if (curMaxDist > 0 &&
                    (px < bminX - curMaxDist || px > bmaxX + curMaxDist ||
                     py < bminY - curMaxDist || py > bmaxY + curMaxDist ||
                     pz < bminZ - curMaxDist || pz > bmaxZ + curMaxDist))
                {
                    continue;
                }

                /* 把 maxDist 交给 KD：超出阈值的点本来就会被下面丢掉，
                 * 提前当上界能把它当剪枝半径用（位姿还没收敛时尤其明显）。 */
                var qi = kd.nearestIndex(px, py, pz, curMaxDist);
                if (qi < 0) { continue; }

                var q0 = qi * 3;
                var qx = dstPos[q0], qy = dstPos[q0 + 1], qz = dstPos[q0 + 2];

                var dx = px - qx, dy = py - qy, dz = pz - qz;
                var d2 = dx * dx + dy * dy + dz * dz;

                if (curMaxDist > 0 && d2 > curMaxDist * curMaxDist) { continue; }

                var nx = 0, ny = 0, nz = 0;
                if (hasDstN) { nx = dstNrm[q0]; ny = dstNrm[q0 + 1]; nz = dstNrm[q0 + 2]; }

                /* 源法向必须跟着当前旋转走 —— 这是配准里最容易错的一处：
                 * 点已经按 R 转过来了，法向却还用原始方向。
                 * 旋转小时看不出来，一旦初值带 90°/180°（正是粗配准该给的东西），
                 * 法向点积全部不过阈值，对应点被整批丢弃，
                 * 于是「正确的粗位姿」在验证里反而显得很差，被丢弃回退到质心对齐。 */
                var mx = 0, my = 0, mz = 0;
                if (hasSrcN)
                {
                    var snx = srcNrm[p0], sny = srcNrm[p0 + 1], snz = srcNrm[p0 + 2];
                    mx = R[0] * snx + R[1] * sny + R[2] * snz;
                    my = R[3] * snx + R[4] * sny + R[5] * snz;
                    mz = R[6] * snx + R[7] * sny + R[8] * snz;
                }

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

            /* 存回累加器：下一片从这里继续 */
            acc.si = stopSi;
            acc.cnt = cnt;
            acc.sumSq = sumSq;

            if (stopSi < nSamples)
            {
                /* 本轮没扫完 —— 不是迭代结束，iters / R / t 都不动 */
                return { done: false, partial: true, iters: iters, rms: lastRms,
                         step: 0, used: used };
            }

            /* 一轮扫完：清掉累加器，照原逻辑求解 */
            acc = null;

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

            /* 停滞早停：法向对称项下 RMS 常常进入"每轮只降万分之几"的长尾，
             * tol=1e-7 的步长判据永远等不到，白跑二三十轮（每轮 0.5 秒）。
             *
             * 用「最近 5 轮窗口的相对极差 < 0.5%」而不是"连续 N 轮每轮降幅 < x%"：
             * 逐轮判据在临界点会抖 —— 降幅 0.09% / 0.11% 交替出现时，计数器反复清零，
             * 同一份数据有时 11 轮停、有时 28 轮停（实测耗时 4.1s ~ 11.6s）。
             * 窗口判据看的是累计效果，正常收敛期 5 轮降幅合计在 3% 以上，不会误判。 */
            rmsHist.push(rms);
            if (rmsHist.length > 5) { rmsHist.shift(); }
            if (rmsHist.length === 5)
            {
                var mx = rmsHist[0], mn = rmsHist[0];
                for (var h = 1; h < 5; h++)
                {
                    if (rmsHist[h] > mx) { mx = rmsHist[h]; }
                    if (rmsHist[h] < mn) { mn = rmsHist[h]; }
                }
                if (mx > 0 && (mx - mn) / mx < 0.005) { converged = true; }
            }

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


    /* 候选验证：在**子集**上跑固定轮数的 ICP，用收敛后的残差排序。
     *
     * 为什么不能只看初始残差（更不能只看 4PCS 的 LCP）：
     *   实测 844mm 的数据集里，对称错解的**初始**残差 10.8mm 反而低于正确的
     *   质心对齐 19.5mm（错解在局部确实更贴合），但迭代 50 轮后是
     *   15.9mm vs 3.35mm。排序信号只在「收敛后」出现，必须迭代。
     *
     * 为什么可以只在子集上跑：
     *   验证只需要**相对可比**。实测 8000/20000 的子集给出 19.62 / 3.44，
     *   与全量 20.06 / 3.39 完全同序。
     *
     * 候选数量：搜索解 + 质心对齐 + 主轴 24 假设 = 26 个。全跑 12 轮 ICP 要好几秒
     * （每个 12 轮 × 8000 点 ≈ 0.35s），所以先按 screen() 的命中率粗筛取前 5，
     * 计算量约 48 万次最近邻；排序结论与全量验证一致（实测多次复用同一顺序）。
     */
    function createVerifier(srcPos, srcNrm, dstPos, dstNrm, opts)
    {
        opts = opts || {};

        var maxSrc = opts.maxSrc || 8000;
        var maxDst = opts.maxDst || 20000;
        var iters = opts.iters || 12;

        function take(pos, nrm, maxN)
        {
            var n = Math.floor(pos.length / 3);
            if (!n) { return null; }

            /* 用 round 而不是 floor：floor(38466/20000)=1 等于没抽稀，
             * 而 38466 个点的 KD 建树成本正是要省的那部分。 */
            var stride = Math.max(1, Math.round(n / Math.min(n, maxN)));

            var outPos = [], outNrm = nrm ? [] : null;
            var cnt = 0;

            for (var i = 0; i < n; i += stride)
            {
                outPos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                if (outNrm) { outNrm.push(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]); }
                cnt++;
            }

            return {
                pos: new Float32Array(outPos),
                nrm: outNrm ? new Float32Array(outNrm) : null,
                count: cnt
            };
        }

        var S = take(srcPos, srcNrm, maxSrc);
        var D = take(dstPos, dstNrm, maxDst);
        if (!S || !D) { return null; }

        var kd = global.MV.kdtree.build(D.pos);
        if (!kd) { return null; }

        /* 粗筛用的更小源子集：候选有几十个时（PCA 24 假设 + 搜索解），
         * 每个都跑 12 轮 ICP 代价太高（实测 26 个候选 ≈ 9 s）。
         * 先按"delta 内的命中率"排一次序，只让排在前面的几个进完整验证。 */
        var SS = take(srcPos, srcNrm, opts.maxScreenSrc || 1500);
        var screenTol = opts.screenTol || 0;
        var screenTol2 = screenTol * screenTol;

        return {
            kd: kd,
            srcCount: S.count,
            dstCount: D.count,

            /* 廉价打分：变换后落在目标 delta 内的比例（不迭代） */
            screen: function (mat)
            {
                if (!(screenTol > 0) || !SS) { return { hit: 0, med: Infinity }; }

                var n = SS.count;
                var good = 0;
                var ds = new Float64Array(n);

                for (var i = 0; i < n; i++)
                {
                    var px = SS.pos[i * 3], py = SS.pos[i * 3 + 1], pz = SS.pos[i * 3 + 2];
                    var tx = mat[0] * px + mat[1] * py + mat[2] * pz + mat[3];
                    var ty = mat[4] * px + mat[5] * py + mat[6] * pz + mat[7];
                    var tz = mat[8] * px + mat[9] * py + mat[10] * pz + mat[11];

                    var nb = kd.nearest(tx, ty, tz);
                    var d2 = nb ? nb.dist2 : Infinity;
                    ds[i] = d2;
                    if (d2 <= screenTol2) { good++; }
                }

                var tmp = Array.prototype.slice.call(ds).sort(function (a, b) { return a - b; });
                return { hit: good / n, med: Math.sqrt(tmp[Math.floor(n / 2)]) };
            },

            score: function (mat)
            {
                var s = createSolver(S.pos, S.nrm, D.pos, D.nrm,
                    {
                        maxIter: iters,
                        sampleRatio: 1,
                        normalThresh: opts.normalThresh,
                        tol: opts.tol || 1e-7,
                        maxDist: opts.maxDist || 0,
                        initMat: mat,
                        kd: kd
                    });

                if (!s) { return { rms: Infinity, used: 0, iters: 0 }; }

                var k = 0, r = null;
                do { r = s.step(); k++; } while (!r.done && k < iters + 2);

                var res = s.result();
                return { rms: res.rms, used: res.used, iters: res.iters };
            }
        };
    }

    /* ---------------- 主轴（PCA）多假设种子 ----------------
     *
     * 4PCS 终究是"随机采样共面 4 点 + 离散匹配"的搜索，姿态差越大越吃粒度：
     * 候选四边形的位姿精度受采样点间距和判据容差限制（修好方向判据后仍有
     * 2~4° 的残差），而且姿态差大时要靠运气才能采到正确的基。
     *
     * 而同一工件的两次测量、或 CAD 与实测，主轴是稳定可用的：把两侧主轴
     * 对齐只需枚举 6 种轴置换 × 8 种符号（取行列式 +1 的 24 个真旋转），
     * 计算量是一次 PCA，与点数线性相关。其中一个就落在真值附近，
     * 交给廉价粗筛 + ICP 验证挑选即可。
     *
     * 返回 { mats: [24 个 4×4], confidence: 0~1 }。
     * 矩阵语义与 super4pcs 一致（把 src 变换到 dst、row-major、末行 0,0,0,1）。
     * confidence 是两侧特征值谱的吻合度：薄板 / 细长件 / 旋转体的主轴退化，
     * 这时种子彼此重叠、粗筛挑不出好解，上层可以据此降低对它的依赖。
     */
    function det3of(R)
    {
        return R[0] * (R[4] * R[8] - R[5] * R[7])
             - R[1] * (R[3] * R[8] - R[5] * R[6])
             + R[2] * (R[3] * R[7] - R[4] * R[6]);
    }

    function pcaCandidates(srcPos, srcCount, dstPos, dstCount, opts)
    {
        opts = opts || {};
        var a = pcaOf(srcPos, srcCount, opts.stride || Math.max(1, Math.round((srcCount || (srcPos.length / 3)) / 20000)));
        var b = pcaOf(dstPos, dstCount, opts.strideDst || Math.max(1, Math.round((dstCount || (dstPos.length / 3)) / 20000)));
        if (!a || !b) { return { mats: [], confidence: 0 }; }

        var out = [];
        var perm = [0, 1, 2];
        var i, r, c, n;

        function emit()
        {
            for (var mask = 0; mask < 8; mask++)
            {
                var R = [0, 0, 0, 0, 0, 0, 0, 0, 0];

                for (i = 0; i < 3; i++)
                {
                    var qa = b.axes[perm[i]];
                    var pa = a.axes[i];
                    var s = (mask & (1 << i)) ? -1 : 1;
                    for (r = 0; r < 3; r++)
                    {
                        for (c = 0; c < 3; c++) { R[r * 3 + c] += s * qa[r] * pa[c]; }
                    }
                }

                /* 只保留真旋转：反射解（det<0）刚体变换做不到 */
                if (det3of(R) < 0) { continue; }

                var M = new Float64Array(16);
                M[0] = R[0]; M[1] = R[1]; M[2] = R[2];
                M[4] = R[3]; M[5] = R[4]; M[6] = R[5];
                M[8] = R[6]; M[9] = R[7]; M[10] = R[8];
                M[3] = b.center[0] - (R[0] * a.center[0] + R[1] * a.center[1] + R[2] * a.center[2]);
                M[7] = b.center[1] - (R[3] * a.center[0] + R[4] * a.center[1] + R[5] * a.center[2]);
                M[11] = b.center[2] - (R[6] * a.center[0] + R[7] * a.center[1] + R[8] * a.center[2]);
                M[15] = 1;

                out.push(M);
            }
        }

        /* 6 种轴置换 */
        var idx = [0, 1, 2];
        (function rec(k)
        {
            if (k === 3) { perm = [idx[0], idx[1], idx[2]]; emit(); return; }
            for (var m = k; m < 3; m++)
            {
                var t = idx[k]; idx[k] = idx[m]; idx[m] = t;
                rec(k + 1);
                t = idx[k]; idx[k] = idx[m]; idx[m] = t;
            }
        })(0);

        /* 特征值退化（薄板 / 细长件 / 旋转体）时主轴不可靠，按特征值谱的
         * 差异给一个可靠度，供上层参考；退化严重时种子会互相重叠，
         * 粗筛自然挑不出好解，不影响正确性。 */
        var evA = a.values, evB = b.values;
        var sumA = Math.max(1e-9, Math.abs(evA[0]) + Math.abs(evA[1]) + Math.abs(evA[2]));
        var sumB = Math.max(1e-9, Math.abs(evB[0]) + Math.abs(evB[1]) + Math.abs(evB[2]));
        var conf = 0;
        for (n = 0; n < 3; n++) { conf += Math.abs(Math.abs(evA[n]) / sumA - Math.abs(evB[n]) / sumB); }
        conf = Math.max(0, 1 - conf * 2);

        return { mats: out, confidence: conf };
    }

    global.MV.icp = {
        symmetric: symmetric,
        createSolver: createSolver,
        createVerifier: createVerifier,
        computeVertexNormals: computeVertexNormals,
        pcaOf: pcaOf,
        pcaCandidates: pcaCandidates,
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
 *                                                （已简化为 PositionHash3D，见下）
 *   src/super4pcs/shared4pcs.h                   Match4PCSOptions 默认值
 *
 * 与原版的已知差异（均为运行环境所迫或实测必要，已在各处注明）：
 *   1. ComputeRigidTransformation 用 Horn 四元数代替官方 SVD，
 *      二者都是最小二乘刚体解，数学等价；
 *   2. 单线程（官方有 OpenMP 并行验证候选）；
 *   3. 主循环提供按帧让出的分步接口，避免长时间阻塞浏览器主线程；
 *   4. 点对提取不用官方的八叉树分层求交，改用 KD 环形查询（ExtractPairs 注释里有
 *      完整理由：官方那套的第一遍剪枝以节点自身中心为球心，语义上不成立）；
 *      因此"坐标必须平移到 [0,1)³"这条约束也不再需要，只有位置哈希还用到偏移；
 *   5. 法向分箱那一维去掉，改成格内精确点积判角（原因见 PositionHash3D）；
 *   6. 点对朝向显式枚举、ε 向下对齐、基四边形合法性校验、抽样用固定种子
 *      （见各函数注释）；
 *   7. Verify 的早停阈值默认提到 0.98（0.85 会被 180° 翻转解骗停）；
 *      候选验证按 4 点残差升序取前 N，而不是按收集顺序。
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
        maxCongruent: 300,      // 每次尝试最多收集多少个候选四边形
        maxVerify: 40,          // 每个候选四边形集最多做几次 LCP 验证（按 rms 升序取前 N）
        maxTrials: 0,           // 0 表示用官方公式算出的迭代数
        seed: 0                 // 0 = 用内置固定种子；置非 0 可换一组可复现的随机序列
    };

    /* 原 normalset.h 的 IndexedNormalSet3D 只保留了位置那一维（见 PositionHash3D），
     * 法向分箱已去掉 —— 原因写在 PositionHash3D 的注释里。 */

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

    /* ================= 位置哈希（原 IndexedNormalSet3D 的简化） ================= */
    /*
     * 官方 normalset.h 是「位置格子 × 法向 7³ 分箱」的双维度索引，查询时沿
     * 圆锥母线圆周采样若干方向、只取被采样到的角度格。保留位置那一维，
     * 去掉法向那一维：
     *
     *   1. 法向分箱每维 7 档，一个格子约 15°，比我们需要的角度判据（~4°）
     *      粗了 4 倍，正确构型常常被就近分到隔壁格子里直接漏掉；
     *   2. 官方靠"沿圆周采样被占用的角度格"控制查询代价，采样数最少只有 4，
     *      覆盖率 4/343 —— 真解基本没机会被采样到；
     *   3. 去掉这一维后，查询时对位置格内条目做精确点积判角，判据不再有
     *      量化误差，而且格内条目本来就少（位置格边长 ~2δ），代价可控。
     *
     * 结果：候选四边形的 4 点拟合残差从 0.17（≈15° 方向误差）降到 0.02
     * （≈2°），真解第一次被真正找到。
     */
    function PositionHash3D(epsilon)
    {
        /* 官方把 epsilon 向下对齐到 2 的幂：gridDepth = -log2(eps) */
        var gridDepth = Math.floor(-Math.log2(epsilon));
        if (!isFinite(gridDepth)) { gridDepth = 0; }
        if (gridDepth < 1) { gridDepth = 1; }
        if (gridDepth > 10) { gridDepth = 10; }     // 兜底：10^3 = 1024 格，避免内存失控

        this.egSize = Math.pow(2, gridDepth);
        this.epsilon = 1 / this.egSize;
        this.grid = new Array(Math.pow(this.egSize, 3));   // 惰性分配，初值全 undefined
    }

    PositionHash3D.prototype.indexPos = function (x, y, z)
    {
        var inv = 1 / this.epsilon;
        return unrollIndexLoop(x * inv, y * inv, z * inv, this.egSize);
    };

    PositionHash3D.prototype.add = function (px, py, pz, id)
    {
        var pId = this.indexPos(px, py, pz);
        if (pId === -1) { return false; }

        var cell = this.grid[pId];
        if (!cell) { cell = this.grid[pId] = []; }
        cell.push(id);

        return true;
    };

    /* 位置格内所有条目（方向判据由调用方用精确点积完成） */
    PositionHash3D.prototype.allInCell = function (px, py, pz, out)
    {
        var pId = this.indexPos(px, py, pz);
        if (pId === -1) { return; }

        var cell = this.grid[pId];
        if (!cell) { return; }

        for (var i = 0; i < cell.length; i++) { out.push(cell[i]); }
    };

    /* ================= 均匀采样（sampling.h 的 UniformDistSampler） ================= */

    /* 确定性伪随机源（mulberry32）。
     *
     * 4PCS 的抽样、取基、直径估计全依赖随机数。用 Math.random 的后果是
     * 同一份数据两次运行给出不同结果 —— 实测同一对点云一次 LCP 0.54、
     * 下一次 0.23（差到"能用/不能用"），用户看到的就是「粗配准时好时坏」。
     * 换成按固定种子重播的 PRNG：每次 init 重置种子，同一输入必得同一输出，
     * 便于复现问题，也让 ICP 的最终结果可重复。 */
    var rngState = 0x9E3779B9;

    function setRngSeed(s)
    {
        rngState = (s | 0) || 0x9E3779B9;
    }

    function rnd()
    {
        rngState = (rngState + 0x6D2B79F5) | 0;
        var t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

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
            var j = i + Math.floor(rnd() * (total - i));
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
            var j = i + Math.floor(rnd() * (count - i));
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
        this.kdTreeQ = null;       // 建在 sampledQ 上（点对提取）
        this.kdEval = null;        // 建在密集评分云上（LCP 打分）
        this.evalDense = 0;

        this.base = [null, null, null, null];
        this.baseIds = [0, 0, 0, 0];
        this.bestLCP = 0;
        this.baselineLCP = 0;
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
            pairFail: 0,        // 点对提取为空的次数
            rmsMin: 9,          // 候选四边形的最小 rms（归一化）
            rmsN: 0,            // 实际算过 rms 的候选数
            nullM: 0            // solveRigid 返回空的次数
        };
    }

    /* match4pcsBase.hpp : init */
    Registration.prototype.init = function ()
    {
        var o = this.options;

        /* 每次求解都从同一个种子重播：抽样 / 取基 / 直径估计全部可复现 */
        setRngSeed(o.seed);

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
         * 但位置哈希（PositionHash3D）要求坐标 ∈ [0,1)（内部 floor(p/_epsilon)），
         * 质心系下坐标是 [-0.5, 0.5]。两者用一个常数偏移衔接：
         *     索引坐标 = 变换坐标 + (centroid − bboxMin) / scale
         * 偏移是常数，不影响任何距离与比值，只用于满足索引的非负要求。
         * （点对提取走 KD 环形查询，不需要这个偏移；只有点对交点索引要用。） */
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
         *   kdTreeQ —— ExtractPairs 在目标采样云里找"与基线等长的点对"
         *   kdEval  —— Verify（LCP 打分）把 P 侧点变换后拿去查，统计命中率
         *
         * 两者都必须建在【Q 侧】。曾经只建了一棵且用来"Q 查 Q"：
         * 单位阵下每个查询点就是它本身，距离恒为 0，LCP 永远 1.0 ——
         * 算法一开始就认为"已经配准好了"，一次搜索都不做。 */
        this.kdTreeQ = MV.kdtree.build(this.sampledQ);
        if (!this.kdTreeQ) { return false; }

        /* 评分专用密集点云（建在 Q 上，与 sampledQ 同坐标系）。
         *
         * 为什么必须比 sample_size 密：verify 的命中容差是 delta，而 sample_size
         * 只有 2500 点，间距约 scale/sqrt(2500)。若 delta 小于这个间距，
         * 即使【完全对齐】也只有一半点能命中 —— bestLCP 的天花板被锁在 50%
         * 附近，而初始基准（原始位姿）随手就能达到这个量级，
         * 于是任何候选都超不过基准，搜索等于空转。
         *
         * 用 evalDense 点建树后，间距 = scale/sqrt(evalDense)，
         * delta 才有意义。
         *
         * 另外必须从【原始点云】抽样，不能从 sq 抽 ——
         * sq 已经是 sample_size 抽稀后的结果，从它再抽只能得到更稀疏的子集，
         * 间距一点没变。这正是"密集评分树"名不副实、delta 失去区分力的原因。 */
        var evalDense = Math.min(o.evalDense || 20000, this.Q.count);
        this.evalDense = evalDense;

        var evalIdx = pickIdx(this.Q.count, evalDense);
        var evalPos = new Float64Array(evalDense * 3);

        for (i = 0; i < evalDense; i++)
        {
            evalPos[i * 3] = (this.Q.positions[evalIdx[i] * 3] - cQ[0]) / scale;
            evalPos[i * 3 + 1] = (this.Q.positions[evalIdx[i] * 3 + 1] - cQ[1]) / scale;
            evalPos[i * 3 + 2] = (this.Q.positions[evalIdx[i] * 3 + 2] - cQ[2]) / scale;
        }

        this.kdEval = MV.kdtree.build(evalPos);
        if (!this.kdEval) { return false; }

        /* 归一化后的各项距离 */
        this.deltaN = o.delta / scale;
        this.distFactorN = DISTANCE_FACTOR * this.deltaN;

        /* 直径估计：1000 次随机点对取最大（官方注释即"近似"） */
        var diameter = 0;
        for (i = 0; i < K_NUMBER_OF_DIAMETER_TRIALS; i++)
        {
            var at = (rnd() * this.countQ) | 0;
            var bt = (rnd() * this.countQ) | 0;
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

        var i1 = (rnd() * n) | 0;
        var bestWide = -1;
        var b1 = -1, b2 = -1;

        for (var k = 0; k < K_NUMBER_OF_DIAMETER_TRIALS; k++)
        {
            var i2 = (rnd() * n) | 0;
            var i3 = (rnd() * n) | 0;
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
        /* 两条基线的最近距离：真正的 4PCS 基要求它们【真的相交】。
         * 落在端点（r=0 或 1）说明两条线段不相交、只是在端点附近擦过，
         * 此时不变量退化成一个端点坐标，等长匹配的约束整体失效，
         * 后续候选四边形全是噪声（实测这类基占多数，rms 永远进不了门限）。 */
        this.baseMinDist = minDist;

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

    /* super4pcs.cc : ExtractPairs
     * 找出"两点距离落在 [dist−eps, dist+eps] 内"的点对。
     *
     * 用 KD 树的【环形查询】（下界 dist−eps、上界 dist+eps）。之前走的是
     * 官方的八叉树分层求交，但那套实现的第一遍"只保留与球壳相交的格子"
     * 是以节点自身中心为球心的，语义上并不成立：扫全云时几乎每个节点都留、
     * 起不到剪枝作用（实测量级的一半时间花在这）；只扫本节点的点又会把
     * 真解全剪掉（实测 pairs 直接归零）。
     * 这里改成逐点的环形查询 —— 语义直白（正是"等距点对"的定义），
     * 采样规模只有 sample_size（2500），一次环查只回壳上的几个点。 */
    Registration.prototype.extractPairs = function (dist, eps, limit)
    {
        var out = [];
        var kd = this.kdTreeQ;
        var Q = this.sampledQ;
        var n = this.countQ;
        var rMax = dist + eps;
        var rMin = Math.max(0, dist - eps);

        for (var p = 0; p < n; p++)
        {
            var cand = kd.radius(Q[p * 3], Q[p * 3 + 1], Q[p * 3 + 2], rMax, rMin);
            for (var k = 0; k < cand.length; k++)
            {
                var q = cand[k];
                /* 每对只出现一次（按点号定序，与遍历顺序无关） */
                if (q >= p) { continue; }

                out.push([p, q]);
                if (out.length >= limit) { return out; }
            }
        }

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

        var nset = new PositionHash3D(eps);
        var i, o;
        var sh = this.indexShiftQ;
        var r1 = this.invariant1;
        var r2 = this.invariant2;
        var alphaCos = this.alpha;

        /* 方向判据的容差。基与候选都是"采样点上的线段"，方向只差噪声，
         * 用余弦差 0.06（约 4°）足够；比 7³ 分箱的 ~15° 量化严到可用。 */
        var angTol = this.options.angTol || 0.06;

        /* 每条索引条目对应的线段方向（供精确判角） */
        var dirs = new Float64Array(pairs1.length * 3);

        /* 建索引。注意：ExtractPairs 输出的点对下标顺序是【索引大小序】
         * （extractPairs 里按点号 q < p 定序），与几何朝向无关；而不变量 r
         * 是"从点对第一个端点量起的比例"，天然有向。
         * 只按一种朝向建索引，等于假设目标侧线段的端点顺序恰好与基一致 ——
         * 实际只有约一半命中，其余全部算到镜像位置上（误差 = |1−2r|·L），
         * 表现为「候选四边形 rms 永远进不了门限」。
         * 因此每个点对按【两种朝向】各插一条索引，查询侧同样两种朝向都试，
         * 命中时按朝向把端点顺序还原，得到真正对应的四边形。 */
        for (i = 0; i < pairs1.length; i++)
        {
            var a = pairs1[i][0] * 3, b = pairs1[i][1] * 3;
            var p1x = Q[a], p1y = Q[a + 1], p1z = Q[a + 2];
            var p2x = Q[b], p2y = Q[b + 1], p2z = Q[b + 2];

            var dx = p2x - p1x, dy = p2y - p1y, dz = p2z - p1z;
            var dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (!(dl > 1e-12)) { continue; }
            dx /= dl; dy /= dl; dz /= dl;

            dirs[i * 3] = dx; dirs[i * 3 + 1] = dy; dirs[i * 3 + 2] = dz;

            /* 朝向 0：p1 → p2，取 r1 处的点 */
            nset.add(p1x + r1 * (p2x - p1x) + sh[0],
                     p1y + r1 * (p2y - p1y) + sh[1],
                     p1z + r1 * (p2z - p1z) + sh[2],
                     2 * i);

            /* 朝向 1：p2 → p1，同一点但方向取反 */
            nset.add(p1x + (1 - r1) * (p2x - p1x) + sh[0],
                     p1y + (1 - r1) * (p2y - p1y) + sh[1],
                     p1z + (1 - r1) * (p2z - p1z) + sh[2],
                     2 * i + 1);
        }

        /* 查询侧：两种朝向都查 */
        var nei = [];
        var seen = Object.create(null);

        for (i = 0; i < pairs2.length; i++)
        {
            var c = pairs2[i][0] * 3, d = pairs2[i][1] * 3;
            var q1x = Q[c], q1y = Q[c + 1], q1z = Q[c + 2];
            var q2x = Q[d], q2y = Q[d + 1], q2z = Q[d + 2];

            var ndx = q2x - q1x, ndy = q2y - q1y, ndz = q2z - q1z;
            var ndl = Math.sqrt(ndx * ndx + ndy * ndy + ndz * ndz);
            if (!(ndl > 1e-12)) { continue; }
            ndx /= ndl; ndy /= ndl; ndz /= ndl;

            for (o = 0; o < 2; o++)
            {
                var ex = q1x + (o ? (1 - r2) : r2) * (q2x - q1x);
                var ey = q1y + (o ? (1 - r2) : r2) * (q2y - q1y);
                var ez = q1z + (o ? (1 - r2) : r2) * (q2z - q1z);
                var sgn = o ? -1 : 1;

                nei.length = 0;
                nset.allInCell(ex + sh[0], ey + sh[1], ez + sh[2], nei);

                for (var t = 0; t < nei.length; t++)
                {
                    var enc = nei[t];
                    var id = enc >> 1;
                    var o1 = enc & 1;

                    /* 精确方向判据：两条基线的夹角必须与基一致。
                     * 候选线段方向 = 朝向修正后的 dirs[id]，查询方向见上。 */
                    var ux = dirs[id * 3], uy = dirs[id * 3 + 1], uz = dirs[id * 3 + 2];
                    var cw = sgn * ndx * (o1 ? -ux : ux)
                           + sgn * ndy * (o1 ? -uy : uy)
                           + sgn * ndz * (o1 ? -uz : uz);
                    if (Math.abs(cw - alphaCos) > angTol) { continue; }

                    /* 位置校验：按该条索引的朝向重算插值点，与查询点比距离 */
                    var pa = pairs1[id][0] * 3, pb = pairs1[id][1] * 3;
                    var rr = o1 ? (1 - r1) : r1;
                    var vx = Q[pa] + rr * (Q[pb] - Q[pa]);
                    var vy = Q[pa + 1] + rr * (Q[pb + 1] - Q[pa + 1]);
                    var vz = Q[pa + 2] + rr * (Q[pb + 2] - Q[pa + 2]);

                    var gx = ex - vx, gy = ey - vy, gz = ez - vz;
                    if (gx * gx + gy * gy + gz * gz > distThreshold * distThreshold) { continue; }

                    var key = enc + ':' + i + ':' + o;
                    if (seen[key]) { continue; }
                    seen[key] = 1;

                    /* 按朝向还原端点顺序：第一段是 P 侧基线的像，第二段是第二条 */
                    quadrilaterals.push([
                        o1 ? pairs1[id][1] : pairs1[id][0],
                        o1 ? pairs1[id][0] : pairs1[id][1],
                        o ? pairs2[i][1] : pairs2[i][0],
                        o ? pairs2[i][0] : pairs2[i][1]
                    ]);

                    if (quadrilaterals.length >= maxCongruent) { return true; }
                }
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
        var delta = this.deltaN;
        var n = this.countP;

        var terminate = this.bestLCP * n;
        var good = 0;

        for (var i = 0; i < n; i++)
        {
            var px = S[i * 3], py = S[i * 3 + 1], pz = S[i * 3 + 2];

            var tx = M[0] * px + M[1] * py + M[2] * pz + M[3];
            var ty = M[4] * px + M[5] * py + M[6] * pz + M[7];
            var tz = M[8] * px + M[9] * py + M[10] * pz + M[11];

            /* 用 nearestIndex 而不是 radius：这里只关心"有没有点落在 delta 内"，
             * 半径查询会把球内所有点都收集进数组（一次分配 + 若干 push），
             * 而 LCP 打分是这个搜索最热的路径（每轮 40 次 × 2500 点）。
             * 最近邻只走一条下降路径，且不分配内存。
             * 直接把 delta 当上界传下去：超出就是"没命中"，连距离都不用算，
             * 顺带让剪枝从一开始就是紧的。 */
            if (kd.nearestIndex(tx, ty, tz, delta) >= 0) { good++; }

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
        /* 门限按「两条基线各自都可能差满一个 eps」放宽到 4δ：
         * 点对提取的容差是 2δ，两条基线共 4 个端点的误差累积到 4 点拟合的
         * rms 上，用 2δ 当门限等于要求每条基线零误差 —— 实测通过率恒为 0。
         * 放宽后真正的筛选交给后面的 LCP 打分。 */
        var rmsLimit = (this.options.rmsGate || 2) * this.distFactorN;

        /* 先给全部候选算出「4 点刚体拟合残差」，按残差升序只验证最好的几十个。
         *
         * 为什么不能按遍历顺序验证前 N 个：候选是按点对遍历顺序插入的，
         * 前 300 个几乎全部出自同一小片区域、彼此高度相关，而真正的正确
         * 构型可能排在很后面。实测同一轮里 300 个候选的 rms 跨越 0.05~0.6，
         * 按序验证等于把预算全花在垃圾上（单次 verify 是 2500 次最近邻，
         * 300 个/trial × 120 trial ≈ 9 千万次查询，正是十几秒的来源）。 */
        var maxVerify = this.options.maxVerify || 40;
        var pool = [];
        var i, r;

        for (i = 0; i < quads.length; i++)
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

            if (!M) { this.diag.nullM++; continue; }

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
            this.diag.rmsN++;
            if (rms < this.diag.rmsMin) { this.diag.rmsMin = rms; }
            if (!(rms < rmsLimit)) { continue; }

            this.lastStats.congruent++;
            this.diag.rmsPass++;
            pool.push({ rms: rms, M: M, q: q });
        }

        if (!pool.length) { return this.bestLCP >= this.options.terminate_threshold; }

        pool.sort(function (a, b) { return a.rms - b.rms; });

        var nVerify = Math.min(pool.length, maxVerify);
        for (i = 0; i < nVerify; i++)
        {
            if (this.cancelled) { return false; }

            var lcp = this.verify(pool[i].M);
            this.lastStats.verify++;
            this.diag.verifyRun++;
            if (lcp > this.diag.lcpBest) { this.diag.lcpBest = lcp; }

            if (lcp > this.bestLCP)
            {
                this.bestTransform = pool[i].M;
                this.bestPairs = pool[i].q.slice();
                this.bestLCP = lcp;

                if (this.bestLCP >= this.options.terminate_threshold) { return true; }
            }
        }

        return this.bestLCP >= this.options.terminate_threshold;
    };

    /* match4pcsBase.hpp : TryOneBase —— 一次完整 RANSAC 迭代 */
    Registration.prototype.tryOneBase = function ()
    {
        /* 基的合法性：只有「两条基线真的相交、交点严格落在两条线段内部」
         * 时，r1/r2 才是个有约束力的 4PCS 不变量。
         * 端点解（r=0 或 1）等于拿一个端点坐标当不变量，等长匹配退化成
         * "找一条经过该点的等长线段"，噪声全放过；实测这类基让 3 万多个
         * 候选四边形的 rms 最小值卡在 0.13（门限 0.085），通过数为 0。
         * 这里重抽最多 6 次，仍不合法就放弃本次迭代（RANSAC 里丢一次迭代
         * 没有代价，比拿退化基污染候选集划算）。 */
        var okBase = false;
        for (var bt = 0; bt < 6; bt++)
        {
            if (!this.selectQuadrilateral()) { break; }

            var iv1 = this.invariant1, iv2 = this.invariant2;
            if (!(iv1 > 0.06 && iv1 < 0.94 && iv2 > 0.06 && iv2 < 0.94)) { continue; }
            if (!(this.baseMinDist < 0.02 * this.maxBaseDiameter)) { continue; }

            okBase = true;
            break;
        }

        if (!okBase) { this.diag.baseFail++; return false; }

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
                    /* 还没搜到优于基准的候选时，bestTransform 是 null，
                     * toGlobal(null) 也返回 null —— 于是整个搜索阶段一帧都不预览，
                     * 用户只看到百分比在走、模型钉在原地。
                     * 这里退回「质心对齐」（单位阵经 toGlobal 补齐质心差），
                     * 它正是 result() 在 usedBaseline 时返回的那个解，
                     * 预览与最终结果因此始终一致。 */
                    matrix: (options && options.preview)
                        ? reg.toGlobal(reg.bestTransform || IDENT4) : null
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
                    /* 「质心对齐」的解：搜索失败时它是唯一可用初值，
                     * 也是判断候选优劣的对照组，所以一并返回 */
                    baselineMatrix: reg.toGlobal(IDENT4),
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
