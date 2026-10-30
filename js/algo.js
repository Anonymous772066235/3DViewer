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
            // clipPoly 保留 dot(n,p) <= d 的一侧（内侧），所以 n 必须指向多边形外侧：
            // 与“中心方向”同向时取反
            if (V.dot(n, center) > 0)
            {
                n = [-n[0], -n[1], -n[2]];
            }
            planes.push({ n: n, d: V.dot(n, eye) });
        }
        return planes;
    }

    /* ---------------- 几何切分 ---------------- */

    function clipPoly(polyV, n, d, keepInside)
    {
        var sgn = keepInside ? 1 : -1;
        var out = [];
        var len = polyV.length;
        for (var i = 0; i < len; i++)
        {
            var a = polyV[i];
            var b = polyV[(i + 1) % len];
            var da = (n[0] * a[0] + n[1] * a[1] + n[2] * a[2] - d) * sgn;
            var db = (n[0] * b[0] + n[1] * b[1] + n[2] * b[2] - d) * sgn;
            if (da <= 0)
            {
                out.push(a);
            }
            if ((da < 0 && db > 0) || (da > 0 && db < 0))
            {
                var t = da / (da - db);
                out.push([
                    a[0] + (b[0] - a[0]) * t,
                    a[1] + (b[1] - a[1]) * t,
                    a[2] + (b[2] - a[2]) * t
                ]);
            }
        }
        return out;
    }

    function pushTri(out, a, b, c)
    {
        out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }

    /* 扇形三角化（交点多边形对凸选区是凸的，差集碎片同样凸） */
    function emitPoly(out, polyV)
    {
        for (var i = 1; i + 1 < polyV.length; i++)
        {
            pushTri(out, polyV[0], polyV[i], polyV[i + 1]);
        }
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

    function splitMesh(layer, planes)
    {
        var pos = layer.data.positions;
        var tri = Math.floor(pos.length / 9);
        var segOut = [];
        var remOut = [];
        var triV = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

        for (var t = 0; t < tri; t++)
        {
            var o = t * 9;
            triV[0][0] = pos[o]; triV[0][1] = pos[o + 1]; triV[0][2] = pos[o + 2];
            triV[1][0] = pos[o + 3]; triV[1][1] = pos[o + 4]; triV[1][2] = pos[o + 5];
            triV[2][0] = pos[o + 6]; triV[2][1] = pos[o + 7]; triV[2][2] = pos[o + 8];

            // 交集：依次对每个平面保留内侧
            var inter = triV;
            var cut = false;
            for (var p = 0; p < planes.length; p++)
            {
                inter = clipPoly(inter, planes[p].n, planes[p].d, true);
                if (inter.length < 3)
                {
                    break;
                }
            }
            if (inter.length >= 3)
            {
                emitPoly(segOut, inter);
                cut = true;
            }

            // 差集：逐平面把“外侧”碎片收集起来
            var pieces = [];
            var cur = [triV];
            for (var q = 0; q < planes.length && cur.length; q++)
            {
                var nxt = [];
                for (var ci = 0; ci < cur.length; ci++)
                {
                    var inPart = clipPoly(cur[ci], planes[q].n, planes[q].d, true);
                    var outPart = clipPoly(cur[ci], planes[q].n, planes[q].d, false);
                    if (inPart.length >= 3)
                    {
                        nxt.push(inPart);
                    }
                    if (outPart.length >= 3)
                    {
                        pieces.push(outPart);
                    }
                }
                cur = nxt;
            }
            for (var pi = 0; pi < pieces.length; pi++)
            {
                emitPoly(remOut, pieces[pi]);
            }

            if (!cut)
            {
                // 完全在选区外：整三角形归 remaining（上面的差集已包含）
            }
        }

        return {
            seg: {
                kind: 'mesh',
                positions: new Float32Array(segOut),
                count: segOut.length / 9,          // uploadLayer 用它作为 triCount
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
    function installPickMethods()
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

    /* ---------------- 射线拾取（Ctrl + 左键设置旋转中心） ---------------- */
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

    /* ---------------- 射线拾取（旋转中心 / 信息拾取共用） ---------------- */
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

    /* 射线与轴对齐包围盒求交（slab 法）；返回是否相交 */
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

    /* 分块网格：把三角形按包围盒注册到 8×8×8 个块，拾取时先筛块 */
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

    /* 返回候选三角形序号数组；小模型返回 null（表示全量遍历） */
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

    /* 射线拾取最近命中：坐标 / 法向 / 标签 / 标量（点云） */
    App.prototype.rayPick = function (clientX, clientY)
    {
        var V = global.MV.math.Vec3;
        var ray = this.rayFromScreen(clientX, clientY);
        var eye = ray.eye;
        var dir = ray.dir;
        var bestT = Infinity;
        var hit = null;

        for (var li = 0; li < this.layers.length; li++)
        {
            var l = this.layers[li];
            if (!l.visible || !l.gpu)
            {
                continue;
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
                var rd = global.MV.math.BBox.radius(l.data.bbox);
                var tol = Math.max(rd * 0.012, 1e-6);
                var tol2 = tol * tol;

                for (var pi = 0; pi < cnt; pi++)
                {
                    var ax = pp[pi * 3] - eye[0];
                    var ay = pp[pi * 3 + 1] - eye[1];
                    var az = pp[pi * 3 + 2] - eye[2];
                    var tp = ax * dir[0] + ay * dir[1] + az * dir[2];
                    if (tp <= 0 || tp >= bestT)
                    {
                        continue;
                    }
                    var ddx = ax - dir[0] * tp;
                    var ddy = ay - dir[1] * tp;
                    var ddz = az - dir[2] * tp;
                    if (ddx * ddx + ddy * ddy + ddz * ddz <= tol2)
                    {
                        bestT = tp;
                        var d = l.data;
                        hit = {
                            layer: l,
                            pos: [pp[pi * 3], pp[pi * 3 + 1], pp[pi * 3 + 2]],
                            normal: d.normals
                                ? [d.normals[pi * 3], d.normals[pi * 3 + 1], d.normals[pi * 3 + 2]]
                                : null,
                            tag: (d.tags && d.tags.length > pi) ? d.tags[pi] : null,
                            scalars: null,
                            index: pi
                        };

                        if (d.scalars && d.scalars.length)
                        {
                            hit.scalars = [];
                            for (var si = 0; si < d.scalars.length; si++)
                            {
                                hit.scalars.push({
                                    name: d.scalars[si].name,
                                    value: d.scalars[si].values[pi]
                                });
                            }
                        }
                    }
                }
            }
        }

        return hit;
    };

    /* Ctrl + 左键 / 「旋转中心 → 重设」：把命中点设为旋转中心 */
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

    /* ---------------- 信息拾取：坐标 / 法向 / 标签 / 标量 + 距离角度 ---------------- */
    App.prototype.setPickInfo = function (on)
    {
        this.pickInfo = !!on;
        if (this.pickInfo)
        {
            this.pickPoints = this.pickPoints || [];
            this.canvas.style.cursor = 'crosshair';
            hooks.notify('拾取模式：在数据上单击取点（最多 3 个），Esc 退出');
        }
        else
        {
            this.canvas.style.cursor = '';
            hooks.notify('已退出拾取模式');
        }
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
        this.pickPoints.push(hit);
        if (this.pickPoints.length > 3)
        {
            this.pickPoints.shift();   // 只保留最近 3 个，用于距离 / 角度
        }

        hooks.renderPickBar(this.pickPoints, true);
        hooks.notify('已拾取 ' + this.pickPoints.length + ' 个点（最多 3 个）');
        this.markDirty();
    };

    App.prototype.clearPicks = function ()
    {
        this.pickPoints = [];
        hooks.renderPickBar([], this.pickInfo);
        this.markDirty();
    };

    /* 进入“重设旋转中心”拾取模式：下一次左键单击模型即设为新的旋转中心 */
    App.prototype.beginPickCenter = function ()
    {
        this.pickMode = true;
        if (this.canvas)
        {
            this.canvas.style.cursor = 'crosshair';
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

    /* 视角回正：清除无极旋转累积的滚转，保持当前水平角/俯仰角 */

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