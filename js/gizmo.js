/* L4.5 视角器 | gizmo：削角六面体 26 面 + X/Y/Z 方向箭头
 * 允许依赖：core（MV.math）
 * 禁止依赖：render 的 GL 状态 / 图层数据（只画自己的小画布）
 * 导出：MV.gizmo.installAppMethods / MV.gizmo.bindHooks / MV.gizmo.geo
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    /* 视角器只向外发「视角：xxx」通知，由 app 注入 */
    var gizmoHooks = {
        notify: function () {}
    };

    function bindGizmoHooks(h)
    {
        if (h && typeof h.notify === 'function')
        {
            gizmoHooks.notify = h.notify;
        }
    }

    /* ==================== 视角器（原 gizmo.js）（App 方法，由 app.js 启动时安装） ==================== */
    function installGizmoMethods()
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

    function polyNormal(p)
    {
        var nx = 0, ny = 0, nz = 0;
        for (var i = 0; i < p.length; i++)
        {
            var a = p[i];
            var b = p[(i + 1) % p.length];
            nx += (a[1] - b[1]) * (a[2] + b[2]);
            ny += (a[2] - b[2]) * (a[0] + b[0]);
            nz += (a[0] - b[0]) * (a[1] + b[1]);
        }
        var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        return [nx / l, ny / l, nz / l];
    }

    /* 去掉共线的中间顶点（棱面会因此从 8 顶点回到 4 顶点） */
    function pruneCollinear(p)
    {
        var out = [];
        var n = p.length;
        for (var i = 0; i < n; i++)
        {
            var a = p[(i - 1 + n) % n];
            var b = p[i];
            var c = p[(i + 1) % n];
            var e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
            var e2x = c[0] - b[0], e2y = c[1] - b[1], e2z = c[2] - b[2];
            var cx = e1y * e2z - e1z * e2y;
            var cy = e1z * e2x - e1x * e2z;
            var cz = e1x * e2y - e1y * e2x;
            if (Math.sqrt(cx * cx + cy * cy + cz * cz) > 1e-9)
            {
                out.push(b);
            }
        }
        return out.length >= 3 ? out : p;
    }

    /* ---------------- 视角器：正六面体削 8 角（角面=正三角）+ 12 个棱中点热区 ---------------- */
    var HEX_GEO = (function ()
    {
        // 轴面偏移 A：轴面 = 2A × 2A 的正方形
        // 棱面 d=(A+1)/√2、角面 d=(A+2)/√3 ⇒ 棱面为 2A × A√2 的矩形，角面为正三角形
        var A = 1.8;
        var faces = [
            [[A, -A, -A], [A, A, -A], [A, A, A], [A, -A, A]],
            [[-A, -A, A], [-A, A, A], [-A, A, -A], [-A, -A, -A]],
            [[-A, A, -A], [-A, A, A], [A, A, A], [A, A, -A]],
            [[-A, -A, A], [-A, -A, -A], [A, -A, -A], [A, -A, A]],
            [[-A, -A, A], [A, -A, A], [A, A, A], [-A, A, A]],
            [[-A, A, -A], [A, A, -A], [A, -A, -A], [-A, -A, -A]]
        ];

        function cutOnce(facesIn, n, d)
        {
            var out = [];
            var ring = [];
            for (var i = 0; i < facesIn.length; i++)
            {
                var poly = facesIn[i];
                var np = [];
                for (var k = 0; k < poly.length; k++)
                {
                    var a = poly[k];
                    var b = poly[(k + 1) % poly.length];
                    var da = n[0] * a[0] + n[1] * a[1] + n[2] * a[2] - d;
                    var db = n[0] * b[0] + n[1] * b[1] + n[2] * b[2] - d;
                    if (da <= 1e-9) { np.push(a); }
                    // 顶点恰好在平面上：它也是新面的顶点（否则新面会缺点、变成 5 边形）
                    if (Math.abs(da) <= 1e-9 && !(Math.abs(db) <= 1e-9)) { ring.push(a); }
                    if ((da < 0 && db > 0) || (da > 0 && db < 0))
                    {
                        var t = da / (da - db);
                        var p = [a[0] + (b[0] - a[0]) * t,
                                 a[1] + (b[1] - a[1]) * t,
                                 a[2] + (b[2] - a[2]) * t];
                        np.push(p);
                        ring.push(p);
                    }
                }
                if (np.length >= 3) { out.push(np); }
            }

            if (ring.length >= 3)
            {
                var uniq = [];
                for (var r = 0; r < ring.length; r++)
                {
                    var dup = false;
                    for (var u = 0; u < uniq.length; u++)
                    {
                        if (Math.abs(uniq[u][0] - ring[r][0]) < 1e-6 &&
                            Math.abs(uniq[u][1] - ring[r][1]) < 1e-6 &&
                            Math.abs(uniq[u][2] - ring[r][2]) < 1e-6)
                        {
                            dup = true;
                            break;
                        }
                    }
                    if (!dup) { uniq.push(ring[r]); }
                }

                if (uniq.length >= 3)
                {
                    var ex = Math.abs(n[0]) > 0.5 ? [0, 1, 0] : [1, 0, 0];
                    var dt = ex[0] * n[0] + ex[1] * n[1] + ex[2] * n[2];
                    ex = [ex[0] - n[0] * dt, ex[1] - n[1] * dt, ex[2] - n[2] * dt];
                    var el = Math.sqrt(ex[0] * ex[0] + ex[1] * ex[1] + ex[2] * ex[2]) || 1;
                    ex = [ex[0] / el, ex[1] / el, ex[2] / el];
                    var ey = [
                        n[1] * ex[2] - n[2] * ex[1],
                        n[2] * ex[0] - n[0] * ex[2],
                        n[0] * ex[1] - n[1] * ex[0]
                    ];
                    uniq.sort(function (a, b)
                    {
                        var aa = Math.atan2(a[0] * ey[0] + a[1] * ey[1] + a[2] * ey[2],
                            a[0] * ex[0] + a[1] * ex[1] + a[2] * ex[2]);
                        var bb = Math.atan2(b[0] * ey[0] + b[1] * ey[1] + b[2] * ey[2],
                            b[0] * ex[0] + b[1] * ex[1] + b[2] * ex[2]);
                        return aa - bb;
                    });
                    out.push(uniq);
                }
            }
            return out;
        }

        var SQ2 = Math.SQRT1_2;
        var SQ3 = 1 / Math.sqrt(3);

        // 12 条棱（棱面 = 矩形）
        var edgeD = (A + 1) / Math.SQRT2;
        var edgeN = [];
        for (var a1 = -1; a1 <= 1; a1 += 2)
        {
            for (var b1 = -1; b1 <= 1; b1 += 2)
            {
                edgeN.push([a1 * SQ2, b1 * SQ2, 0]);
                edgeN.push([a1 * SQ2, 0, b1 * SQ2]);
                edgeN.push([0, a1 * SQ2, b1 * SQ2]);
            }
        }
        for (var e = 0; e < edgeN.length; e++)
        {
            faces = cutOnce(faces, edgeN[e], edgeD);
        }

        // 8 个角（角面 = 正三角形）
        var cornerD = (A + 2) / Math.sqrt(3);
        for (var sx = -1; sx <= 1; sx += 2)
        {
            for (var sy = -1; sy <= 1; sy += 2)
            {
                for (var sz = -1; sz <= 1; sz += 2)
                {
                    faces = cutOnce(faces, [sx * SQ3, sy * SQ3, sz * SQ3], cornerD);
                }
            }
        }

        // 绕序朝外 + 归一到单位球
        var maxR = 0;
        for (var f = 0; f < faces.length; f++)
        {
            // 先去掉共线冗余点：否则前三点可能共线 → 叉积为零 → 绕序判断失效（棱面法向朝内）
            faces[f] = pruneCollinear(faces[f]);

            var nw = polyNormal(faces[f]);
            var cxm = 0, cym = 0, czm = 0;
            for (var v = 0; v < faces[f].length; v++)
            {
                cxm += faces[f][v][0];
                cym += faces[f][v][1];
                czm += faces[f][v][2];
                var rr = Math.sqrt(faces[f][v][0] * faces[f][v][0] +
                    faces[f][v][1] * faces[f][v][1] +
                    faces[f][v][2] * faces[f][v][2]);
                if (rr > maxR) { maxR = rr; }
            }
            if (nw[0] * cxm + nw[1] * cym + nw[2] * czm < 0)
            {
                faces[f].reverse();
            }
        }

        if (maxR > 0)
        {
            for (var fi = 0; fi < faces.length; fi++)
            {
                for (var vi = 0; vi < faces[fi].length; vi++)
                {
                    faces[fi][vi] = [faces[fi][vi][0] / maxR,
                        faces[fi][vi][1] / maxR,
                        faces[fi][vi][2] / maxR];
                }
            }
        }

        // 12 条棱的中点（归一化方向），用于“棱向视角”的小圆点热区
        var mids = [];
        var SQ2 = Math.SQRT1_2;
        for (var a1 = -1; a1 <= 1; a1 += 2)
        {
            for (var b1 = -1; b1 <= 1; b1 += 2)
            {
                mids.push({ d: [a1 * SQ2, b1 * SQ2, 0], p: [a1 * SQ2 * (Math.SQRT2 / maxR), b1 * SQ2 * (Math.SQRT2 / maxR), 0] });
                mids.push({ d: [a1 * SQ2, 0, b1 * SQ2], p: [a1 * SQ2 * (Math.SQRT2 / maxR), 0, b1 * SQ2 * (Math.SQRT2 / maxR)] });
                mids.push({ d: [0, a1 * SQ2, b1 * SQ2], p: [0, a1 * SQ2 * (Math.SQRT2 / maxR), b1 * SQ2 * (Math.SQRT2 / maxR)] });
            }
        }

        var stat = {};
        for (var sf = 0; sf < faces.length; sf++)
        {
            var kk = faces[sf].length;
            stat[kk] = (stat[kk] || 0) + 1;
        }
        return { faces: faces, mids: mids, count: faces.length, stat: stat };
    })();

    function pointInPoly(x, y, poly)
    {
        var inside = false;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++)
        {
            var xi = poly[i].x;
            var yi = poly[i].y;
            var xj = poly[j].x;
            var yj = poly[j].y;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
            {
                inside = !inside;
            }
        }
        return inside;
    }

    function dirName(n)
    {
        var axes = [
            ['X+', [1, 0, 0]], ['X-', [-1, 0, 0]],
            ['Y+', [0, 1, 0]], ['Y-', [0, -1, 0]],
            ['Z+', [0, 0, 1]], ['Z-', [0, 0, -1]]
        ];
        for (var i = 0; i < axes.length; i++)
        {
            var d = axes[i][1];
            if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0.985)
            {
                return axes[i][0];
            }
        }
        var xy = Math.abs(n[2]) < 0.35;
        var yz = Math.abs(n[0]) < 0.35;
        var xz = Math.abs(n[1]) < 0.35;
        if (xy) { return 'XY 向 (' + n[0].toFixed(2) + ', ' + n[1].toFixed(2) + ', 0)'; }
        if (yz) { return 'YZ 向 (0, ' + n[1].toFixed(2) + ', ' + n[2].toFixed(2) + ')'; }
        if (xz) { return 'XZ 向 (' + n[0].toFixed(2) + ', 0, ' + n[2].toFixed(2) + ')'; }
        return 'XYZ 向 (' + n[0].toFixed(2) + ', ' + n[1].toFixed(2) + ', ' + n[2].toFixed(2) + ')';
    }

    App.prototype.drawAxisCube = function ()
    {
        var cv = this.cubeCanvas;
        if (!cv)
        {
            return;
        }

        var g = cv.getContext('2d');
        var W = cv.width;
        var H = cv.height;
        g.clearRect(0, 0, W, H);

        var V = global.MV.math.Vec3;
        var vi = this.settings.singleView ? 0 : (this.lastActiveView >= 0 ? this.lastActiveView : 0);
        var cam = this.views[vi].camera;
        var b = cam.basis();
        var fwd = b.forward;
        var right = b.right;
        var up = b.up;

        var s = W * 0.238;
        var cx = W * 0.5;
        var cy = H * 0.5;

        var faces = [];
        for (var i = 0; i < HEX_GEO.faces.length; i++)
        {
            var poly3 = HEX_GEO.faces[i];
            var n = polyNormal(poly3);
            if (V.dot(n, fwd) > -0.02)
            {
                continue;
            }

            var cxm = 0, cym = 0, czm = 0;
            var poly = [];
            for (var k = 0; k < poly3.length; k++)
            {
                cxm += poly3[k][0];
                cym += poly3[k][1];
                czm += poly3[k][2];
                poly.push({
                    x: cx + V.dot(poly3[k], right) * s,
                    y: cy - V.dot(poly3[k], up) * s
                });
            }
            cxm /= poly3.length;
            cym /= poly3.length;
            czm /= poly3.length;

            faces.push({ poly: poly, n: n, depth: cxm * fwd[0] + cym * fwd[1] + czm * fwd[2] });
        }
        faces.sort(function (a, b2) { return b2.depth - a.depth; });

        var hov = this.cubeHover || null;
        this.cubeHit = [];

        for (var j = 0; j < faces.length; j++)
        {
            var fc = faces[j];
            var nz = V.dot(fc.n, fwd);
            // 统一底色：只按“面朝向相机”的程度做轻微明暗（0.74~1.0），
            // 不再用方向光，否则背光面的棱面会暗成黑色
            var lum = 0.74 + 0.26 * Math.max(0, -nz);
            var hovered = hov && pointInPoly(hov.x, hov.y, fc.poly);

            g.beginPath();
            g.moveTo(fc.poly[0].x, fc.poly[0].y);
            for (var m = 1; m < fc.poly.length; m++)
            {
                g.lineTo(fc.poly[m].x, fc.poly[m].y);
            }
            g.closePath();

            var base = hovered ? [96, 176, 255] : [156, 172, 192];
            g.fillStyle = 'rgb(' +
                Math.round(base[0] * lum + 16) + ',' +
                Math.round(base[1] * lum + 18) + ',' +
                Math.round(base[2] * lum + 22) + ')';
            g.fill();

            g.lineWidth = hovered ? 1.4 : 0.85;
            g.strokeStyle = hovered ? 'rgba(120,200,255,0.95)' : 'rgba(12,17,24,0.65)';
            g.stroke();

            this.cubeHit.push({ poly: fc.poly, n: fc.n });
        }

        // XYZ 正方向指示
        var AXES = [
            { d: [1, 0, 0], col: '#e05a4f', label: 'X' },
            { d: [0, 1, 0], col: '#4fbf62', label: 'Y' },
            { d: [0, 0, 1], col: '#4d8ee0', label: 'Z' }
        ];
        var L = s * 1.62;

        for (var ai = 0; ai < AXES.length; ai++)
        {
            var ax = AXES[ai];
            var ex = V.dot(ax.d, right);
            var ey = V.dot(ax.d, up);
            var ez = V.dot(ax.d, fwd);

            g.save();
            g.lineWidth = 2;
            g.strokeStyle = ax.col;
            g.fillStyle = ax.col;

            var tx, ty;
            if (Math.abs(ez) > 0.94)
            {
                g.beginPath();
                g.arc(cx, cy, 3.4, 0, Math.PI * 2);
                g.fill();
                tx = cx + 8;
                ty = cy - 8;
            }
            else
            {
                var x2 = cx + ex * L;
                var y2 = cy - ey * L;
                g.beginPath();
                g.moveTo(cx, cy);
                g.lineTo(x2, y2);
                g.stroke();

                var dx = x2 - cx;
                var dy = y2 - cy;
                var dl = Math.sqrt(dx * dx + dy * dy) || 1;
                var ux = dx / dl;
                var uy = dy / dl;
                g.beginPath();
                g.moveTo(x2, y2);
                g.lineTo(x2 - ux * 9 - uy * 4, y2 - uy * 9 + ux * 4);
                g.lineTo(x2 - ux * 9 + uy * 4, y2 - uy * 9 - ux * 4);
                g.closePath();
                g.fill();
                tx = x2 + ux * 9;
                ty = y2 + uy * 9;
            }

            g.font = 'bold 10px sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.lineWidth = 3;
            g.strokeStyle = 'rgba(8,12,18,0.85)';
            g.strokeText(ax.label, tx, ty);
            g.fillStyle = ax.col;
            g.fillText(ax.label, tx, ty);
            g.restore();
        }
    };

    App.prototype.hitAxisCube = function (ev)
    {
        var cv = this.cubeCanvas;
        if (!cv || !this.cubeHit)
        {
            return false;
        }

        var r = cv.getBoundingClientRect();
        var x = (ev.clientX - r.left) * cv.width / Math.max(r.width, 1);
        var y = (ev.clientY - r.top) * cv.height / Math.max(r.height, 1);

        for (var pass = 0; pass < 2; pass++)
        {
            for (var i = 0; i < this.cubeHit.length; i++)
            {
                var h = this.cubeHit[i];
                if (pass === 0 && !h.isDot) { continue; }
                if (pass === 1 && h.isDot) { continue; }

                var hitNow = h.isDot
                    ? ((x - h.cx) * (x - h.cx) + (y - h.cy) * (y - h.cy) <= h.r * h.r)
                    : pointInPoly(x, y, h.poly);
                if (!hitNow)
                {
                    continue;
                }

            var vi = this.settings.singleView ? 0 : (this.lastActiveView >= 0 ? this.lastActiveView : 0);
            var cam = this.views[vi].camera;

            var yaw = Math.atan2(h.n[1], h.n[0]);
            var pitch = Math.asin(Math.max(-1, Math.min(1, h.n[2])));
            cam.setOrientation(yaw, pitch);

            if (this.settings.syncCam)
            {
                this.views[1 - vi].camera.copyFrom(cam);
            }

                this.markDirty();
                gizmoHooks.notify('视角：' + dirName(h.n));
                return true;
            }
        }
        return false;
    };

    global.MV.gizmo.geo = HEX_GEO;   // 供 app.js 读取面数等元信息

    }

    global.MV.gizmo = global.MV.gizmo || {};
    global.MV.gizmo.bindHooks = bindGizmoHooks;
    global.MV.gizmo.installAppMethods = installGizmoMethods;

})(window);
