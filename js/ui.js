/* [L5·界面] ui.js — 场景树 / 属性面板 / 数据对齐 / 日志 / 纯工具
 * 依赖：core / io / algo / render
 * 禁止：直接操作 GL（经 Renderer）
 * 导出：MV.ui / MV.util
 */
(function (global)
{
    'use strict';

    var MV = global.MV = global.MV || {};

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

    function vecLen(a, b)
    {
        var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
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

    function normKey(s)
    {
        return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    /* 与着色器 ramp 一致的色标采样点。
     * 原本在 ui.js 里，rampColorAt 搬过来时必须一起搬 —— 否则每次调用
     * 都会 ReferenceError，调用链（drawHist → renderProps）随之中断，
     * 表现是「选中带标量场的点云后属性面板整个空白」。 */
    var RAMP_STOPS = [
        [[38, 77, 242], [26, 217, 230], [64, 230, 89], [255, 217, 38], [250, 56, 46]],
        [[41, 87, 230], [41, 199, 112], [230, 56, 46]],
        [[20, 20, 20], [240, 240, 240]],
        [[36, 92, 224], [245, 245, 245], [219, 51, 46]]
    ];

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

    /* 取配准用的点集（当前世界坐标）。
     * 需要"原始位姿"的点集时，由调用方用 inv(pose) 临时变换得到 ——
     * 不在这里常驻保存副本，避免大模型多占十几 MB。 */
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

        /* 网格：只传几何，法向由 ICP Worker 内部计算（normalsOf）。
         * 主线程不再跑 O(面数) 的 computeVertexNormals。 */
        if (d.uniqVerts && d.remap && d.vertCount)
        {
            return {
                kind: 'mesh', pos: d.uniqVerts,
                positions: d.positions, remap: d.remap, vertCount: d.vertCount,
                nrm: null, count: d.vertCount
            };
        }
        return {
            kind: 'mesh', pos: d.positions,
            positions: d.positions, remap: null, vertCount: null,
            nrm: null, count: d.count || Math.floor(d.positions.length / 3)
        };
    }

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

    function fmt3p(p)
    {
        return p[0].toFixed(2) + ', ' + p[1].toFixed(2) + ', ' + p[2].toFixed(2);
    }

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

    function matSame(a, b)
    {
        if (!a || !b) { return false; }
        for (var i = 0; i < 16; i++)
        {
            if (Math.abs(a[i] - b[i]) > 1e-6) { return false; }
        }
        return true;
    }

    function isRigidMat(m)
    {
        var eps = 1e-3;

        var r00 = m[0], r01 = m[1], r02 = m[2];
        var r10 = m[4], r11 = m[5], r12 = m[6];
        var r20 = m[8], r21 = m[9], r22 = m[10];

        // 三行必须都是单位长度
        if (Math.abs(Math.sqrt(r00 * r00 + r01 * r01 + r02 * r02) - 1) > eps) { return false; }
        if (Math.abs(Math.sqrt(r10 * r10 + r11 * r11 + r12 * r12) - 1) > eps) { return false; }
        if (Math.abs(Math.sqrt(r20 * r20 + r21 * r21 + r22 * r22) - 1) > eps) { return false; }

        // 两两正交
        if (Math.abs(r00 * r10 + r01 * r11 + r02 * r12) > eps) { return false; }
        if (Math.abs(r00 * r20 + r01 * r21 + r02 * r22) > eps) { return false; }
        if (Math.abs(r10 * r20 + r11 * r21 + r12 * r22) > eps) { return false; }

        // det = +1：det = −1 是镜像，不属于刚体
        var det = r00 * (r11 * r22 - r12 * r21)
                - r01 * (r10 * r22 - r12 * r20)
                + r02 * (r10 * r21 - r11 * r20);
        if (det < 1 - eps) { return false; }

        // 齐次末行
        if (Math.abs(m[12]) > eps || Math.abs(m[13]) > eps || Math.abs(m[14]) > eps) { return false; }
        if (Math.abs(m[15] - 1) > eps) { return false; }

        return true;
    }

    function isIdentityMat(m)
    {
        for (var i = 0; i < 16; i++)
        {
            var want = (i % 5 === 0) ? 1 : 0;
            if (Math.abs(m[i] - want) > 1e-9) { return false; }
        }
        return true;
    }

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

    function identityMat()
    {
        var m = new Float64Array(16);
        m[0] = m[5] = m[10] = m[15] = 1;
        return m;
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

    /* 先把「用户数据」剥掉：文件名 / 图层名 / 路径里出现「异常」「错误」这类词，
     * 不该让整条日志变红。剥不干净的（比如没加引号的文件名）再由「只看开头」兜住。 */
    function stripUserData(s)
    {
        return String(s || '')
            .replace(/"[^"]*"/g, '""')
            .replace(/「[^」]*」/g, '「」')
            .replace(/'[^']*'/g, "''")
            .replace(/[A-Za-z]:\\[^\s，。；、）)]*/g, '<path>')
            .replace(/https?:\/\/[^\s，。；、）)]*/g, '<url>');
    }

    /* 兜底分级：调用方没给 level 时才用。
     *
     * 不再「关键词出现即判红」—— 那样文件名里带「异常」「错误」的正常消息也会红。
     * 改成匹配**消息形态**，因为真实错误消息都有固定句式：
     *   「XX 失败：…」「无法…」「不支持…」「请先…」「已取消…」
     * 而用户数据（文件名/图层名/路径）几乎不会长成这些形态。 */
    function classifyLog(text)
    {
        var t = stripUserData(text).slice(0, 32);

        /* 开头就是错误语：失败 / 无法 / 不支持 / 未找到 / 越界 / 不可用 */
        if (/^(失败|无法|不支持|未找到|越界|不可用|没有可显示)/.test(t))
        {
            return 'fail';
        }

        /* 「载入失败：」「优化失败:」这类「动作 + 失败 + 冒号」 */
        if (/(失败|错误)\s*[:：]/.test(t))
        {
            return 'fail';
        }

        /* 提示/取消类 */
        if (/^(取消|已取消|警告|注意|跳过|请先|未就绪|未拾取)/.test(t))
        {
            return 'warn';
        }

        return 'info';
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

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

    function slotLabel(slot)
    {
        if (slot === 'A') { return '左侧 (A)'; }
        if (slot === 'B') { return '右侧 (B)'; }
        return '公共图层 (S)';
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

    function fmtNum(v)
    {
        var a = Math.abs(v);
        if (a === 0) { return '0'; }
        if (a >= 10000 || a < 0.001) { return v.toExponential(2); }
        if (a >= 100) { return v.toFixed(1); }
        return v.toFixed(3);
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

    MV.util = {
        angleAt: angleAt,
        vecLen: vecLen,
        planFromLabels: planFromLabels,
        normKey: normKey,
        rampColorAt: rampColorAt,
        xformPoints: xformPoints,
        mat4Mul: mat4Mul,
        icpSample: icpSample,
        jacobiLargestEigenVec: jacobiLargestEigenVec,
        fmt3p: fmt3p,
        xformNormals: xformNormals,
        xformPositions: xformPositions,
        bboxOfPositions: bboxOfPositions,
        matSame: matSame,
        isRigidMat: isRigidMat,
        isIdentityMat: isIdentityMat,
        mat4Invert: mat4Invert,
        identityMat: identityMat,
        textToMat: textToMat,
        fmtMat: fmtMat,
        classifyLog: classifyLog,
        pad2: pad2,
        formatCount: formatCount,
        slotLabel: slotLabel,
        fmtTime: fmtTime,
        formatBytes: formatBytes,
        fmtNum: fmtNum,
        rgbToHex: rgbToHex,
        hexToRgb: hexToRgb
    };

})(this);


/* ==================== 界面层入口（原 js/ui.js） ==================== */

/* L5 界面层 | ui：DOM 面板与交互
 * 允许依赖：core、MV.app（回调）
 * 禁止依赖：GL 细节、算法实现
 * 导出：MV.ui（树 / 属性 / 视图设置 / 弹窗 / 拖放）
 */
(function (global)
{
    /* ---- 从 ui-util.js 解构纯工具函数 ----
     * 这些函数零副作用、零外部依赖（不碰 DOM、不读 App 状态），
     * 位于本文件开头的工具函数段（挂 MV.util）。解构成本地变量后，
     * 本文件里所有原有调用点都不需要改动。 */
    var MV_UTIL = (global.MV && global.MV.util) || {};
    var hexToRgb = MV_UTIL.hexToRgb;
    var rgbToHex = MV_UTIL.rgbToHex;
    var fmtNum = MV_UTIL.fmtNum;
    var formatBytes = MV_UTIL.formatBytes;
    var fmtTime = MV_UTIL.fmtTime;
    var slotLabel = MV_UTIL.slotLabel;
    var formatCount = MV_UTIL.formatCount;
    var pad2 = MV_UTIL.pad2;
    var classifyLog = MV_UTIL.classifyLog;
    var fmtMat = MV_UTIL.fmtMat;
    var textToMat = MV_UTIL.textToMat;
    var identityMat = MV_UTIL.identityMat;
    var mat4Invert = MV_UTIL.mat4Invert;
    var isIdentityMat = MV_UTIL.isIdentityMat;
    var isRigidMat = MV_UTIL.isRigidMat;
    var matSame = MV_UTIL.matSame;
    var bboxOfPositions = MV_UTIL.bboxOfPositions;
    var xformPositions = MV_UTIL.xformPositions;
    var xformNormals = MV_UTIL.xformNormals;
    var fmt3p = MV_UTIL.fmt3p;
    var jacobiLargestEigenVec = MV_UTIL.jacobiLargestEigenVec;
    var icpSample = MV_UTIL.icpSample;

    /* ---- 配准用的临时变换（只在本次运行期间存在，不常驻） ---- */

    /* 复制并变换一组点（行主序 4×4，含平移） */
    function xformPosCopy(src, m)
    {
        var out = new Float32Array(src.length);
        for (var k = 0; k < src.length; k += 3)
        {
            var x = src[k], y = src[k + 1], z = src[k + 2];
            out[k]     = m[0] * x + m[1] * y + m[2] * z + m[3];
            out[k + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
            out[k + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
        }
        return out;
    }

    /* 复制并旋转一组方向（只用 3×3，重新归一化） */
    function xformDirCopy(src, m)
    {
        var out = new Float32Array(src.length);
        for (var k = 0; k < src.length; k += 3)
        {
            var x = src[k], y = src[k + 1], z = src[k + 2];
            var nx = m[0] * x + m[1] * y + m[2] * z;
            var ny = m[4] * x + m[5] * y + m[6] * z;
            var nz = m[8] * x + m[9] * y + m[10] * z;
            var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            out[k] = nx / len; out[k + 1] = ny / len; out[k + 2] = nz / len;
        }
        return out;
    }
    var mat4Mul = MV_UTIL.mat4Mul;
    var mat4Invert = MV_UTIL.mat4Invert;
    var xformPoints = MV_UTIL.xformPoints;
    var rampColorAt = MV_UTIL.rampColorAt;
    var normKey = MV_UTIL.normKey;
    var planFromLabels = MV_UTIL.planFromLabels;
    var vecLen = MV_UTIL.vecLen;
    var angleAt = MV_UTIL.angleAt;
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

        ctxItem(menu, '重命名…', function ()
        {
            var row = document.querySelector('.tree-item[data-layer-id="' + layer.id + '"]');
            if (row) { beginRename(row, layer); }
        });

        var ctxSep0 = document.createElement('div');
        ctxSep0.className = 'ctx-sep';
        menu.appendChild(ctxSep0);

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

    /* ---------------- 重命名 ---------------- */
    /* 就地编辑：把 .lname 换成 input，Enter / 失焦提交，Esc 取消 */
    function beginRename(row, layer)
    {
        var a = global.MV.app;
        if (!row || !layer || !a) { return; }
        if (row.querySelector('.lname-input')) { return; }

        var span = row.querySelector('.lname');
        if (!span) { return; }

        var input = document.createElement('input');
        input.className = 'lname-input';
        input.type = 'text';
        input.maxLength = 60;
        input.value = layer.name;
        input.title = '回车确认，Esc 取消';

        span.style.display = 'none';
        row.insertBefore(input, span);
        input.focus();
        input.select();

        var finished = false;
        function finish(commit)
        {
            if (finished) { return; }
            finished = true;

            var v = commit ? input.value : '';
            if (input.parentNode) { input.parentNode.removeChild(input); }
            span.style.display = '';

            if (commit) { a.renameLayer(layer.id, v); }
        }

        input.addEventListener('keydown', function (ev)
        {
            /* 输入期间的按键不能落到全局快捷键上 */
            ev.stopPropagation();
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        });

        input.addEventListener('blur', function () { finish(true); });
        input.addEventListener('click', function (ev) { ev.stopPropagation(); });
        input.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });
    }

    /* F2 / 右键菜单调用：重命名当前选中图层 */
    function beginRenameSelected()
    {
        var a = global.MV.app;
        if (!a || a.selectedId === null || a.selectedId === undefined)
        {
            setInfo('先在场景树里选中一个图层', false, 'warn');
            return false;
        }

        var layer = a.layerById(a.selectedId);
        var row = document.querySelector('.tree-item[data-layer-id="' + a.selectedId + '"]');
        if (!layer || !row) { return false; }

        beginRename(row, layer);
        return true;
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

            var visibleGroup = list.length > 0;
            var allVisible = visibleGroup && list.every(function (l) { return l.visible; });

            var header = el('div', 'tree-group-header slot-' + slot);
            var caret = el('span', 'caret', collapsed[slot] ? '\u25B8' : '\u25BE');
            var badge = el('span', 'slot-badge', info.badge);
            var title = el('span', '', info.title);
            var cnt = el('span', 'gcount', list.length + ' 层');
            header.appendChild(caret);
            header.appendChild(badge);
            header.appendChild(title);
            header.appendChild(cnt);

            /* 组开关直接放在标题行右端。
             * 原来它是子项列表里的第一行「全选 / 全不选」，三个槽位就白占三行，
             * 而且和下面的图层行长得一样，容易误点。 */
            if (visibleGroup)
            {
                var groupChk = document.createElement('input');
                groupChk.type = 'checkbox';
                groupChk.className = 'group-chk';
                groupChk.checked = allVisible;
                groupChk.title = '显示 / 隐藏本组全部图层';
                groupChk.addEventListener('click', function (ev) { ev.stopPropagation(); });
                groupChk.addEventListener('change', function (ev)
                {
                    ev.stopPropagation();
                    var now = Date.now();
                    list.forEach(function (l)
                    {
                        l.visible = groupChk.checked;
                        if (groupChk.checked) { l.shownAt = now; }
                    });
                    app.markDirty();
                    renderTree();
                });
                header.appendChild(groupChk);
            }

            header.addEventListener('click', function ()
            {
                collapsed[slot] = !collapsed[slot];
                renderTree();
            });

            root.appendChild(header);

            var children = el('div', 'tree-children' + (collapsed[slot] ? ' collapsed' : ''));
            if (list.length === 0)
            {
                children.appendChild(el('div', 'tree-empty', '（空）'));
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
                        layer.shownAt = Date.now();   // 记为“最新启用”，扩展优先用它

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
                name.title = tip + '  ·  双击重命名';
                row.title = tip;
                row.dataset.layerId = layer.id;

                /* 唯一 ID：两个同名图层靠它区分（重命名后也照样能对上） */
                var lid = el('span', 'lid', '#' + layer.id);
                lid.title = '图层 ID：#' + layer.id + '  ·  唯一标识：' + (layer.uid || '-');

                name.addEventListener('dblclick', function (ev)
                {
                    ev.stopPropagation();
                    beginRename(row, layer);
                });

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
                row.appendChild(lid);
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

        // 图层增删 / 改名后同步配准下拉，避免面板里的选择列表过期
        var xPanel = $('xform');
        if (xPanel && !xPanel.classList.contains('tab-hidden'))
        {
            regFillSelects();
            icpFillSelects();
            refreshXformTargetLabel();
        }

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

    /* 精确到个位：属性面板用它，避免 111.0k 这种看不出实际规模 */
    function exactCount(n)
    {
        n = Math.round(Number(n) || 0);
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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

        /* 计数一律精确到个位（千分位分隔）：111,009 比 111.0k 更能说明规模 */
        if (layer.kind === 'mesh')
        {
            var triN = d.count || Math.floor((d.positions ? d.positions.length : 0) / 9);
            var vN = d.vertCount || 0;

            txt = d.format + ' · 面 ' + exactCount(triN);
            if (vN) { txt += ' · 点 ' + exactCount(vN); }
        }
        else
        {
            txt = d.format + ' · 点 ' + exactCount(d.count);

            var sfN = (d.scalars && d.scalars.length) || 0;
            if (sfN) { txt += ' · 标量 ' + sfN + ' 列'; }
        }
        if (d.note)
        {
            txt += ' · ' + d.note;
        }
        if (layer.kind === 'mesh' && layer.gpu && typeof layer.gpu.boundaryEdges === 'number')
        {
            txt += ' · 边界 ' + exactCount(layer.gpu.boundaryEdges) + ' 边';
        }
        $('p-stat').textContent = txt;

        /* 「变换」一行：该图层相对载入时的累计变换 + 逐步台账。
         * 放在属性面板而不是数据对齐面板 —— 属性属于对象，点任意图层都能看；
         * 数据对齐面板的矩阵框只承载"待应用的增量"，不该再塞状态。 */
        renderXformProp(layer);

        /* 路径栏的优先级：
         *   1. absPath —— /locate 反查到的绝对路径，最准确
         *   2. /file?path= 地址里的 path 参数 —— 这类载入本身就是按路径开的
         *   3. sourceUrl —— 普通 URL 载入
         * 都没有就说明确实解析不出来，给出可操作的提示而不是空白。 */
        var pathText = layer.absPath || '';
        var pathFromFileApi = false;

        if (!pathText && layer.sourceUrl)
        {
            try
            {
                var su = new global.URL(layer.sourceUrl, global.location.href);
                if (su.pathname === '/file')
                {
                    var pp = su.searchParams.get('path');
                    if (pp) { pathText = pp; pathFromFileApi = true; }
                }
                if (!pathText) { pathText = layer.sourceUrl; }
            }
            catch (e2)
            {
                pathText = layer.sourceUrl;
            }
        }

        /* 没有任何可用来源时不显示这一行：
         * 用一段解释去占位，反而让「路径」这一项看起来像坏了 */
        var pathRow = $('p-path') ? $('p-path').closest('.prop-row') : null;

        /* URL 形式加载时路径里可能是 %E6%A7%BD... 编码串，中文文件名会显示成乱码 */
        if (!pathFromFileApi)
        {
            try { pathText = decodeURI(pathText); } catch (e3) { /* 保持原样 */ }
        }

        $('p-path').textContent = pathText || '';
        $('p-path').title = pathText || '';

        if (pathRow) { pathRow.classList.toggle('show', !!pathText); }
    }

    /* ---------------- 属性面板：变换（累计 + 台账） ---------------- */

    var propXformOpen = false;

    function renderXformProp(layer)
    {
        var val = $('p-xform-val');
        var cnt = $('p-xform-count');
        var caret = $('p-xform-caret');
        var main = $('p-xform-main');
        var body = $('p-xform-body');
        var list = $('p-xform-steps');
        var btnCopy = $('p-xform-copy');
        var btnUndo = $('p-xform-undo');
        var btnInv = $('p-xform-inv');
        if (!val) { return; }

        var cum = (layer && layer.xformMat) ? layer.xformMat : null;
        var has = !!(cum && !isIdentityMat(cum));
        var steps = (layer && layer.xformSteps) ? layer.xformSteps : [];

        /* R 与 T 分成两行、各带固定宽度前缀，严格区分且上下对齐。
         *
         * 精度统一 1 位小数：以前主行是 (R 1 位 / T 1 位)，而历史行是
         * (R 1 位 / T 0 位) —— 同一个数字在两处显示成 556.3 / 556，
         * 看起来像两次数据不同。现在两条路径都用同一位数。
         *
         * 载入时就显示单位阵对应的位姿（R 0.0° / T 0.0, 0.0, 0.0），不再空着：
         * 空白让人分不清"没动过"和"没读到"，而 0.0 是确切答案。 */
        var m = has ? cum : IDENT4;
        var tr0 = m[0] + m[5] + m[10];
        var ang0 = Math.acos(Math.max(-1, Math.min(1, (tr0 - 1) / 2))) * 180 / Math.PI;

        var elR = $('p-xform-r');
        var elT = $('p-xform-t');
        if (elR) { elR.textContent = 'R  ' + ang0.toFixed(1) + '°'; }
        if (elT)
        {
            elT.textContent = 'T  ' + m[3].toFixed(1) + ', ' +
                              m[7].toFixed(1) + ', ' + m[11].toFixed(1);
        }

        if (has)
        {
            val.classList.remove('none');
            val.title = '累计变换（相对载入时，只读）\n' + fmtMat(cum) +
                        '\n展开可看每一步，支持复制 / 撤销 / 逆变换';
        }
        else
        {
            val.classList.add('none');
            val.title = '相对载入时位姿没有变化（单位阵）';
        }

        if (cnt) { cnt.textContent = steps.length ? (steps.length + ' 步') : ''; }

        /* 没有台账就没有可展开的东西（例如图层是别的路径改过顶点） */
        var canExpand = steps.length > 0;
        if (caret) { caret.style.visibility = canExpand ? 'visible' : 'hidden'; }
        if (main) { main.classList.toggle('expandable', canExpand); }
        if (!canExpand) { propXformOpen = false; }

        var open = propXformOpen && canExpand;
        if (body) { body.classList.toggle('hidden', !open); }
        if (caret) { caret.textContent = open ? '▴' : '▾'; }

        if (list)
        {
            if (!open) { list.innerHTML = ''; }
            else
            {
                var html = [];
                for (var i = 0; i < steps.length; i++)
                {
                    var st = steps[i];
                    var last = (i === steps.length - 1);
                    var lb = String(st.label || '变换').replace(/"/g, '&quot;');

                    html.push(
                        '<li class="prop-xform-step' + (last ? ' last' : '') + '">' +
                        '<span class="idx">' + (i + 1) + '</span>' +
                        '<span class="lb" title="' + lb + '">' + lb + '</span>' +
                        '<span class="vv" title="' + fmtMat(st.mat).replace(/\n/g, '&#10;') + '">' +
                            xformBrief(st.mat, 1, 1, true) + '</span>' +
                        '</li>');
                }
                list.innerHTML = html.join('');
            }
        }

        if (btnCopy) { btnCopy.disabled = !has; }
        if (btnUndo) { btnUndo.disabled = !steps.length; }

        if (btnInv)
        {
            btnInv.disabled = !has;

            /* 逆变换会把整条配准链抹平且不可撤销，所以要两次点击 */
            var arming = !!(has && invertConfirmAt && nowMs() - invertConfirmAt < 3000);
            btnInv.textContent = arming ? '确认？' : '逆变换';
            if (arming) { btnInv.classList.add('armed'); }
            else { btnInv.classList.remove('armed'); }
        }
    }

    /* 撤销最后一步：应用 inv(最后一步)，再把它自己产生的那条台账抹掉 */
    function undoLastXformOf(layer)
    {
        if (!layer || !layer.xformSteps || !layer.xformSteps.length)
        {
            xformInfo('没有可撤销的步骤', true);
            return;
        }

        var last = layer.xformSteps[layer.xformSteps.length - 1];
        var inv = mat4Invert(last.mat);
        if (!inv) { xformInfo('这一步不可逆，无法撤销', true); return; }

        var backups = layer.xformSteps.slice();
        layer.xformSteps.pop();

        if (applyXformToLayer(inv, '撤销「' + (last.label || '变换') + '」', layer))
        {
            /* applyXformToLayer 会为"撤销"本身再记一条，那条不该留在台账里 */
            if (layer.xformSteps && layer.xformSteps.length) { layer.xformSteps.pop(); }
            setInfo('已撤销「' + (last.label || '变换') + '」');
            renderProps();
        }
        else
        {
            layer.xformSteps = backups;
        }
    }

    /* 逆变换：应用累计变换的逆，回到载入时的位姿（台账随之清空）
     *
     * 这是**不可撤销的破坏性操作**：一次点击会把整条配准链（N-N + ICP 的烘焙结果）
     * 抹平，而且台账清空后连"撤销上一步"都回不去了。所以做两步确认：
     * 第一次点击只把按钮变成"确认？"，3 秒内再点才执行。 */
    var invertConfirmAt = 0;

    function invertLayerXform(layer)
    {
        if (!layer || !layer.xformMat || isIdentityMat(layer.xformMat))
        {
            xformInfo('该图层还没有被变换过', true);
            return;
        }

        if (!invertConfirmAt || nowMs() - invertConfirmAt >= 3000)
        {
            invertConfirmAt = nowMs();
            renderXformProp(layer);
            setTimeout(function () { invertConfirmAt = 0; renderXformProp(layer); }, 3200);
            return;
        }

        invertConfirmAt = 0;

        var inv = mat4Invert(layer.xformMat);
        if (!inv) { xformInfo('累计变换不可逆', true); return; }

        var backups = layer.xformSteps ? layer.xformSteps.slice() : [];
        layer.xformSteps = [];

        if (applyXformToLayer(inv, '逆变换（回到载入时位姿）', layer))
        {
            layer.xformSteps = [];     /* 台账清空：已经回到原始 */
            setInfo('已把 ' + layer.name + ' 还原到载入时的位姿');
            renderProps();
        }
        else
        {
            layer.xformSteps = backups;
        }
    }

    /* ---------------- 进度 / 状态 ---------------- */
    /* 进度条起始时间：载入几十 MB 的点云时要几十秒，用户最想知道"还要多久" */
    var pgStartAt = 0;

    function setProgress(visible, text, frac)
    {
        var box = $('progress');
        if (!box) { return; }

        box.classList.toggle('hidden', !visible);

        if (visible && !pgStartAt) { pgStartAt = nowMs(); }
        if (!visible) { pgStartAt = 0; }

        if (text !== undefined && text !== null)
        {
            var t = text;
            var el2 = visible && pgStartAt ? (nowMs() - pgStartAt) : 0;
            if (el2 >= 1000) { t += '   ' + fmtDur(el2); }   /* 不足 1s 不显示，免得闪"0 ms" */
            $('pg-text').textContent = t;
        }
        if (frac !== undefined && frac !== null)
        {
            $('pg-fill').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
        }
    }

    /* ---------------- 底部日志面板 ---------------- */

    var LOG_MAX = 500;              // 历史条数上限
    var ST_MIN_H = 25;              // 收起高度：1px 上边框 + 24px 状态行（与 CSS 一致）
    var ST_STORE_KEY = 'viewer3d.statusHeight';
    var logBuf = [];
    var stHeight = ST_MIN_H;


    /* 按关键字分级：错误 → 红，取消/警告 → 黄 */

    /* 级别标签：颜色之外再给一个文字标识，色弱 / 打印 / 截图外传时也能分辨 */
    function levelTag(kind)
    {
        return (kind === 'warn') ? 'WARN' : (kind === 'fail' ? 'FAIL' : 'INFO');
    }

    function makeLogRow(rec)
    {
        var row = document.createElement('div');
        /* info 也给类名：标签要靠它上色 */
        row.className = 'st-log-row ' + (rec.kind || 'info');

        var t = document.createElement('span');
        t.className = 't';
        t.textContent = rec.time;

        var lv = document.createElement('span');
        lv.className = 'lv';
        lv.textContent = levelTag(rec.kind);

        var m = document.createElement('span');
        m.className = 'm';
        m.textContent = rec.text;

        row.appendChild(t);
        row.appendChild(lv);
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

    /* ---------------- 耗时统计 ----------------
     * 只记超过阈值的操作：几十毫秒的事进日志只是噪音。
     * 用 performance.now()：它不受系统时钟校正影响，跨 await 也准。 */
    var TIMING_MIN_MS = 300;

    function nowMs()
    {
        return (global.performance && global.performance.now)
            ? global.performance.now() : Date.now();
    }

    function fmtDur(ms)
    {
        if (!(ms >= 0)) { return '0 ms'; }
        if (ms < 1000) { return Math.round(ms) + ' ms'; }
        if (ms < 60000) { return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s'; }

        var m = Math.floor(ms / 60000);
        var s = Math.round((ms - m * 60000) / 1000);
        if (s >= 60) { m += 1; s = 0; }
        return m + ' min' + (s ? ' ' + s + ' s' : '');
    }

    /* 写一条「[耗时] 操作 · 1.23 s（明细）」到状态栏与日志面板。
     * force=true 时无视阈值 —— 载入这类「一次性、用户主动等」的操作，
     * 即使只有 100 ms 也值得留痕：历史重开的常常是小文件，
     * 不记的话用户会以为没有这个功能。 */
    function logTiming(label, ms, note, force)
    {
        if (!force && !(ms >= TIMING_MIN_MS)) { return; }
        setInfo('[耗时] ' + label + ' · ' + fmtDur(ms) + (note ? '（' + note + '）' : ''));
    }

    /* 日志级别：统一 4 个字母，未知值一律回退到兜底判定。
     *   info  普通（继承正文色）
     *   warn  警告（黄）
     *   fail  失败（红） */
    var LOG_LEVELS = { info: 1, warn: 1, fail: 1 };

    /* 追加一条历史；面板展开时同步追加 DOM */
    function pushLog(text, level)
    {
        var d = new Date();
        var rec = {
            time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()),
            text: String(text),
            /* 调用方知道自己在报错误，就别让它去猜；拼错的级别回退到兜底 */
            kind: (level && LOG_LEVELS[level]) ? level : classifyLog(text)
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
                    arr.push(logBuf[i].time + '  ' + levelTag(logBuf[i].kind) +
                        '  ' + logBuf[i].text);
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

    /* ---------------- 数据对齐（4×4 矩阵编辑 / 应用） ---------------- */

    var xformInputs = null;


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



    /* 4×4 求逆：转成列主序 → 伴随矩阵法 → 转回行主序 */

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

    /* 宽松读取：输入不完整时返回 null 且不打扰用户（预览路径用） */
    function peekXformMat()
    {
        if (!xformInputs) { return null; }
        var m = new Float64Array(16);
        for (var i = 0; i < 16; i++)
        {
            var v = parseFloat(xformInputs[i].value);
            if (!isFinite(v)) { return null; }
            m[i] = v;
        }
        return m;
    }


    /* 矩阵的作用对象：优先用配准面板里选的目标层，
     * 没有选择时才退回场景树选中项 —— 用户不必先去树里点一下。 */
    function xformTargetLayer()
    {
        if (!app) { return null; }

        var sels = [$('icp-dst'), $('reg-dst')];
        for (var i = 0; i < sels.length; i++)
        {
            if (!sels[i]) { continue; }
            var id = parseInt(sels[i].value, 10);
            if (!isFinite(id)) { continue; }
            var L = findLayerById(id);
            if (L) { return L; }
        }

        return app.getSelected();
    }

    function refreshXformTargetLabel()
    {
        /* 目标层变了：把该图层的累积变换回显到矩阵框，
         * 并把「应用」的基准同步过去（没变换过就是单位阵）。 */
        var layNow = xformTargetLayer();
        var idNow = layNow ? layNow.id : null;

        if (idNow !== refreshXformTargetLabel._lastId)
        {
            refreshXformTargetLabel._lastId = idNow;

            /* 矩阵框只有一种语义：**待应用的增量**，基准是单位阵。
             *
             * 曾经把该图层的累计变换（layer.xformMat）回显进框里，于是
             * 「框 = 绝对变换」和「框 = 增量」两种语义挤在同一个控件上：
             * 切完图层随手改一位数字再点「应用」，就会把已经烘焙过的
             * 累计变换再乘一遍 —— 数据被推歪。
             * 累计变换改为只读信息，放在标签的悬停提示里。 */
            writeXformMat(IDENT4);

            appliedMat = new Float64Array(16);
            for (var mi = 0; mi < 16; mi++) { appliedMat[mi] = IDENT4[mi]; }

            refreshApplyState();
        }

        var el = $('xform-layer');
        if (!el) { return; }
        var L = xformTargetLayer();

        /* 带上槽位：面板顶部只显示"目标图层"，而下方还有参考/目标两个下拉，
         * 不标槽位的话用户看不出这里指的到底是哪一个。 */
        if (L)
        {
            var slotTag = L.slot === 'A' ? '左侧'
                        : (L.slot === 'B' ? '右侧' : '公共');
            var hasCum = !!(L.xformMat && !isIdentityMat(L.xformMat));
            el.textContent = L.name + ' · ' + slotTag + '（' + L.kind + '）' +
                             (hasCum ? ' · 已变换' : '');
            el.title = hasCum
                ? '该图层已烘焙过的累计变换（只读）：\n' + fmtMat(L.xformMat) +
                  '\n下方矩阵框只填「还要再应用的增量」'
                : '矩阵框填「待应用的增量」';
        }
        else
        {
            el.textContent = '（未选择）';
        }
    }

    /* 两个下拉保持一致，避免「N-N」和「ICP」指向不同图层造成混乱 */
    function syncTargetSelects(src)
    {
        var iSel = $('icp-dst');
        var rSel = $('reg-dst');
        if (!iSel || !rSel) { return; }

        if (src === iSel && rSel.value !== iSel.value) { rSel.value = iSel.value; }
        else if (src === rSel && iSel.value !== rSel.value) { iSel.value = rSel.value; }

        refreshXformTargetLabel();
        applyPreview();
    }

    /* 判定 4×4 是否为刚体变换：3×3 部分正交、det = +1（无镜像）、末行为 0 0 0 1。
     * 本工具的变换只做旋转 + 平移，缩放/切变/镜像一律拒绝。 */

    var previewLayer = null;

    function previewEnabled()
    {
        var cb = $('xform-preview-on');
        return !cb || cb.checked;
    }

    /* ---------------- 预览（数据级） ----------------
     * 早先用 layer.previewMat + 顶点着色器里的 uModel 做预览，但要覆盖
     * mesh / wire / verts / normals / boundary / ghost / 透明 / 不透明
     * 七八条绘制路径，漏一条就出伪影（实测会出现贯穿全屏的退化条纹，
     * 且主图整个不显示）。
     * 这里改成：备份原始顶点 -> 把变换写进 positions -> 重传 GPU。
     * 走的是和「应用」完全相同的成熟路径，不可能有遗漏。 */

    var previewBackup = null;   // { layer, pos, uniq }

    var IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    /* 已应用到数据上的矩阵（或目标图层的累积变换）。
     * 「应用」按钮的可用状态以它为基准：两边一致时没必要高亮。 */
    var appliedMat = null;


    /* 只有当前矩阵与基准不一致时才允许点「应用」 */
    /* 把矩阵框里的内容烘焙进数据 —— 主「应用」按钮与待应用横幅共用同一条路径。
     *
     * 应用后矩阵框与 appliedMat 都由 applyXformToLayer 归零，所以这里
     * **不要**再把 m 写回 appliedMat：那等于把"已应用的基准"和"框里的增量"
     * 又混成一个值，正是这个面板以前踩过的坑。 */
    function applyPendingXform()
    {
        var m = readXformMat();
        if (!m) { return false; }
        return applyXformToLayer(m, '变换');
    }

    /* 矩阵区可折叠：16 个输入框 + 四个按钮占了面板近一半高度，
     * 而多数时候矩阵是 N-N / ICP 算出来的，不需要手改 —— 收起来让配准区
     * 直接可见，标题行右侧仍给一行摘要（收起也知道当前是不是单位阵）。 */
    var matrixOpen = true;

    function setMatrixOpen(on)
    {
        matrixOpen = !!on;

        var body = $('xform-matrix-body');
        var caret = $('xform-matrix-caret');
        if (body) { body.classList.toggle('hidden', !matrixOpen); }
        if (caret) { caret.textContent = matrixOpen ? '▾' : '▸'; }
    }

    function refreshApplyState()
    {
        var btn = $('xform-apply');

        var cur = peekXformMat();
        var base = appliedMat || IDENT4;
        /* 单位阵没有可应用的东西 —— 只靠「与基准不同」判断的话，
         * 基准本身是旧矩阵时，框被归零反而会被判成「有改动」。 */
        var dirty = !!cur && !isIdentityMat(cur) && !matSame(cur, base);

        /* 只控制可用状态，不摘 primary。
         * 原来用 primary 的有无表示"是否有未应用的改动"，于是无改动时
         * 「应用」会退化成和「复制」「粘贴」一样的灰按钮 —— 主操作的身份
         * 随状态变化，视觉上不成立。改为：primary 常驻，不可用时半透明。 */
        if (btn) { btn.disabled = !dirty; }

        /* 「待应用」横幅。
         *
         * N-N 只是**算出**矩阵，不点「应用」数据一动不动；而 ICP 现在是
         * 收敛即烘焙。两条路径行为不同，只靠按钮的灰/亮区分，用户很容易
         * "算完就走"。横幅把这件事放到面板顶部（sticky），并给出一键应用/丢弃。 */
        var banner = $('xform-pending');
        if (banner)
        {
            if (dirty) { banner.classList.remove('hidden'); }
            else { banner.classList.add('hidden'); }

            var tx = $('xp-text');
            if (tx && dirty) { tx.textContent = '待应用 · ' + xformBrief(cur, 1, 1); }
        }

        /* 折叠时的标题行摘要：看到"单位阵"就知道没有待应用的增量 */
        var sum = $('xform-matrix-sum');
        if (sum)
        {
            sum.textContent = dirty ? xformBrief(cur, 1, 1) : '单位阵';
            sum.classList.toggle('will-apply', dirty);
        }
    }

    function restorePreviewData()
    {
        if (!previewBackup) { return; }

        var b = previewBackup;
        var d = b.layer.data;

        if (d.positions && b.pos && d.positions.length === b.pos.length)
        {
            d.positions.set(b.pos);
        }
        if (d.uniqVerts && b.uniq && d.uniqVerts.length === b.uniq.length)
        {
            d.uniqVerts.set(b.uniq);
        }

        d.bbox = null;          // 交给 healBBoxes 重算
        previewBackup = null;

        if (app && app.renderer)
        {
            if (b.layer.gpu) { app.renderer.releaseLayer(b.layer); }
            b.layer.gpu = null;
            app.renderer.uploadLayer(b.layer);
        }
        if (app) { app.markDirty(); }
    }

    /* 把 mat 作用到图层的临时副本上（原始数据保持在备份里） */
    function applyPreviewMat(layer, mat)
    {
        if (!layer || !layer.data || !layer.data.positions) { return false; }

        /* 数据级预览与 GPU 预览（layer.previewMat）互斥。
         *
         * 两者同时生效 = 同一个矩阵乘两次：数据被改写了，渲染又乘一次。
         * 典型触发路径：配准过程中每轮都 setGpuPreview，结束时
         * writeXformMat() → applyPreview() → 走数据级预览，
         * 而 previewMat 还留着上一轮的值 —— 画面立刻错位，
         * 看起来就是「矩阵算错了 / 数据被拉歪了」。 */
        if (layer.previewMat) { layer.previewMat = null; }

        var d = layer.data;

        if (!previewBackup || previewBackup.layer !== layer)
        {
            restorePreviewData();
            previewBackup = {
                layer: layer,
                pos: new Float32Array(d.positions),
                uniq: d.uniqVerts ? new Float32Array(d.uniqVerts) : null
            };
        }
        else
        {
            // 已有备份：先还原，再重新算，避免误差累积
            d.positions.set(previewBackup.pos);
            if (d.uniqVerts && previewBackup.uniq) { d.uniqVerts.set(previewBackup.uniq); }
        }

        if (d.uniqVerts && previewBackup.uniq)
        {
            xformPositions(d.uniqVerts, mat);
        }
        xformPositions(d.positions, mat);

        d.bbox = null;

        if (app && app.renderer)
        {
            /* 优先增量更新：只重传顶点位置。
             * 走不通（散点图层等）时再退回完整的释放 + 重建。 */
            var fast = app.renderer.updateVertices && app.renderer.updateVertices(layer);

            if (!fast)
            {
                if (layer.gpu) { app.renderer.releaseLayer(layer); }
                layer.gpu = null;
                app.renderer.uploadLayer(layer);
            }
        }
        if (app) { app.markDirty(); }

        previewLayer = layer;
        return true;
    }

    /* 配准过程专用的「GPU 预览」。
     *
     * 数据级预览（applyPreviewMat）要还原全量顶点、逐点变换、再重传 GPU ——
     * 46 万点约 5MB，一次几十毫秒。ICP 每轮都做，计算反而被上传淹没。
     * 渲染器本来就支持 layer.previewMat（作为 uMVP * uModel 参与顶点变换），
     * 所以直接给它一个矩阵即可：数据不动、零上传，每轮只改一个 uniform。
     *
     * 两者不能混用：applyPreviewMat 已经改过数据，再叠加 previewMat 会「乘两次」。 */
    function setGpuPreview(layer, mat)
    {
        if (!layer) { return; }

        /* 反向互斥：数据级预览已经改过顶点的话，先还原，
         * 否则数据里带着一份变换、GPU 再乘一份，同样错位。 */
        if (previewBackup && previewBackup.layer === layer)
        {
            restorePreviewData();
            previewLayer = null;
        }

        layer.previewMat = mat ? new Float64Array(mat) : null;
        if (app) { app.markDirty(); }
    }

    function clearGpuPreview(layer)
    {
        if (!layer) { return; }
        layer.previewMat = null;
        if (app) { app.markDirty(); }
    }

    function applyPreview()
    {
        if (!app) { return; }

        var lay = xformTargetLayer();
        var m = peekXformMat();

        /* 目标层换了：先把旧层的预览摘掉 */
        if (previewLayer && previewLayer !== lay)
        {
            clearGpuPreview(previewLayer);
            restorePreviewData();
            previewLayer = null;
        }

        /* 以下情况都不该有预览：没目标层 / 矩阵解析不出来 / 单位阵 /
         * 非刚体（缩放切变镜像，输入中间态常见）/ 已经烘焙进数据。
         *
         * 清理必须在这里统一做 —— 这些分支都到不了下面的预览调用，
         * 残留的 previewMat 会让渲染再乘一次。配准结束时算出的增量经常
         * 正好是单位阵，走的正是最早那条 return。 */
        if (!lay || !m || isIdentityMat(m) || !isRigidMat(m) ||
            (appliedMat && matSame(m, appliedMat)))
        {
            if (lay) { clearGpuPreview(lay); }
            restorePreviewData();
            previewLayer = null;
            return;
        }

        /* 正常路径：GPU 层变换。
         *
         * 以前走 applyPreviewMat（还原全量顶点 + 逐点变换 + 重传 GPU），
         * 46 万点一次 30~50ms；而矩阵输入框是每敲一个字符触发一次，
         * 输入框会明显发涩。改用 layer.previewMat 后，每帧只写一个 uniform。 */
        if (app.renderer && app.renderer.ready)
        {
            setGpuPreview(lay, m);
            previewLayer = lay;
            return;
        }

        /* 渲染器尚未就绪（启动瞬间）：退回数据级预览，保证行为一致 */
        applyPreviewMat(lay, m);
        previewLayer = lay;
    }

    function clearPreview()
    {
        restorePreviewData();
        previewLayer = null;

        if (app)
        {
            for (var i = 0; i < app.layers.length; i++)
            {
                if (app.layers[i].previewMat) { app.layers[i].previewMat = null; }
            }
        }
    }

    function writeXformMat(m)
    {
        if (!xformInputs) { return; }
        for (var i = 0; i < 16; i++) { xformInputs[i].value = fmtMat(m[i]); }

        // 程序化填入（ICP / N-N）后立刻预览
        applyPreview();

        /* 必须同步刷新「应用」按钮的可用状态。
         *
         * 手动改输入框会触发 input 事件、间接触发 refreshApplyState；
         * 但 writeXformMat 是程序化赋值、不产生事件 —— 漏掉这一步时，
         * 若按钮此前恰好是 disabled（矩阵 == 已应用的矩阵），
         * 写入新矩阵后它仍然是灰的，用户看到的就是
         * "N-N 算出矩阵了，但「应用」点不动"。 */
        refreshApplyState();
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

    /* 对一组 XYZ 顶点施加 4×4（行主序，列向量） */

    /* 法向只受 3×3 部分影响，变换后归一化 */

    /* 把矩阵应用到图层：改 data + 重建 GPU */
    /* ---------------- 图层的变换台账 ----------------
     *
     * 矩阵框只承载「待应用的增量」，应用完必须归零 —— 于是"这个图层相对
     * 载入时一共被变过什么"在数据对齐面板里消失了。`layer.xformMat` 记着总和，
     * 但只给总和不够用：想退回去时只能"全部还原"，没法只退最后一步。
     *
     * 所以按**台账**记：每应用一次存一条 {label, mat}，属性面板展开成时间线。
     * 撤销走 LIFO（只允许退最后一步）—— 中间某一步在数学上可以移除
     * （把后面的重算一遍），但语义上说不清"撤掉第二步之后第三步算不算数"。
     */
    var XFORM_STEPS_MAX = 20;

    function recordXformStep(layer, label, m)
    {
        if (!layer || !m) { return; }
        if (!layer.xformSteps) { layer.xformSteps = []; }

        layer.xformSteps.push({
            label: label || '变换',
            mat: new Float64Array(m)
        });

        /* 只留最近 20 步：更早的虽然撤不回去，
         * 但累计值仍由 layer.xformMat 精确记录，不受影响。 */
        while (layer.xformSteps.length > XFORM_STEPS_MAX) { layer.xformSteps.shift(); }
    }

    /* 把 4×4 压成"旋转角 + 平移"的短文本（角度由 3×3 的迹反余弦得到） */
    /* tight=true：去掉括号与逗号后的空格，给窄容器（历史步骤行）用。
     * 精度两个参数保持一致 —— 同一个数字在主行与历史里显示成 556.3 / 556
     * 会让人以为两次数据不同。 */
    function xformBrief(m, degDigits, posDigits, tight)
    {
        var tr = m[0] + m[5] + m[10];
        var ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI;

        var head = 'R ' + ang.toFixed(degDigits) + '°  T ';
        var a = m[3].toFixed(posDigits);
        var b = m[7].toFixed(posDigits);
        var c = m[11].toFixed(posDigits);

        return tight ? (head + a + ',' + b + ',' + c)
                     : (head + '(' + a + ', ' + b + ', ' + c + ')');
    }

    /* layerOverride：属性面板操作的是「选中图层」，而默认目标是「数据对齐的目标层」，
     * 两者可能不是同一个 —— 不传的话撤销/逆变换会作用到别的图层上。 */
    function applyXformToLayer(m, label, layerOverride)
    {
        var tXform = nowMs();
        var layer = layerOverride || xformTargetLayer();
        if (!layer || !layer.data || !layer.data.positions)
        {
            xformInfo('请先在上方选择目标图层', true);
            return false;
        }

        if (!isRigidMat(m))
        {
            xformInfo('只支持刚性变换（旋转 + 平移）：当前矩阵含缩放、切变或镜像', true);
            return false;
        }

        var d = layer.data;
        /* 顺序很关键：必须【先撤销预览，再做变换】。
         *
         * writeXformMat 会触发 applyPreview，此时顶点已经是「原始 × M」。
         * 若在这个基础上再 xformPositions(m)，数据会变成「原始 × M²」；
         * 而紧接着的 clearPreview 又会把顶点 set() 回备份（即原始数据），
         * 两者叠加的结果就是 —— 应用完全没生效，数据弹回原位。
         *
         * 表现为"N-N 算出矩阵、点了应用、再跑 ICP 却被拉走"：
         * ICP 实际看到的是从未变换过的原始点云。
         */
        clearPreview();
        /* 配准预览挂在 previewMat 上：烘焙前必须清掉，否则渲染会「再乘一次」 */
        clearGpuPreview(layer);

        var before = bboxOfPositions(d.positions);

        /* 顶点是直接烘焙的，没有这层记录就无法还原"这个图层被变换过什么"。
         * 选中图层回显矩阵、判断「应用」是否需要高亮，都依赖它。 */
        layer.xformMat = mat4Mul(m, layer.xformMat || IDENT4);

        xformPositions(d.positions, m);
        if (d.uniqVerts) { xformPositions(d.uniqVerts, m); }
        if (d.normals) { xformNormals(d.normals, m); }

        d.bbox = bboxOfPositions(d.positions) || d.bbox;

        /* GPU 缓冲依赖顶点，必须重建。
         *
         * 释放同步做（快），**上传推到下一帧**：5 MB 顶点上传是这段里最重的
         * 同步操作之一，而它不在"数据是否正确"的关键路径上 —— 代价只是这一层
         * 少画一帧（~16ms），换来主线程提前让出，把配准收尾那一次长冻结削短。
         *
         * 用序号防重入：连续两次应用时只让最后一次的上传生效。 */
        if (app.renderer)
        {
            if (layer.gpu) { app.renderer.releaseLayer(layer); }
            layer.gpu = null;

            layer._uploadSeq = (layer._uploadSeq || 0) + 1;
            (function (lay, seq)
            {
                global.setTimeout(function ()
                {
                    if (!lay || !lay.data || lay._uploadSeq !== seq) { return; }
                    if (!app.renderer) { return; }
                    app.renderer.uploadLayer(lay);
                    app.markDirty();
                }, 0);
            })(layer, layer._uploadSeq);
        }

        /* 应用即表示这次配准收尾：退出选点模式，避免后续误点又加进列表。
         * 想继续选点就再点一次「开始选点」。 */
        /* 应用即收尾：退出选点（顺带把 suppressPick 摘掉，
         * 否则之后的单击会一直"选不中"） */
        if (regMode) { setRegMode(false); }

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
        /* 应用后数据会移动，相机不一定还框得住它（尤其 N-N 把整片移到另一片时）。
         * 这里不自动 fit —— 那会打断正在对比的画面；给一句可操作提示即可。 */
        setInfo(label + '已应用到 ' + layer.name + '　·　按 F 可重新适应视图');

        /* 应用完把框归零。
         *
         * 框的唯一语义是「待应用的增量」，已经烘焙进数据的矩阵不能再留在框里：
         * 否则用户切走再切回、或随手改一位数字，「应用」就会把同一段变换
         * 再加一遍（数据被推歪）。归零后基准同步为单位阵，
         * 按钮随之变灰，不需要依赖别处是否刷新过。 */
        writeXformMat(IDENT4);
        appliedMat = new Float64Array(16);
        for (var ai2 = 0; ai2 < 16; ai2++) { appliedMat[ai2] = IDENT4[ai2]; }
        refreshApplyState();

        /* 记一笔台账：哪一步、多大的增量。属性面板的"变换"一行靠它。
         *
         * 注意顺序：上面那次 renderProps() 发生在记录之前（那时台账还少一条），
         * 所以这里必须补刷一次 —— 否则"步数"永远比实际少 1，
         * 表现为"应用了两次却显示 1 步"。 */
        recordXformStep(layer, label, m);

        /* 属性面板显示的是「选中图层」：被应用的层恰好被选中时才刷，
         * 否则会把别的图层的账刷到面板上。 */
        if (app && app.getSelected() === layer) { renderXformProp(layer); }

        var xCount = Math.floor(d.positions.length / (layer.kind === 'mesh' ? 9 : 3));
        logTiming(label, nowMs() - tXform,
            formatCount(xCount) + (layer.kind === 'mesh' ? ' 三角形' : ' 点'));
        return true;
    }

    /* 对话框可拖动：标题栏按下并移动即可改位置，方便避开模型 */
    /* 迭代推进器：先按 rAF 对齐刷新率，再补一个最小间隔。
     * 只靠 rAF 的话，收敛快的配准 5 轮就结束（约 80ms），一闪而过；
     * 加 50ms 间隔后 40 轮约 2.6 秒，能看清数据被逐步拉近的过程。 */
    var ITER_MIN_GAP = 50;

    /* 主线程路径「一轮迭代」拆成多大一片（单位：源点个数）。
     *
     * 实测单点约 1.4 µs（12 万点/轮 ≈ 215 ms），24000 点约 34 ms ——
     * 正好是不掉帧的量级：一轮被拆成 5~7 片，片间让出主线程，
     * 视角可正常拖动，而不是整轮冻结 200 ms。
     * 累加器是同一份，**数值与一次跑完完全相同**
     * （已验证 iters / rms / used / 最终矩阵逐位一致）。
     * 只在没有 Worker 时（file:// 打开、线程不可用、回退路径）走这里。 */
    var ICP_SLICE = 24000;

    function nextIteration(fn, gap)
    {
        /* ICP 迭代需要肉眼可见的节奏（默认 50ms 一轮），
         * 但粗配准是按帧推进的批量任务，不该再额外等 —— 传 0 即可。
         *
         * 这里不再套 requestAnimationFrame：
         *   1) 后台标签页里 rAF 会被暂停/节流，配准会直接停住；
         *   2) 主线程忙时 rAF 也可能长时间不给回调（粗配准单步 80ms 时就出现过），
         *      表现为「进度条不动、像卡死」。
         * 计算用定时器节拍推进，画面照旧由 app.tick 的 rAF 负责重绘。 */
        global.setTimeout(fn, gap === undefined ? ITER_MIN_GAP : gap);
    }

    function bindDialogDrag()
    {
        var dlg = $('xform');
        if (!dlg) { return; }

        var box = dlg.querySelector('.modal-box');
        var title = box ? box.querySelector('.modal-title') : null;
        if (!box || !title) { return; }

        title.style.cursor = 'move';

        var dragging = false;
        var offX = 0;
        var offY = 0;

        title.addEventListener('pointerdown', function (ev)
        {
            // 别拦住标题栏右侧的「关闭」按钮
            if (ev.target && ev.target.tagName === 'BUTTON') { return; }

            var r = box.getBoundingClientRect();
            offX = ev.clientX - r.left;
            offY = ev.clientY - r.top;

            box.style.position = 'fixed';
            box.style.margin = '0';
            box.style.left = r.left + 'px';
            box.style.top = r.top + 'px';

            dragging = true;
            try { title.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
            ev.preventDefault();
        });

        title.addEventListener('pointermove', function (ev)
        {
            if (!dragging) { return; }

            var x = ev.clientX - offX;
            var y = ev.clientY - offY;

            // 始终留一小截在视口内，避免拖丢
            x = Math.max(0, Math.min(global.innerWidth - 100, x));
            y = Math.max(0, Math.min(global.innerHeight - 40, y));

            box.style.left = x + 'px';
            box.style.top = y + 'px';
        });

        function endDrag() { dragging = false; }
        title.addEventListener('pointerup', endDrag);
        title.addEventListener('pointercancel', endDrag);
    }

    /* 每次打开回到默认位置（靠左停靠） */
    function resetDialogPos()
    {
        var dlg = $('xform');
        var box = dlg ? dlg.querySelector('.modal-box') : null;
        if (!box) { return; }
        box.style.position = '';
        box.style.left = '';
        box.style.top = '';
        box.style.margin = '';
    }

    function openXformDialog()
    {
        buildXformGrid();
        refreshXformTargetLabel();
        if (xformInputs && xformInputs[0].value === '') { writeXformMat(identityMat()); }
        regFillSelects();
        icpFillSelects();
        refreshXformTargetLabel();

        // 侧栏常驻：切到「数据对齐」标签
        var sideTabs = document.querySelectorAll('#sidebar .panel-tabs .tab[data-tab]');
        for (var ti2 = 0; ti2 < sideTabs.length; ti2++)
        {
            if (sideTabs[ti2].getAttribute('data-tab') === 'xform')
            {
                sideTabs[ti2].click();
                break;
            }
        }
        xformInfo('');
    }

    /* ---------------- 手动 N-N 配准（Horn 四元数法） ---------------- */

    var regMode = false;          // 是否处于选点状态
    /* 参考层与目标层各自独立收集，不强制点击顺序 ——
     * 想先点哪个层就点哪个层。参考层第 i 个点记为 R{i}，
     * 目标层第 i 个点记为 A{i}，编号相同的就是一对。 */
    var regRefPts = [];           // 参考层（固定图层）上选的点
    var regDstPts = [];           // 目标层（移动图层）上选的点

    /* 每个点记录「拾取时该图层的累计变换」。
     * 图层被矩阵变换过（应用矩阵 / N-N 应用）之后，点必须跟着走，
     * 否则标记留在原地，而且 regSolve 用的也是过时坐标。 */
    var regRefMeta = [];
    var regDstMeta = [];

    function pickMetaOf(lay)
    {
        var base = (lay && lay.xformMat) ? new Float64Array(lay.xformMat) : identityMat();
        return { lid: lay ? lay.id : -1, base: base, pid: 0 };
    }

    /* 配对 id：每侧各自递增，R{pid} 与 A{pid} 是一对。
     *
     * 以前配对是"按数组下标"隐式成立的，于是**删点必然错位**：
     * 删掉 R1 之后，原来的 R2 顶到下标 1，就跟 A1（原本配 R1）配到了一起。
     * 改成显式 pid 后，删点不重排、不改变任何已有配对关系。 */
    function nextPickPid(metas)
    {
        var mx = -1;
        for (var i = 0; i < metas.length; i++)
        {
            if (metas[i] && metas[i].pid > mx) { mx = metas[i].pid; }
        }
        return mx + 1;
    }

    /* 入栈一个选点，返回它的编号（= pid） */
    function addPick(side, lay, p)
    {
        var isRef = (side === 'ref');
        var pts = isRef ? regRefPts : regDstPts;
        var metas = isRef ? regRefMeta : regDstMeta;

        var meta = pickMetaOf(lay);
        meta.pid = nextPickPid(metas);

        pts.push(p);
        metas.push(meta);
        return meta.pid;
    }

    /* 删除选点。alsoOther=true 时连带删除配对侧同 pid 的点。
     * 返回被删掉的编号，没删到返回 -1。 */
    function delPick(side, idx, alsoOther)
    {
        var isRef = (side === 'ref');
        var pts = isRef ? regRefPts : regDstPts;
        var metas = isRef ? regRefMeta : regDstMeta;

        if (idx < 0 || idx >= pts.length) { return -1; }

        var pid = metas[idx] ? metas[idx].pid : idx;
        pts.splice(idx, 1);
        metas.splice(idx, 1);

        if (alsoOther)
        {
            var oPts = isRef ? regDstPts : regRefPts;
            var oMetas = isRef ? regDstMeta : regRefMeta;
            for (var i = oMetas.length - 1; i >= 0; i--)
            {
                if (oMetas[i] && oMetas[i].pid === pid)
                {
                    oPts.splice(i, 1);
                    oMetas.splice(i, 1);
                }
            }
        }

        return pid;
    }

    function syncPickPts()
    {
        if (!app) { return; }

        function syncOne(pts, meta)
        {
            for (var i = 0; i < pts.length; i++)
            {
                var m = meta[i];
                if (!m) { continue; }

                var lay = findLayerById(m.lid);
                if (!lay) { continue; }

                var now = lay.xformMat ? lay.xformMat : identityMat();
                if (matSame(now, m.base)) { continue; }

                /* 只补差异部分：delta = 当前累计变换 × 拾取时累计变换的逆 */
                var delta = mat4Mul(now, mat4Invert(m.base));
                var out = [0, 0, 0];
                xformPoints([pts[i][0], pts[i][1], pts[i][2]], delta, out);

                pts[i][0] = out[0];
                pts[i][1] = out[1];
                pts[i][2] = out[2];
                m.base = new Float64Array(now);
            }
        }

        syncOne(regDstPts, regDstMeta);
        syncOne(regRefPts, regRefMeta);
    }

    /* 数据空间 ↔ 显示空间。
     *
     * 除了「已经烘焙进数据的变换」（由 syncPickPts 用 xformMat 的增量补），
     * 还有一种位姿只存在于渲染层：`layer.previewMat`（矩阵框预览 / ICP 每轮预览）。
     * 它不改数据、也不改 xformMat，所以标记和拾取都必须各自换算：
     *
     *   显示：数据坐标 ──previewMat──▶ 屏幕（否则点云在预览里移开了，标签留在原地）
     *   拾取：屏幕 ──rayPick 得数据坐标──▶ 但用户点的是预览后的位置，
     *         所以要乘 inv(previewMat) 换回数据空间再存，两边才对得上。
     *
     * 存储与求解一律用数据空间（regSolve、误差、配对都不受预览影响）。 */
    function pickDisplayPos(p, meta)
    {
        var lay = (meta && meta.lid >= 0) ? findLayerById(meta.lid) : null;
        if (!lay || !lay.previewMat) { return p; }

        var out = new Float64Array(3);
        xformPoints([p[0], p[1], p[2]], lay.previewMat, out);
        return out;
    }

    function pickToData(p, lay)
    {
        if (!lay || !lay.previewMat) { return p.slice(); }

        var out = new Float64Array(3);
        xformPoints([p[0], p[1], p[2]], mat4Invert(lay.previewMat), out);
        return [out[0], out[1], out[2]];
    }

    /* 该点所属图层是否还在、是否可见 */
    function pickVisible(meta)
    {
        if (!meta || meta.lid === undefined || meta.lid < 0) { return true; }
        var lay = findLayerById(meta.lid);
        if (!lay) { return false; }
        return lay.visible !== false;
    }

    /* 配对：按 pid 相同配对（不再按数组下标），顺序按 pid 升序 */
    function regBuildPairs()
    {
        var byPid = {};
        var i;
        for (i = 0; i < regRefPts.length; i++)
        {
            var pidR = regRefMeta[i] ? regRefMeta[i].pid : i;
            byPid[pidR] = { p: regRefPts[i], i: i };
        }

        var out = [];
        for (i = 0; i < regDstPts.length; i++)
        {
            var pidD = regDstMeta[i] ? regDstMeta[i].pid : i;
            var hit = byPid[pidD];
            if (!hit) { continue; }
            out.push({ s: regDstPts[i], d: hit.p, pid: pidD,
                       ri: hit.i, ai: i });
        }

        out.sort(function (a, b) { return a.pid - b.pid; });
        return out;
    }


    /* 4×4 对称矩阵的最大特征值对应的特征向量（Jacobi 旋转法） */

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

    /* 参考层与目标层必须互斥 —— 同一个图层不可能既当参考又当目标，
     * 否则配准会退化成"自己配自己"，矩阵恒为单位阵、迭代毫无意义。
     *
     * 之前两个下拉填充完全相同的候选列表，默认值又都落在第一项，
     * 于是只导入一个图层时两边指向同一层。 */
    function fillLayerSelects(refSel, dstSel)
    {
        if (!refSel || !dstSel || !app) { return; }

        var cands = [];
        for (var i = 0; i < app.layers.length; i++)
        {
            var L = app.layers[i];

            // 只要能拿到顶点就允许参与配准，不再看 kind / visible。
            // 配准本身不需要图层可见；要求 visible 会造成"下拉一片空白却不知原因"。
            if (!L || !L.data || !L.data.positions || L.data.positions.length < 9) { continue; }

            cands.push(L);
        }

        var prevRef = refSel.value;
        var prevDst = dstSel.value;

        /* 少于两个图层时无法配对：两个下拉都清空，
         * 配合 CSS 的 select:empty 隐藏箭头，视觉上就是空白。 */
        if (cands.length < 2)
        {
            refSel.innerHTML = '';
            dstSel.innerHTML = '';
            return;
        }

        function hasId(id)
        {
            if (!id) { return false; }
            for (var k = 0; k < cands.length; k++)
            {
                if (String(cands[k].id) === id) { return true; }
            }
            return false;
        }

        function firstExcept(excludeId)
        {
            for (var k = 0; k < cands.length; k++)
            {
                if (String(cands[k].id) !== excludeId) { return String(cands[k].id); }
            }
            return '';
        }

        var refId = '';
        var dstId = '';

        /* 首次填充（两者都还是空）：目标层优先取场景树当前选中层，
         * 参考层取任意一个不同的层。 */
        if (!prevRef && !prevDst)
        {
            var sel = app.getSelected();
            if (sel && hasId(String(sel.id)))
            {
                dstId = String(sel.id);
                refId = firstExcept(dstId);
            }
        }

        // 保持原选择，但不允许与对方重合
        if (!refId && hasId(prevRef) && prevRef !== prevDst) { refId = prevRef; }
        if (!refId) { refId = firstExcept(prevDst); }

        if (!dstId && hasId(prevDst) && prevDst !== refId) { dstId = prevDst; }
        if (!dstId) { dstId = firstExcept(refId); }

        /* 填充时各自排除对方的选中值，从候选层面就杜绝重复选择 */
        function fill(sel, keepValue, excludeId)
        {
            sel.innerHTML = '';
            for (var k = 0; k < cands.length; k++)
            {
                if (String(cands[k].id) === excludeId) { continue; }
                var o = document.createElement('option');
                o.value = String(cands[k].id);

                /* 带上槽位：两个文件同名时（很常见，比如两次扫描都叫 m），
                 * 只显示名字根本分不清哪个是参考、哪个是目标，
                 * 选错层会让整次配准白做。 */
                var slotTag = cands[k].slot === 'A' ? '左侧'
                            : (cands[k].slot === 'B' ? '右侧' : '公共');
                o.textContent = cands[k].name + ' · ' + slotTag;

                sel.appendChild(o);
            }
            if (keepValue) { sel.value = keepValue; }
        }

        fill(refSel, refId, dstId);
        fill(dstSel, dstId, refId);

        // fill 里若因排除导致 value 落空，这里再兜一次
        if (refSel.value !== refId && refId) { refSel.value = refId; }
        if (dstSel.value !== dstId && dstId) { dstSel.value = dstId; }
    }

    function regFillSelects() { fillLayerSelects($('reg-ref'), $('reg-dst')); }
    function icpFillSelects() { fillLayerSelects($('icp-ref'), $('icp-dst')); }

    /* 参考 / 目标 是一对互斥下拉：各自排除对方的当前值。
     *
     * 但「排除」只在 re-fill 的那一刻成立 —— 改了目标之后如果不重填参考，
     * 参考里仍留着旧选项（既包含刚被选走的那层，又缺少刚被释放出来的那层），
     * 于是可以选出「参考 === 目标」。这里给四个 select 挂 change，
     * 谁变了就重填这一对。 */
    function bindPairSelects()
    {
        var pairs = [
            { ref: 'reg-ref', dst: 'reg-dst', fill: regFillSelects },
            { ref: 'icp-ref', dst: 'icp-dst', fill: icpFillSelects }
        ];

        for (var i = 0; i < pairs.length; i++)
        {
            (function (p)
            {
                var r = $(p.ref);
                var d = $(p.dst);
                if (!r || !d) { return; }

                function onChange()
                {
                    /* 先重填这一对（保持各自的选中值，并互相排除），
                     * 再同步「目标图层」标签与矩阵回显 —— 目标层换了，
                     * 矩阵框和「应用」的基准都得跟着换。 */
                    p.fill();
                    refreshXformTargetLabel();
                }

                r.addEventListener('change', onChange);
                d.addEventListener('change', onChange);
            })(pairs[i]);
        }
    }

    /* ---------------- 屏幕序号标签层（N-N 选点 / 工具拾取共用） ----------------
     *
     * 两套标签的差别只有「数据源 + 前缀 + 配色」：
     *   #pick-marks  R{i} / A{i}   参考层 vs 目标层，成对选点用
     *   #tool-marks  P{i}          工具 → 拾取，最近的 3 个高亮
     * 投影、DOM 复用、视口裁剪、跟帧刷新全部共用下面这一份实现。 */

    var markLayers = {};            // id -> { box, els }

    function ensureMarkLayer(id)
    {
        var rec = markLayers[id];
        if (rec && rec.box && rec.box.isConnected) { return rec; }

        var host = $('view-area');
        if (!host) { return null; }

        var box = document.createElement('div');
        box.id = id;
        host.appendChild(box);

        rec = { box: box, els: [] };
        markLayers[id] = rec;
        return rec;
    }

    /* raw: [{ p, tag, num, cls }]，p 是世界坐标（已含当前位姿） */
    function paintMarks(id, raw)
    {
        var rec = ensureMarkLayer(id);
        if (!rec) { return; }

        var els = rec.els;
        var items = [];

        /* 单视图模式下视图 1 的 rect 会退化，投影结果挤在左上角 (0,1) 附近，
         * 于是每个点凭空多出一个"幽灵标签"。按实际可见视图数投影。 */
        var single = !!(app && app.settings && app.settings.singleView);
        var nViews = single ? 1 : (((app && app.views && app.views.length)) || 1);

        for (var r = 0; r < raw.length; r++)
        {
            /* 双视图并排时同一个点可能在两侧都可见，两侧都该标出来；
             * 只投影视图 0 会导致右视图里一个标签都没有。 */
            for (var vi = 0; vi < nViews; vi++)
            {
                var v = app.views && app.views[vi];
                if (!single && (!v || !v.rect || v.rect.w < 2 || v.rect.h < 2)) { continue; }

                var s0 = app.worldToScreen(raw[r].p, vi);
                if (!s0) { continue; }
                items.push({ x: s0.x, y: s0.y,
                             tag: raw[r].tag, num: raw[r].num, cls: raw[r].cls });
            }
        }

        while (els.length < items.length)
        {
            var el = document.createElement('div');
            el.className = 'pick-mark';
            el.innerHTML = '<span class="pm-tag"></span><span class="pm-num"></span>';
            rec.box.appendChild(el);
            els.push(el);
        }

        for (var k = 0; k < els.length; k++)
        {
            var el2 = els[k];

            if (k >= items.length)
            {
                if (el2.style.display !== 'none') { el2.style.display = 'none'; }
                continue;
            }

            var it = items[k];

            el2.style.display = '';          /* 交给样式表的 flex，别写死 block */
            el2.style.left = it.x.toFixed(1) + 'px';
            el2.style.top = it.y.toFixed(1) + 'px';
            el2.className = 'pick-mark ' + it.cls;

            /* 前缀与编号分开放（样式里同字号、只差透明度），内容全是内部常量 */
            var tagEl = el2.firstChild;
            var numEl = el2.lastChild;
            if (tagEl && tagEl.className === 'pm-tag') { tagEl.textContent = it.tag; }
            if (numEl && numEl.className === 'pm-num') { numEl.textContent = String(it.num); }
        }
    }

    /* ---------------- N-N 选点的序号标签 ---------------- */

    function regDrawMarks()
    {
        if (!app) { return; }

        /* 退出选点模式就不再显示标记 —— 否则选完点、
         * 应用完矩阵之后，那些 A0/R0 会一直挂在画面上。 */
        if (!regMode) { paintMarks('pick-marks', []); return; }

        /* 收集需要显示的点：目标侧 A0..An、参考侧 R0..Rn。
         * 每个点都要在【所有视图】里各投影一次 —— 双视图并排时
         * 同一个点可能在左右两侧都可见，两侧都该标出来；
         * 只投影视图 0 会导致右视图里一个标签都没有。 */
        /* 先把点同步到图层当前位姿，再投影 */
        syncPickPts();

        var raw = [];
        for (var i = 0; i < regDstPts.length; i++)
        {
            if (!pickVisible(regDstMeta[i])) { continue; }
            raw.push({ p: pickDisplayPos(regDstPts[i], regDstMeta[i]),
                       tag: 'A', num: (regDstMeta[i] ? regDstMeta[i].pid : i), cls: 'dst' });
        }
        for (var j = 0; j < regRefPts.length; j++)
        {
            if (!pickVisible(regRefMeta[j])) { continue; }
            raw.push({ p: pickDisplayPos(regRefPts[j], regRefMeta[j]),
                       tag: 'R', num: (regRefMeta[j] ? regRefMeta[j].pid : j), cls: 'ref' });
        }

        paintMarks('pick-marks', raw);
    }

    /* ---------------- 工具拾取的序号标签 ----------------
     *
     * 与 N-N 同一套标签、同一套跟帧，取代原来的 3D 十字：
     * 十字在薄板 / 点云上只有几条 1px 线，几乎看不清；标签能直接给编号，
     * 而且不用关深度测试（DOM 永远在最上层）。
     * 最近 3 个参与距离 / 角度计算，高亮；更早的做参照，压暗。 */

    function drawToolMarks()
    {
        if (!app) { return; }

        var pts = (app.pickInfo && app.pickPoints) ? app.pickPoints : [];
        if (!pts.length) { paintMarks('tool-marks', []); return; }

        var n = pts.length;
        var activeStart = Math.max(0, n - 3);
        var raw = [];

        for (var i = 0; i < n; i++)
        {
            if (!pts[i] || !pts[i].pos) { continue; }
            raw.push({ p: pts[i].pos, tag: 'P', num: i + 1,
                       cls: 'pick ' + (i >= activeStart ? 'active' : 'idle') });
        }

        paintMarks('tool-marks', raw);
    }

    /* ---------------- 标签跟帧 ----------------
     *
     * 更新必须和画面同帧。演变过程：
     *   1. 常驻 requestAnimationFrame：不在选点状态也每帧投影 + 写 DOM，白占主线程；
     *   2. 改成 50ms setInterval：省了开销，但拖视角时标签**明显滞后**
     *      （相机每帧动、标签 50ms 才挪一次，看上去"黏"在旧位置）；
     *   3. 现在挂在渲染循环末尾（app.onAfterRender），只用这一帧定稿的相机矩阵 ——
     *      与画面严格同帧（实测相机变化到标签更新 avg 6.5ms ≈ 一帧）。
     *
     * 两套标签共用一个回调：谁有内容谁就画，另一套自动清空。
     * 常驻注册一次即可 —— 比"进模式注册、退模式注销"少一类状态，
     * 也不会漏掉 Esc 之类的退出路径。 */

    function uiFrameMarks()
    {
        regDrawMarks();
        drawToolMarks();
    }

    /* ---------------- 列表与实时误差 ---------------- */

    /* 一次解算，摘要与表格共用：配对、逐对残差、最大残差 */
    function regEvaluate()
    {
        var pairs = regBuildPairs();
        var nPair = pairs.length;
        var live = null;

        if (nPair >= 3)
        {
            try { live = solveRigid(pairs); } catch (e) { live = null; }
        }

        var errs = [];
        var worst = 0;

        if (live && isFinite(live.rms))
        {
            var m = live.mat;
            for (var r = 0; r < nPair; r++)
            {
                var s3 = pairs[r].s, d3 = pairs[r].d;
                var tx = m[0] * s3[0] + m[1] * s3[1] + m[2] * s3[2] + m[3];
                var ty = m[4] * s3[0] + m[5] * s3[1] + m[6] * s3[2] + m[7];
                var tz = m[8] * s3[0] + m[9] * s3[1] + m[10] * s3[2] + m[11];
                var ex = tx - d3[0], ey = ty - d3[1], ez = tz - d3[2];
                var err = Math.sqrt(ex * ex + ey * ey + ez * ez);
                errs.push(err);
                if (err > worst) { worst = err; }
            }
        }

        return { pairs: pairs, nPair: nPair, live: live, errs: errs, worst: worst };
    }

    function regRender()
    {
        var ev = regEvaluate();
        regRenderSummary(ev);
        regTableRender(ev);
        /* 显式画一次：选点增删时场景未必 dirty（没有新的一帧），
         * 光靠跟帧回调要等到下次渲染才更新。 */
        regDrawMarks();
    }

    /* 侧栏只放一行摘要，明细在右上角的浮动表格里 —— 面板宽度有限，
     * 逐点坐标 + 残差堆成十几行会把「计算矩阵」挤出可视区。 */
    function regRenderSummary(ev)
    {
        var el = $('reg-list');
        if (!el) { return; }

        var lines = [];
        var nR = regRefPts.length, nD = regDstPts.length;

        if (!nR && !nD)
        {
            lines.push('尚未选点');
        }
        else
        {
            lines.push('参考 ' + nR + ' 点 / 目标 ' + nD + ' 点 · 已配 ' + ev.nPair + ' 对');

            if (ev.nPair < 3) { lines.push('还差 ' + (3 - ev.nPair) + ' 对才能计算'); }

            if (ev.live && isFinite(ev.live.rms))
            {
                lines.push('RMS ' + ev.live.rms.toFixed(3) + ' mm · 最大 ' + ev.worst.toFixed(3) + ' mm');
            }
        }

        lines.push(regTableVisible ? '（点此收起选点表格）' : '（点此展开选点表格）');
        el.textContent = lines.join('\n');
        el.title = '展开 / 收起右上角的选点表格';
    }

    /* ---------------- 浮动选点表格（默认右上角，可拖动） ---------------- */

    var regTableEl = null;
    var regTableVisible = false;
    var regTableDrag = null;
    var regTableMoved = false;      // 用户拖动过就固定在他摆的位置，不再自动排布

    /* 右上角有两个浮层：拾取面板（pickbar）与选点表格。
     * 默认都贴 right:16，纵向堆叠 —— 拾取面板在用时把表格推到它下面，
     * 否则两块会完全重叠（实测：先拾取再进 N-N，表格正好盖住拾取信息）。 */
    function positionRegTable()
    {
        if (!regTableEl || !regTableVisible || regTableMoved) { return; }

        var top = 14;
        var bar = $('pickbar');
        if (bar && !bar.classList.contains('hidden'))
        {
            top = bar.offsetTop + bar.offsetHeight + 8;
        }

        regTableEl.style.top = top + 'px';
        regTableEl.style.right = '16px';
        regTableEl.style.left = 'auto';
    }

    function ensureRegTable()
    {
        if (regTableEl && regTableEl.isConnected) { return regTableEl; }

        var box = document.createElement('div');
        box.id = 'pick-table';
        box.className = 'pick-table';
        box.style.display = 'none';

        var head = document.createElement('div');
        head.className = 'pick-table-head';
        /* 静态骨架，无用户数据 */
        head.innerHTML =
            '<span class="pick-table-title">选点 / 误差</span>' +
            '<label class="pick-table-link" title="删除一侧的点时，同时删掉另一侧的配对点">' +
                '<input type="checkbox" id="pick-del-link" checked> 联动删除</label>' +
            '<button type="button" class="pick-table-x" id="pick-table-hide" title="收起">×</button>';

        var body = document.createElement('div');
        body.className = 'pick-table-body';
        body.innerHTML =
            '<table><thead><tr>' +
            '<th class="c-id">#</th><th>参考 R</th><th class="c-del"></th>' +
            '<th>目标 A</th><th class="c-del"></th><th class="c-err">残差</th>' +
            '</tr></thead><tbody></tbody></table>';

        var foot = document.createElement('div');
        foot.className = 'pick-table-foot';

        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);

        /* 挂到视图区而不是 body：表格与拾取面板、标量条是同一层浮层，
         * 坐标要统一相对「视图区」，否则侧栏拖宽、日志拖高之后它就飘了。 */
        var host = $('view-area') || document.body;
        host.appendChild(box);

        var xBtn = head.querySelector('#pick-table-hide');
        if (xBtn)
        {
            xBtn.addEventListener('click', function (e)
            {
                e.preventDefault();
                e.stopPropagation();
                setRegTableVisible(false);
            });
        }

        /* 拖动：只在标题栏按下（别把复选框/按钮的点击当成拖动） */
        head.addEventListener('pointerdown', function (e)
        {
            var tg = e.target;
            if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'BUTTON' ||
                       tg.tagName === 'LABEL' || tg.tagName === 'SPAN')) { return; }

            var rect = box.getBoundingClientRect();

            /* 表格是 #view-area 里的 absolute 元素：getBoundingClientRect 给的是
             * 视口坐标，必须减去视图区原点才能换算成 left/top，否则一拖就跳
             * 一个侧栏宽度（fixed 改 absolute 时最容易漏的一步）。 */
            var host = $('view-area');
            var hr = host ? host.getBoundingClientRect() : { left: 0, top: 0 };

            regTableDrag = {
                dx: e.clientX - rect.left,
                dy: e.clientY - rect.top,
                ox: hr.left,
                oy: hr.top,
                w: host ? host.clientWidth : (global.innerWidth || 1280),
                h: host ? host.clientHeight : (global.innerHeight || 800)
            };
            regTableMoved = true;   /* 用户摆过位置就别再自动排布 */

            /* 从 right 定位切到 left 定位，后续按 left/top 移动 */
            box.style.left = (rect.left - hr.left) + 'px';
            box.style.top = (rect.top - hr.top) + 'px';
            box.style.right = 'auto';

            head.classList.add('dragging');
            if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (e2) { } }
            e.preventDefault();
        });

        head.addEventListener('pointermove', function (e)
        {
            if (!regTableDrag) { return; }

            var dg = regTableDrag;
            var x = Math.max(0, Math.min(dg.w - 140, e.clientX - dg.dx - dg.ox));
            var y = Math.max(0, Math.min(dg.h - 44, e.clientY - dg.dy - dg.oy));

            box.style.left = x + 'px';
            box.style.top = y + 'px';
        });

        function endDrag()
        {
            regTableDrag = null;
            head.classList.remove('dragging');
        }

        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);

        /* 删除按钮：委托到 tbody，表格重绘时无需重新绑定 */
        var tbody = body.querySelector('tbody');
        if (tbody)
        {
            tbody.addEventListener('click', function (e)
            {
                var btn = e.target;
                while (btn && btn !== tbody && btn.tagName !== 'BUTTON') { btn = btn.parentNode; }
                if (!btn || btn === tbody || btn.className.indexOf('pick-del') < 0) { return; }

                e.preventDefault();
                e.stopPropagation();

                var side = btn.getAttribute('data-side');
                var pid = parseInt(btn.getAttribute('data-pid'), 10);
                var linkEl = box.querySelector('#pick-del-link');
                var alsoOther = !!(linkEl && linkEl.checked);

                var metas = (side === 'ref') ? regRefMeta : regDstMeta;
                var idx = -1;
                for (var k = 0; k < metas.length; k++)
                {
                    if ((metas[k] ? metas[k].pid : k) === pid) { idx = k; break; }
                }
                if (idx < 0) { return; }

                delPick(side, idx, alsoOther);
                regRender();
                setInfo('已删除 ' + (side === 'ref' ? 'R' : 'A') + pid +
                        (alsoOther ? '（含配对侧的同一个点）' : '') +
                        '    参考 ' + regRefPts.length + ' / 目标 ' + regDstPts.length);
            });
        }

        regTableEl = box;
        return box;
    }

    function setRegTableVisible(on)
    {
        var box = ensureRegTable();
        if (!box) { return; }

        regTableVisible = !!on;
        box.style.display = regTableVisible ? 'flex' : 'none';
        positionRegTable();

        /* 摘要里的"点此展开/收起"要跟着变 */
        regRenderSummary(regEvaluate());
        if (regTableVisible) { regTableRender(regEvaluate()); }
    }

    /* 所有选点的 pid 并集（含尚未配对的一侧） */
    function regCollectPids()
    {
        var pids = [], seen = {};
        var i;

        function add(metas, idx)
        {
            var pid = (metas[idx] ? metas[idx].pid : idx);
            if (!seen[pid]) { seen[pid] = 1; pids.push(pid); }
        }

        for (i = 0; i < regRefPts.length; i++) { add(regRefMeta, i); }
        for (i = 0; i < regDstPts.length; i++) { add(regDstMeta, i); }

        pids.sort(function (a, b) { return a - b; });
        return pids;
    }

    function regTableRender(ev)
    {
        if (!regTableEl || !regTableVisible) { return; }

        var tbody = regTableEl.querySelector('tbody');
        var foot = regTableEl.querySelector('.pick-table-foot');
        if (!tbody || !foot) { return; }

        var nR = regRefPts.length, nD = regDstPts.length;

        if (!nR && !nD)
        {
            tbody.innerHTML = '<tr><td colspan="6" class="pick-table-empty">' +
                              '在视口里点同名位置即可选点</td></tr>';
            foot.textContent = '参考 0 / 目标 0';
            return;
        }

        var pids = regCollectPids();
        var refAt = {}, dstAt = {}, errAt = {};
        var i, pid;

        for (i = 0; i < regRefPts.length; i++)
        {
            pid = (regRefMeta[i] ? regRefMeta[i].pid : i);
            refAt[pid] = i;
        }
        for (i = 0; i < regDstPts.length; i++)
        {
            pid = (regDstMeta[i] ? regDstMeta[i].pid : i);
            dstAt[pid] = i;
        }
        for (i = 0; i < ev.pairs.length && i < ev.errs.length; i++)
        {
            errAt[ev.pairs[i].pid] = ev.errs[i];
        }

        function delBtn(side, id)
        {
            return '<button type="button" class="pick-del" data-side="' + side +
                   '" data-pid="' + id + '" title="删除' +
                   (side === 'ref' ? ' R' : ' A') + id + '">×</button>';
        }

        var html = [];
        for (i = 0; i < pids.length; i++)
        {
            pid = pids[i];

            var hasR = (refAt[pid] !== undefined);
            var hasA = (dstAt[pid] !== undefined);
            var err = errAt[pid];

            html.push(
                '<tr' + ((hasR && hasA) ? '' : ' class="half"') + '>' +
                '<td class="c-id">' + pid + '</td>' +
                '<td class="c-pos">' + (hasR ? fmt3p(regRefPts[refAt[pid]]) : '—') + '</td>' +
                '<td class="c-del">' + (hasR ? delBtn('ref', pid) : '') + '</td>' +
                '<td class="c-pos">' + (hasA ? fmt3p(regDstPts[dstAt[pid]]) : '—') + '</td>' +
                '<td class="c-del">' + (hasA ? delBtn('dst', pid) : '') + '</td>' +
                '<td class="c-err">' + ((err === undefined) ? '—' : err.toFixed(3)) + '</td>' +
                '</tr>');
        }

        tbody.innerHTML = html.join('');

        var txt = '参考 ' + nR + ' / 目标 ' + nD + ' · 已配 ' + ev.nPair + ' 对';
        if (ev.live && isFinite(ev.live.rms))
        {
            txt += ' · RMS ' + ev.live.rms.toFixed(3) + ' mm · 最大 ' + ev.worst.toFixed(3) + ' mm';
        }
        else if (ev.nPair < 3)
        {
            txt += ' · 还差 ' + (3 - ev.nPair) + ' 对';
        }
        foot.textContent = txt;
    }

    function regClearAll()
    {
        regRefPts.length = 0;
        regDstPts.length = 0;
        regRefMeta.length = 0;
        regDstMeta.length = 0;
        regRender();
    }

    /* 进入 / 退出 N-N 选点模式。
     *
     * 「工具 → 拾取」和 N-N 选点都用**左键单击取点**，两者同时开着时
     * 一次单击会被两边都接走（实测：选点模式下再点一次，R/A 标签没增加，
     * 拾取点却 +1 —— 因为 regPick 没配好层时直接 return，而 addPickPoint
     * 照样执行）。所以两者**互斥**：进选点先关拾取，进拾取先退选点。
     *
     * 另给 app 挂 `suppressPick`：连「Ctrl+单击设旋转中心」「双击设中心」
     * 一并挡掉 —— 选点时手一抖带 Ctrl，相机中心就被改了，很难察觉。 */
    function setRegMode(on)
    {
        regMode = !!on;

        var btn = $('reg-start');
        if (btn) { btn.textContent = regMode ? '停止选点' : '开始选点'; }

        if (app)
        {
            if (regMode && app.pickInfo && app.setPickInfo) { app.setPickInfo(false); }
            app.suppressPick = regMode;
            if (app.setPickCursor) { app.setPickCursor(regMode); }
        }

        setInfo(regMode
            ? '配准选点：点参考层和目标层上的任意位置，按层自动编号 R0..／A0..'
            : '已结束选点（标记已隐藏，点「开始选点」可继续）');

        /* 选点期间把表格挂出来；退出选点时收掉，免得挡住视口 */
        setRegTableVisible(regMode);
        regRender();
        regDrawMarks();     // 立刻刷一次，退出时把标记抹掉
    }

    function regPick(cx, cy)
    {
        if (!app) { return; }

        var refId = parseInt($('reg-ref').value, 10);
        var dstId = parseInt($('reg-dst').value, 10);
        var refLay = findLayerById(refId);
        var dstLay = findLayerById(dstId);

        /* 关键：按「点击所在的视图」决定能选哪一层。
         *
         * 渲染时左视图只画 A + S、右视图只画 B + S。如果在左视图里
         * 强行对 B 层求交，射线会穿过 A 打到看不见的 B 的背面，
         * 拿到的坐标和用户视觉上的落点毫无关系 —— 这是"选点不精准"
         * 的根源。所以这里先问：本视图到底显示哪些槽位。 */
        var vi = app.viewIndexAt ? app.viewIndexAt(cx) : 0;
        var v = app.views && app.views[vi];
        var slotsHere = [];

        /* 单视图模式渲染所有可见图层，与槽位无关 —— 这里也要放开，
         * 否则 N-N 在单视图下会误报"本视图没有显示参考层或目标层"。 */
        if (app.settings && app.settings.singleView)
        {
            slotsHere = ['A', 'B', 'S'];
        }
        else if (v && v.slots)
        {
            if (v.slots.A) { slotsHere.push('A'); }
            if (v.slots.B) { slotsHere.push('B'); }
            if (v.slots.S) { slotsHere.push('S'); }
        }

        var refHere = refLay && slotsHere.indexOf(refLay.slot) >= 0;
        var dstHere = dstLay && slotsHere.indexOf(dstLay.slot) >= 0;

        if (!refHere && !dstHere)
        {
            var layName = (v && v.slots)
                ? (v.slots.A ? '左侧 (A)' : (v.slots.B ? '右侧 (B)' : '本视图'))
                : '本视图';
            setInfo(layName + ' 没有显示参考层或目标层，请点到对应的一侧');
            return;
        }

        var takeRef;

        if (refHere && !dstHere)
        {
            takeRef = true;
        }
        else if (!refHere && dstHere)
        {
            takeRef = false;
        }
        else
        {
            /* 两层都在本视图可见（例如都属公共层 S，或单视图模式）：
             * 分别求交，补给数量少的那边。 */
            var hitRef2 = app.rayPickLayer ? app.rayPickLayer(cx, cy, refId) : null;
            var hitDst2 = app.rayPickLayer ? app.rayPickLayer(cx, cy, dstId) : null;

            if (!hitRef2 && !hitDst2)
            {
                setInfo('该位置没有命中参考层或目标层');
                return;
            }

            takeRef = (hitRef2 && hitDst2)
                ? (regRefPts.length <= regDstPts.length)
                : !!hitRef2;

            if (takeRef)
            {
                var pRef2 = pickToData(hitRef2.pos, refLay);
                var pidR = addPick('ref', refLay, pRef2);
                setInfo('已选 R' + pidR + '  参考层 (' +
                        fmt3p(pRef2) + ')    参考 ' + regRefPts.length +
                        ' / 目标 ' + regDstPts.length);
            }
            else
            {
                var pDst2 = pickToData(hitDst2.pos, dstLay);
                var pidD = addPick('dst', dstLay, pDst2);
                setInfo('已选 A' + pidD + '  目标层 (' +
                        fmt3p(pDst2) + ')    参考 ' + regRefPts.length +
                        ' / 目标 ' + regDstPts.length);
            }

            regRender();
            return;
        }

        // 只有一侧在本视图可见：直接对它求交
        var layerId = takeRef ? refId : dstId;
        var hit = app.rayPickLayer ? app.rayPickLayer(cx, cy, layerId) : null;

        if (!hit)
        {
            setInfo('该位置没有命中' + (takeRef ? '参考层' : '目标层'));
            return;
        }

        var pData = pickToData(hit.pos, takeRef ? refLay : dstLay);

        if (takeRef)
        {
            var pidR2 = addPick('ref', refLay, pData);
            setInfo('已选 R' + pidR2 + '  参考层 (' +
                    fmt3p(pData) + ')    参考 ' + regRefPts.length +
                    ' / 目标 ' + regDstPts.length);
        }
        else
        {
            var pidD2 = addPick('dst', dstLay, pData);
            setInfo('已选 A' + pidD2 + '  目标层 (' +
                    fmt3p(pData) + ')    参考 ' + regRefPts.length +
                    ' / 目标 ' + regDstPts.length);
        }

        regRender();
    }

    function regSolve()
    {
        var pairs = regBuildPairs();

        if (pairs.length < 3)
        {
            xformInfo('至少需要 3 对点（当前 ' + pairs.length + ' 对：参考 ' +
                      regRefPts.length + ' 点 / 目标 ' + regDstPts.length + ' 点）', true);
            return;
        }
        var res = solveRigid(pairs);
        if (!res)
        {
            xformInfo('求解失败：点对可能共线或重合', true);
            return;
        }

        writeXformMat(res.mat);
        xformInfo('N-N 配准完成：' + pairs.length + ' 对，RMS = ' + res.rms.toFixed(4) +
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

    /* ---------------- ICP 终止 ----------------
     * 运行中再点一次「运行 ICP」即终止；Esc 也走同一条路。
     *
     * 终止不用 clearTimeout：整条链路是同一个 tick 循环，
     * 只要让「运行编号」失效，下一帧 tick 直接返回即可，
     * 顺带把已经在队列里的 setTimeout / rAF 一起作废。 */
    var icpRunSeq = 0;          // 每次运行递增；不相等即视为已终止
    var icpRunning = false;

    function isIcpRunning() { return icpRunning; }

    function setIcpRunningUi(on)
    {
        var btn = $('icp-run');
        if (!btn) { return; }

        btn.textContent = on ? '终止' : '运行 ICP';
        btn.classList.toggle('danger', !!on);
        btn.title = on
            ? '停止当前配准并还原数据（快捷键 Esc）'
            : '以当前参数运行 ICP（运行中可按 Esc 终止）';
    }

    /* ---------------- ICP Worker（配准计算线程） ----------------
     *
     * 把 ICP 迭代搬到 Web Worker：主线程只收进度、写一个预览 uniform，
     * 配准期间保持 60fps 可拖视角。
     *
     * 此前 ICP 单轮 ~215ms、收尾轮再 20 轮，全在主线程就是一串 200ms 级冻结
     * （实测最大帧间隔 933ms）。搬过去之后这些计算不再占主线程。
     *
     * 详见 js/worker_icp.js。Worker 不可用（老浏览器 / 创建失败）时自动退回
     * 原来的 tick 主线程推进 —— 两条路径的收敛判据与烘焙逻辑完全一致。
     */
    var icpWorkerInst = null;
    var icpWorkerSeq = 0;
    var icpWorkerBroken = false;

    /* 把 ui.js 自己的 ?v= 也带给 worker，否则它 importScripts 的 core/algo
     * 会命中旧缓存，出现"页面是新的、算法是旧的"这种极难查的问题。 */
    function scriptVersionTag()
    {
        var s = document.querySelector('script[src*="ui.js"]');
        if (!s) { return ''; }
        var m = /[?&]v=([^&]+)/.exec(s.src);
        return m ? m[1] : '';
    }

    /* 挂起请求：id -> reject。Worker 崩了必须把它们全部结掉，
     * 否则 Promise 永远 pending —— 表现为「点了运行停在准备阶段、
     * 按钮一直是终止、再点也没用」。 */
    var icpWorkerPending = {};

    function rejectAllPending(msg)
    {
        var keys = [];
        for (var k in icpWorkerPending)
        {
            if (icpWorkerPending.hasOwnProperty(k)) { keys.push(k); }
        }
        for (var i = 0; i < keys.length; i++)
        {
            var fn = icpWorkerPending[keys[i]];
            delete icpWorkerPending[keys[i]];
            try { fn(new Error(msg)); } catch (e) { }
        }
    }

    function getIcpWorker()
    {
        if (icpWorkerInst || icpWorkerBroken) { return icpWorkerInst; }
        if (!global.Worker) { icpWorkerBroken = true; return null; }

        try
        {
            var v = scriptVersionTag();
            icpWorkerInst = new global.Worker('js/worker_icp.js' + (v ? ('?v=' + v) : ''));

            /* 脚本加载失败 / Worker 内未捕获异常。
             * 没有这一层，importScripts 被 MIME 拒绝时是「静默失效」：
             * 主线程照样流畅，但一个进度都不回来。 */
            icpWorkerInst.onerror = function (e)
            {
                icpWorkerBroken = true;
                icpWorkerInst = null;
                var m = (e && e.message) ? e.message : 'Worker 加载失败';
                rejectAllPending(m);
                if (global.console && console.warn) { console.warn('[icp worker]', m); }
            };
        }
        catch (e)
        {
            icpWorkerBroken = true;
            icpWorkerInst = null;
        }
        return icpWorkerInst;
    }

    /* 一次请求；onStep 在每轮迭代时回调。resolve 的是 done / ready / mats 消息 */
    function icpWorkerCall(msg, onStep)
    {
        var w = getIcpWorker();
        if (!w) { return Promise.reject(new Error('no worker')); }

        var id = ++icpWorkerSeq;
        msg.id = id;

        return new Promise(function (resolve, reject)
        {
            var settled = false;
            var timer = null;

            function finish(fn, v)
            {
                if (settled) { return; }
                settled = true;
                delete icpWorkerPending[id];
                if (timer) { clearTimeout(timer); timer = null; }
                w.removeEventListener('message', onMsg);
                fn(v);
            }

            function onMsg(e)
            {
                var m = e.data || {};
                if (m.id !== id) { return; }

                if (m.type === 'step')
                {
                    if (onStep) { onStep(m); }
                    return;
                }

                if (m.type === 'cancelled') { finish(reject, new Error('cancelled')); return; }
                if (m.type === 'error') { finish(reject, new Error(m.message || 'worker error')); return; }

                finish(resolve, m);
            }

            icpWorkerPending[id] = function (err) { finish(reject, err); };

            /* 超时兜底：Worker 被系统挂起、脚本没起来时不能无限等。
             * solve 可能跑几十秒，给 120s；其余握手类 20s。 */
            timer = setTimeout(function ()
            {
                /* 超时按「线程不可用」处理：标记损坏，让上层回退主线程，
                 * 而不是把整个配准判成失败。 */
                icpWorkerBroken = true;
                finish(reject, new Error('worker 超时（' + msg.cmd + '）'));
            }, (msg.cmd === 'solve') ? 120000 : 20000);

            w.addEventListener('message', onMsg);
            w.postMessage(msg);
        });
    }

    function cancelIcpWorker()
    {
        if (!icpWorkerInst) { return; }
        try { icpWorkerInst.postMessage({ cmd: 'cancel' }); } catch (e) { }
    }

    function finishIcpRun()
    {
        icpRunning = false;
        setIcpRunningUi(false);
    }

    function cancelICP()
    {
        if (!icpRunning) { return false; }

        icpRunSeq++;             // 让当前运行的后续 tick 全部失效
        cancelIcpWorker();       // Worker 路径：让它内部循环尽快退出
        finishIcpRun();

        /* 预览只挂在 layer.previewMat 上，数据没动过 —— 清掉矩阵即回到原位 */
        clearGpuPreview(xformTargetLayer());

        var info = $('icp-info');
        if (info) { info.textContent = '已终止，数据已还原到原位'; }

        setInfo('已终止配准，数据已还原', false, 'warn');
        return true;
    }

    /* 从图层取出配准用的点集与法向 */

    function icpRun()
    {
        if (!app || !global.MV.icp) { return; }

        /* 正在跑：这次点击是「终止」 */
        if (icpRunning) { cancelICP(); return; }

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

        /* 参考层用"当前世界"数据（它就是对齐目标），目标层用**原始快照**：
         * 求解器输出的是「原始 → 世界」的绝对位姿，与目标层当前位姿无关。 */
        var fixed = icpSample(refLay);

        var IDENT_POSE = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        var srcPose = dstLay.xformMat ? new Float64Array(dstLay.xformMat) : IDENT_POSE;

        var moving = icpSample(dstLay);

        /* 求解器（含 4PCS）给出的都是「原始 → 世界」的绝对位姿；
         * 预览矩阵挂在 uModel 上、作用对象是**当前**顶点 —— 必须换成增量。
         * 第一次配准 srcPose = I，两者相同，所以问题只在第二次之后暴露。 */
        function toDelta(m)
        {
            return m ? mat4Mul(m, mat4Invert(srcPose)) : null;
        }
        if (!fixed || !moving)
        {
            xformInfo('图层缺少可配准的数据', true);
            return;
        }

        // 实时预览会直接改写目标图层的顶点数据（数据级预览），
        // 而 icpSample 返回的是这些数组的引用 —— 不复制的话，
        // ICP 每轮都在追一个被预览挪动过的点集，永远收敛不了。
        /* 复制一份，并**复位到原始位姿**：P_orig = inv(pose) · P_cur。
         *
         * 不常驻保存原始顶点（大模型会多占十几 MB），只在本次配准期间构造这一份；
         * 这份副本本来就要（避免预览改写道具数组），所以峰值内存不变。
         * 复位后，每次运行的求解输入完全一致 —— 4PCS 的初值与当前位姿无关，
         * 于是重复点击「运行 ICP」得到零增量。 */
        var invPose = mat4Invert(srcPose);
        var mPos = xformPosCopy(moving.pos, invPose);
        moving = {
            kind: moving.kind, pos: mPos,
            positions: mPos,                  // Worker 的 normalsOf 用这份算面法向
            remap: moving.remap || null,
            vertCount: moving.vertCount || null,
            nrm: null, count: moving.count
        };
        var fPos = new Float32Array(fixed.pos);
        fixed = {
            kind: fixed.kind, pos: fPos,
            positions: fPos,
            remap: fixed.remap || null,
            vertCount: fixed.vertCount || null,
            nrm: null, count: fixed.count
        };

        var maxIter = clampInt($('icp-iter').value, 1, 200, 50);
        /* 把实际生效值写回输入框：输入超出范围时被钳制，界面显示的就是真实值 */
        if ($('icp-iter').value !== String(maxIter)) { $('icp-iter').value = maxIter; }
        var samplePct = clampInt($('icp-sample').value, 1, 100, 100);
        var sampleRatio = samplePct / 100;
        var angleDeg = parseFloat($('icp-angle').value);
        if (!isFinite(angleDeg)) { angleDeg = 30; }
        angleDeg = Math.max(0, Math.min(180, angleDeg));
        var thresh = Math.cos(angleDeg * Math.PI / 180);
        var maxDist = parseFloat($('icp-maxdist').value);
        if (!isFinite(maxDist) || maxDist < 0) { maxDist = 10; }
        var tol = 1e-7;

        /* 数据量大时给出采样推荐值，并直接写回界面 —— 参数框显示的就是
         * 实际使用的比例，不会出现"界面 100% 但内部偷偷采样"的错位。
         * 只在用户设了 100% 时才推荐；自己填过的值不覆盖。 */
        /* 单轮迭代的工作点上限。
         *
         * 演进：20 万 → 12 万 → 7.4 万。
         * 12 万在 24.7 万点的数据上取到 49%（约 10.9 万参与点），
         * 单轮实测 317ms —— 这一块是配准期间最大的帧冻结来源
         * （实测最大帧间隔 833ms、p95 300ms）。
         * 收紧到 7.4 万（约 30%）后单轮降到 ~215ms，而精度由后面两轮
         * 收紧容差补回来（历史数据：参与点 1774 → 1750 时最终 RMS 仅差 0.01）。
         *
         * 用户显式设过比例（<100%）时不会被这里覆盖，见下面的 if 条件。 */
        var AUTO_SAMPLE_MAX = 74000;
        var nSrcPts = Math.floor(moving.pos.length / 3);
        var sampleNote = '';

        if (samplePct >= 100 && nSrcPts > AUTO_SAMPLE_MAX)
        {
            var recPct = Math.max(1, Math.round(AUTO_SAMPLE_MAX / nSrcPts * 100));
            var sEl = $('icp-sample');
            if (sEl) { sEl.value = String(recPct); }

            samplePct = recPct;
            sampleRatio = recPct / 100;
            sampleNote = '\n采样已按数据量（' + nSrcPts + ' 点）调整为 ' + recPct + '%';
        }


        var info = $('icp-info');
        var target = xformTargetLayer();

        // 数据尺度：用于判断配准是否发散。
        // icpSample 只返回 {pos,nrm,count}，没有 bbox，必须从图层取。
        var diag = 0;
        var db = refLay.data ? refLay.data.bbox : null;
        if (db && db.min && db.max)
        {
            var dbx = db.max[0] - db.min[0];
            var dby = db.max[1] - db.min[1];
            var dbz = db.max[2] - db.min[2];
            diag = Math.sqrt(dbx * dbx + dby * dby + dbz * dbz);
        }

        /* 粗配准 / 候选验证 / 正式 ICP 三个阶段按帧推进。
         * 三段都是重计算，同步跑完要几秒，浏览器会直接判定无响应 ——
         * 用户看到的就是"勾上粗配准就卡住"。 */
        var phase = 'icp';
        var coarseNote = '';
        var previewTagRef = null;   // 上一个已预览的粗配准矩阵，避免重复重传
        var coarsePreviewTick = 0;  // 粗配准预览节流计数
        var coarseSolver = null;
        var cands = [];
        var verifyIdx = 0;             // 验证进度（逐帧推进，见 stepVerify）
        var verifyPlan = null;         // 粗筛后的验证名单
        var curProbe = null;
        var verifier = null;           // 候选验证器（在子集上跑）
        var fullKd = null;             // 全量固定点集的 KD 树（主 ICP / 收尾轮共用）
        var lastPreviewAt = 0;         // 上次预览上传的时刻（按时间节流）
        var bestInit = null;
        var bestRms = Infinity;
        /* 粗配准给出的矩阵（可能只是「质心对齐」）。候选被放弃时它就是唯一的
         * 可用初值 —— 之前这种情形回落到单位阵，可两片点云明明相差几米，
         * ICP 一个对应点都找不到（RMS = Infinity、参与点 0），表现为"完全配不上"。 */
        var coarseMat = null;
        var bestSrc = '';              // 最终采用的候选来源（搜索解 / 质心对齐）

        var coarseOn = $('icp-coarse') ? $('icp-coarse').checked : true;

        if (coarseOn && global.MV.super4pcs && global.MV.super4pcs.createRegistration)
        {
            /* 自动粗配准：algo.js 中 Super4PCS 段的官方忠实实现。
             * 参数与 Match4PCSOptions 对应：
             *   sample_size         每侧均匀采样点数
             *   delta               LCP 命中的距离容差（绝对单位）
             *   overlap_estimation  推导 RANSAC 迭代数
             *   terminate_threshold LCP 达到即停
             *   maxTrials           迭代数上限（官方算到 2 万量级，浏览器里截断）
             */
            coarseSolver = global.MV.super4pcs.createRegistration(
                { positions: moving.pos, count: moving.count },
                { positions: fixed.pos, count: fixed.count },
                {
                    /* sample_size 与 delta 必须匹配，这是 4PCS 的硬约束：
                     *   ExtractPairs 的球壳半宽是 2·delta，
                     *   而抽样点在归一化空间里的间距约为 1/√sample_size，
                     *   球壳比间距还薄时就一个点对都找不到（算法空转）。
                     *
                     * delta 曾写死 3.0mm，对 300mm 的工件合适，但换成 844mm 的
                     * 数据集就完全失效（LCP 卡在基准 2.6%，等于没搜）。实测：
                     *   delta=3  → LCP 2.6%（失败）
                     *   delta=10 → LCP 12.4%（失败）
                     *   delta=25 → LCP 63.7% / 80.0%（成功）
                     * 所以按数据尺度给：diag × 0.02（844mm → 16.9mm）。 */
                    sample_size: 2500,
                    delta: Math.max(1, Math.min(60, (diag > 0 ? diag * 0.02 : 3.0))),
                    overlap_estimation: 0.2,
                    /* 0.85 在薄板 / 近似对称件上会被"翻 180° 也贴合 85%"骗停，
                     * 抬到 0.98；真正的裁决交给候选残差验证。 */
                    terminate_threshold: 0.98,
                    /* 一轮尝试约 130~200ms（12k 点对 + 40 次 LCP 打分），30 轮 ≈ 4~7s，
                     * 8s 是硬上限。实测 137°/180° 两个用例 2~8 轮就命中，
                     * 真实一对扫描件跑满 30 轮也能拿到 LCP 0.77（基准 0.26）。 */
                    max_time_seconds: 8,
                    maxTrials: 30,
                    /* 点对上限：每轮点对同时进索引和查询，翻倍开销。
                     *
                     * 1.2 万 → 8 千：2500 点的采样云两两组合约 300 万对，
                     * 取前 1.2 万与 8 千的**覆盖度差异很小**（都是均匀抽样后的子集），
                     * 但单轮耗时从 ~300ms 降到 ~200ms —— 这是配准期间帧冻结的第二大来源。
                     * 实测 137° 用例仍在 2 轮内命中。 */
                    pairLimit: 8000,
                    maxCongruent: 300,
                    batch: 1,
                    preview: true
                });
            phase = 'coarse';
        }

        var solver = null;

        /* 主 ICP 的求解参数 —— **两条路径共用**（Worker / 主线程），
         * 否则同一份数据会因容差不同而收敛到不同的迭代次数与 RMS。 */
        function mainSolveOptions()
        {
            /* 容差下限按数据尺度给：两片点云刚粗对齐时残差常有十几毫米，
             * 用户默认的 10mm 会让参与点只剩几十个（实测 6478 → 43），
             * RMS 看着不小，其实是"点太少"。 */
            var effMaxDist = Math.max(maxDist, diag > 0 ? diag * 0.025 : maxDist);

            /* 只做"兜底放宽"，不做"随残差等比放大"。
             * 等比放大（试过 ×2.5）在初值本来就在容差内时反而有害：
             * 残差 5.5 被放大成 13.7，ICP 递减从 41 起步，
             * 大量错配参与求解，把好好的初值拉坏到 RMS 13.6。 */
            if (bestInit && isFinite(bestRms) && bestRms > maxDist && maxDist > 0)
            {
                effMaxDist = bestRms * 1.5;
            }

            /* 初值残差远小于容差时把容差收紧：上面那句 `max(maxDist, diag*0.025)`
             * 是为"刚粗对齐、残差十几毫米"兜底的，对"主轴假设给出 0.27mm"这种
             * 好初值就成了 21mm 的宽松门 —— 实测会把首轮 RMS 从 0.35 拉到 9.6。 */
            var trimBoost = 2;
            if (bestInit && isFinite(bestRms) && bestRms > 0 && effMaxDist > 0 &&
                bestRms < effMaxDist * 0.3)
            {
                effMaxDist = Math.max(bestRms * 3, diag > 0 ? diag * 0.0015 : bestRms * 3);
                trimBoost = 0.5;
            }

            /* 初值兜底链：验证通过的候选 → 粗配准矩阵（含质心对齐）→ 单位阵。
             *
             * 曾经在这里加过 peekXformMat()（拿矩阵框当前值当初值），那是错的：
             * 矩阵框记录的是「已经烘焙进数据的变换」，数据里早就含有它 ——
             * 再拿它当初值等于把同一个刚体变换又乘一遍，表现就是
             * 「N-N 应用后不勾 4PCS，配准直接失败」。 */
            return {
                maxIter: maxIter,
                sampleRatio: sampleRatio,
                normalThresh: thresh,
                tol: tol,
                maxDist: effMaxDist,
                trimBoost: trimBoost,
                /* 没有粗配准结果时用"当前位姿"当初值：
                 * 第一轮从零开始，第二轮起点就是第一轮的解 —— 重复点击得到零增量，
                 * 而不是重新收敛到另一个局部最优。 */
                initMat: bestInit || coarseMat || srcPose
            };
        }

        /* 创建正式 ICP 求解器（主线程路径；Worker 路径用 mainSolveOptions 直接发参数） */
        function buildMainSolver()
        {
            var opts = mainSolveOptions();

            /* 全量 KD 只建一次：主 ICP 与两轮收尾用的都是同一份 fixed.pos。
             * Worker 路径那边由 Worker 自己缓存，这里保留给同步路径。 */
            if (!fullKd && global.MV.kdtree && global.MV.kdtree.build)
            {
                fullKd = global.MV.kdtree.build(fixed.pos);
            }
            opts.kd = fullKd;

            /* 同步兜底路径：主线程这里仍需法向（Worker 路径由 normalsOf 负责）。 */
            var mNrm = moving.nrm;
            var fNrm = fixed.nrm;
            if (!mNrm && moving.positions && global.MV.icp.computeVertexNormals)
            {
                mNrm = global.MV.icp.computeVertexNormals(
                    moving.positions, moving.remap || null, moving.vertCount || null).normals;
            }
            if (!fNrm && fixed.positions && global.MV.icp.computeVertexNormals)
            {
                fNrm = global.MV.icp.computeVertexNormals(
                    fixed.positions, fixed.remap || null, fixed.vertCount || null).normals;
            }
            return global.MV.icp.createSolver(moving.pos, mNrm, fixed.pos, fNrm, opts);
        }

        /* 启动主 ICP —— **唯一入口**，两个调用点（未勾 4PCS 的初始化、stepVerify 收尾）
         * 都走这里，避免"一处走 Worker、另一处仍同步建求解器"。
         *
         * 返回 true 表示已经异步接管（后面不要再 settimeout tick）；
         * 返回 false 表示主线程已备好 solver，继续按帧推进。 */
        function bootMainIcp()
        {
            if (getIcpWorker())
            {
                if (!tCoarseEnd) { tCoarseEnd = nowMs(); }
                startWorkerIcp();
                return true;
            }

            try
            {
                solver = buildMainSolver();
            }
            catch (e)
            {
                if (info) { info.textContent = '出错：' + e.message; }
                xformInfo('ICP 出错：' + e.message, true);
                finishIcpRun();
                return true;
            }

            if (!solver)
            {
                if (info) { info.textContent = '配准失败：数据不足'; }
                xformInfo('ICP 失败', true);
                finishIcpRun();
                return true;
            }

            if (!tCoarseEnd) { tCoarseEnd = nowMs(); }
            return false;
        }

        if (info)
        {
            info.textContent = (phase === 'coarse') ? '准备粗配准…' : '开始…';
        }
        setInfo(phase === 'coarse' ? '自动粗配准中…' : 'ICP 计算中…');

        /* 配准必须基于「已提交」的数据：
         * 若此前有矩阵预览（数据已被临时改写）或残留的 previewMat，
         * 先还原，否则求解用的点集与最终显示会对不上。 */
        var hadPreview = !!previewBackup;
        clearPreview();

        icpRunSeq++;
        var myRun = icpRunSeq;
        icpRunning = true;
        setIcpRunningUi(true);

        var t0 = Date.now();
        /* 另起一个 performance 时钟：粗配准与迭代分开计时，dt 仍用原来的 Date.now */
        var tRun = nowMs();
        var tCoarseEnd = 0;
        var refineCount = 0;           // 已做过的「收紧容差」收尾轮数（最多 2 轮）

        /* 未勾粗配准：进函数时 phase 就是 'icp'，这里直接启动求解。
         *
         * ⚠ 必须放在 icpRunning / icpRunSeq / refineCount 都就位之后。
         * 曾经放在上面（第一次 `if (phase === 'icp')` 处），后果是：
         *   1) icpRunning 还是 false —— 按钮不变「终止」，Esc 也停不掉，
         *      用户再点一次就是第二次启动；
         *   2) myRun 还是上一轮的值，Worker 回传的每个 step 都被
         *      `myRun !== icpRunSeq` 挡掉 —— 整个配准静默地什么都不做。
         * 勾了 4PCS 时 phase 先是 'coarse'，不会走到这里，
         * 真正的入口在 stepVerify 结尾。 */
        if (phase === 'icp')
        {
            if (bootMainIcp()) { return; }
        }

        /* ICP 迭代走 Worker（粗配准 / 候选验证仍在主线程，它们单块已压到 75~200ms）。
         * 注意：这里**不能**提前判断 —— 勾了 4PCS 时 phase 先是 'coarse'，
         * 真正的入口在 stepVerify 结尾（phase 变 'icp' 处），由 bootMainIcp() 统一决定。 */

        // 每帧只跑一轮，并用 rAF 调度：这样每一次迭代都会渲染一帧，
        // 能看到数据逐步收敛的过程。用 setTimeout 的话几十轮会在几毫秒内
        // 全部跑完，画面只会闪一两下。
        /* 三个阶段各自成函数：原来它们依次嵌在 tick 里，
         * 加上参数准备与结果处理，整个 icpRun 有 432 行 ——
         * 任何一处改动都得重新理解全貌。
         * 仍留在 icpRun 内部是为了共用闭包状态（solver / cands / phase…），
         * 改成对象字段反而要传一堆参数，更容易出错。 */

        var coarseQuickDone = false;   // 快速通道只判一次
        var coarseSkipped = false;     // 是否因"原始位姿已对齐"跳过了搜索
        var coarseBaseLcp = 0;         // 快速通道用到的基准 LCP（step() 不返回它）

        function stepCoarse()
        {
            /* 快速通道：原始位姿（质心对齐）的覆盖率已经很高时，不必再全局搜索。
             *
             * 典型场景就是用户自己先做 N-N / 矩阵对齐，然后忘了取消「自动粗配准」：
             * 搜索要空跑几秒才有结论，而结论注定是"没有候选能超过基准"。
             * 判据用 0.9：源点九成都落在目标表面 delta 内，已经是"对齐"状态；
             * 万一这是薄板翻面的伪高 LCP，后面的主轴假设 + 残差验证仍然会跑，
             * 所以跳过搜索不会把好位姿换成坏位姿（实测 RMS 0.0477 → 0.0478）。 */
            if (!coarseQuickDone)
            {
                coarseQuickDone = true;

                var pre = null;
                try { pre = coarseSolver.result(); } catch (e0) { pre = null; }

                if (pre && pre.baselineLcp >= 0.9)
                {
                    coarseSolver.cancel();
                    coarseSkipped = true;
                    coarseBaseLcp = pre.baselineLcp;
                }
            }

            var cs = coarseSolver.step();

            /* 预览降频到每 4 步一次。
             *
             * 预览本身很便宜（`setGpuPreview` 只写一个 uniform，数据不动），
             * 但它会触发一次整帧重绘 —— 这一帧要画 80 多万个点，才是真正的开销。
             * 每步都重绘会把渲染线程压满，连拖视角都发涩；每 4 步一次
             * 视觉上仍是连续变化，且不拖慢计算。 */
            if (target && cs.matrix)
            {
                /* 每步返回的 matrix 都是新数组，用 !== 比引用恒为真，
                 * 节流等于没生效。改成按数值比。 */
                var sameAsLast = false;
                var csNow = toDelta(cs.matrix);

                if (previewTagRef)
                {
                    var mdiff = 0;
                    for (var mi2 = 0; mi2 < 16; mi2++)
                    {
                        mdiff += Math.abs(csNow[mi2] - previewTagRef[mi2]);
                    }
                    sameAsLast = (mdiff < 1e-9);
                }

                if ((cs.done || (coarsePreviewTick % 4) === 0) && !sameAsLast)
                {
                    previewTagRef = new Float64Array(csNow);
                    setGpuPreview(target, csNow);
                }
                coarsePreviewTick++;
            }

            if (info)
            {
                info.textContent = coarseSkipped
                    ? ('原始位姿已对齐（LCP ' + Math.round(coarseBaseLcp * 100) +
                       '%），跳过全局搜索，准备验证候选…')
                    : ('粗配准 ' + Math.round(cs.progress * 100) + '%' +
                       '   尝试 ' + cs.trial + '/' + cs.trials +
                       '   LCP ' + (cs.lcp * 100).toFixed(0) + '%');
            }

            if (!cs.done) { nextIteration(tick, 0); return; }

            var cr = coarseSolver.result();
            coarseSolver = null;
            coarseMat = (cr && cr.matrix) ? cr.matrix : null;
            phase = 'verify';

            /* 基准比较在 super4pcs 内部就完成了：
             * 初始 bestLCP = 单位阵在下采样点上的覆盖率，
             * 任何候选必须【严格超过】它才会被采纳，
             * 所以 usedBaseline 为真时返回的就是"原始位姿"。
             *
             * 这里不再加绝对阈值（原来那个 rejectLcp=0.10）——
             * 那个会把"比原始位姿好、但绝对值不高"的解也丢掉，
             * 与"不如原始位姿才退回"的要求相反。 */
            function pct(v) { return (v * 100).toFixed(0) + '%'; }

            if (!cr || !cr.matrix)
            {
                coarseNote = '\n粗配准未得到解，使用单位阵';
                cands = [];
                bestInit = null;
            }
            else
            {
                /* 候选集里同时放「搜索解」和「质心对齐」。
                 *
                 * 只信搜索解会踩对称件的坑：实测 844mm 的数据集里，
                 * 4PCS 找过一个 LCP 48% 的候选，ICP 从它出发 RMS 反而是 21.4mm，
                 * 而从质心对齐出发只有 3.4mm。谁更好不能看 LCP，要看 ICP 残差 ——
                 * 所以两个都当候选，交给下面 verify 阶段用残差择优。 */
                cands = [];

                if (!cr.usedBaseline && cr.matrix)
                {
                    cands.push({ mat: cr.matrix, score: cr.lcp, src: '搜索解' });
                }

                if (cr.baselineMatrix)
                {
                    var dup = false;
                    if (cands.length)
                    {
                        var dd2 = 0;
                        for (var dk = 0; dk < 16; dk++)
                        {
                            dd2 += Math.abs(cands[0].mat[dk] - cr.baselineMatrix[dk]);
                        }
                        dup = (dd2 < 1e-9);
                    }
                    if (!dup) { cands.push({ mat: cr.baselineMatrix, score: cr.lcp, src: '质心对齐' }); }
                }

                /* 第三类候选：主轴（PCA）多假设。
                 *
                 * 4PCS 终究是"随机采样共面 4 点 + 离散匹配"的搜索，姿态差越大
                 * 越吃粒度；而同一零件的两次测量、CAD 与实测，主轴是稳定可用的。
                 * 两侧主轴对齐只有 24 种真旋转，一次 PCA 全给出来，
                 * 交给廉价粗筛 + 残差验证挑选即可。 */
                if (global.MV.icp.pcaCandidates)
                {
                    var pca = null;
                    try
                    {
                        pca = global.MV.icp.pcaCandidates(moving.pos, moving.count,
                                                          fixed.pos, fixed.count, {});
                    }
                    catch (e1) { pca = null; }

                    if (pca && pca.mats)
                    {
                        for (var pi2 = 0; pi2 < pca.mats.length; pi2++)
                        {
                            cands.push({ mat: pca.mats[pi2], score: 0, src: '主轴假设', pca: true });
                        }
                    }
                }

                if (cands.length)
                {
                    coarseNote = coarseSkipped
                        ? ('\n原始位姿已对齐（LCP ' + pct(cr.baselineLcp) +
                           '），跳过全局搜索 · ' + cands.length + ' 个候选待验证')
                        : ('\n粗配准 ' + pct(cr.lcp) +
                           '（基准 ' + pct(cr.baselineLcp) + '，' +
                           cr.trial + '/' + cr.trials + ' 次尝试）· ' +
                           cands.length + ' 个候选待验证');
                }
                else
                {
                    coarseNote = '\n粗配准未得到可用位姿';
                    bestInit = null;
                }
            }


            /* 粗配准结束：让预览与接下来的判定保持一致。
             * 走「采用候选」的分支时先把结果贴上去（否则要等 verify 第一帧才动，
             * 中间会闪一下原姿势）；走「放弃」分支时明确回到原始位置，
             * 免得先动一下又弹回，看起来像自己抖了一下。 */
            if (target)
            {
                if (cands.length > 0 && cr && cr.matrix)
                {
                    setGpuPreview(target, toDelta(cr.matrix));
                    previewTagRef = new Float64Array(toDelta(cr.matrix));
                }
                else
                {
                    clearGpuPreview(target);
                }
            }

            if (target && cands.length === 0)
            {
                setInfo('粗配准未找到更优位姿，数据保持原位（继续精配准）', false, 'warn');
            }

            nextIteration(tick, 0);
            return;
        }

        function stepVerify()
        {
            /* 验证仍然要迭代（初始残差排不出对错，见 createVerifier 的注释），
             * 但只在 8000 / 20000 的子集上做：
             *   旧路径 = 2 候选 × 12 轮 × min(1, ratio×2)×nSrc（46 万点约 40 万/轮）
             *            ≈ 近千万次最近邻 + 2 次 36 万点 KD 重建
             *   新路径 = 1 次 2 万点 KD + 2 × 12 × 8000 ≈ 19 万次查询
             * 排序与全量一致（实测 19.62/3.44 vs 20.06/3.39）。 */
            if (!verifier)
            {
                verifier = global.MV.icp.createVerifier(
                    moving.pos, moving.nrm, fixed.pos, fixed.nrm,
                    {
                        /* 验证规模：8000 点 / 12 轮 → 4000 点 / 8 轮。
                         *
                         * 验证器只用来**排序**候选（谁的残差更小），不产出最终位姿，
                         * 所以几千点足够区分；而它单次打分实测占了配准期间最大的一次
                         * 帧冻结（1050ms，含首次 JIT 预热）。
                         * 减半后单次约 500ms，排序结论不变（后续主 ICP 仍用全量数据）。 */
                        maxSrc: 4000,
                        maxDst: 20000,
                        iters: 8,
                        normalThresh: thresh,
                        tol: tol,
                        maxDist: Math.max(maxDist, diag > 0 ? diag * 0.025 : maxDist),
                        /* 粗筛容差：与 4PCS 的 delta 同量级（对角线 2%）。
                         * 候选有二十几个（主轴 24 个）时，全跑 12 轮 ICP 要好几秒，
                         * 先用"落在容差内的比例"排一次序，只让前几个进完整验证。 */
                        screenTol: diag > 0 ? diag * 0.02 : Math.max(maxDist, 1),
                        maxScreenSrc: 1500
                    });
            }

            /* 第一拍只负责定名单（粗筛），之后每拍验证一个候选。
             * 5 个候选挤在一拍里要阻塞主线程 1~2 秒（每候选 12 轮 × 8000 点），
             * 分帧后进度条真的在动，也不会被浏览器判成无响应。 */
            if (!verifyPlan)
            {
                verifyPlan = cands || [];
                verifyIdx = 0;

                if (verifyPlan.length > 6 && verifier && verifier.screen)
                {
                    for (var si2 = 0; si2 < verifyPlan.length; si2++)
                    {
                        var sn = verifier.screen(verifyPlan[si2].mat);
                        verifyPlan[si2].hit = sn.hit;
                        verifyPlan[si2].med = sn.med;
                    }

                    verifyPlan.sort(function (a, b) { return (b.hit || 0) - (a.hit || 0); });
                    verifyPlan = verifyPlan.slice(0, 5);

                    /* 「质心对齐」永远留在验证名单里：数据本来就大致对齐
                     * （或用户刚用 N-N 对过）时它才是最稳的初值；
                     * 二十几个主轴假设里总有几个在"薄板翻面"上命中率虚高，
                     * 只按命中率截前 5 有可能把基准挤出去，反而把好位姿换掉。 */
                    var keptBase = false;
                    for (var ki2 = 0; ki2 < verifyPlan.length; ki2++)
                    {
                        if (verifyPlan[ki2].src === '质心对齐') { keptBase = true; break; }
                    }

                    if (!keptBase)
                    {
                        for (var kb2 = 0; kb2 < cands.length; kb2++)
                        {
                            if (cands[kb2].src === '质心对齐')
                            {
                                verifyPlan[verifyPlan.length - 1] = cands[kb2];
                                break;
                            }
                        }
                    }

                    if (info)
                    {
                        /* 快速通道只在 stepCoarse 里设一次文案，紧接着就被这一句覆盖 ——
                         * 用户看不到"为什么没搜索"。这里带上那句话。 */
                        info.textContent = (coarseSkipped
                                ? ('原始位姿已对齐（LCP ' + Math.round(coarseBaseLcp * 100) +
                                   '%），跳过全局搜索 · ')
                                : '') +
                            '粗筛 ' + cands.length + ' 个候选，取命中率前 ' +
                            verifyPlan.length + ' 个（含质心对齐）做残差验证…';
                    }
                }
            }

            if (verifier && verifyPlan && verifyIdx < verifyPlan.length)
            {
                var cvi = verifyPlan[verifyIdx];
                var sc = verifier.score(cvi.mat);
                cvi.rms = sc.rms;

                if (info)
                {
                    info.textContent = '验证候选 ' + (verifyIdx + 1) + '/' + verifyPlan.length +
                        '   ' + (cvi.src || '') +
                        '   残差 ' + (isFinite(sc.rms) ? sc.rms.toFixed(2) + 'mm' : '无效');
                }

                if (isFinite(sc.rms) && sc.used >= 200 && sc.rms < bestRms)
                {
                    bestRms = sc.rms;
                    bestInit = cvi.mat;
                    bestSrc = cvi.src || '';
                }

                verifyIdx++;

                if (verifyIdx < verifyPlan.length)
                {
                    nextIteration(tick, 0);
                    return;
                }
            }

            phase = 'icp';

            /* 先算出「采用了哪个候选」的说明：Worker 路径也要用它拼结果文案 */
            if (bestInit)
            {
                coarseNote = '\n粗配准 ' + cands.length + ' 个候选，采用「' +
                             (bestSrc || '搜索解') + '」，残差 ' +
                             bestRms.toFixed(2) + 'mm，已作为 ICP 初始位姿' +
                             /* 这里原本会把早前那句"跳过全局搜索"整段覆盖掉，
                              * 于是已对齐的场景看起来像"搜索跑了但没找到" */
                             (coarseSkipped ? '（原始位姿已对齐，全局搜索已跳过）' : '');
            }
            else if (coarseSkipped)
            {
                coarseNote = '\n原始位姿已对齐，全局搜索已跳过；候选残差都不优于原状，保持不动';
            }

            if (info)
            {
                info.textContent = '开始精配准…' + (hadPreview ? '（已先撤销未应用的矩阵预览）' : '');
            }

            /* Worker 可用时这里直接异步接管；否则主线程已建好 solver，继续按帧推进 */
            if (bootMainIcp()) { return; }

            nextIteration(tick);
            return;

        }

        function stepIcp()
        {
        /* 第一次进这里说明粗配准（含候选验证）已经结束 */
        if (!tCoarseEnd) { tCoarseEnd = nowMs(); }

        /* 每次只扫一片。partial = true 表示「这一轮还没扫完」，
         * 不是迭代结束 —— 不更新预览、不改 iters，直接让出主线程继续。 */
        var r = solver.step(ICP_SLICE);

        if (r.partial)
        {
            nextIteration(tick, 0);      // 0 = 不等，尽快续下一片
            return;
        }

        /* 预览按时间节流（约 10 fps）。
         *
         * applyPreviewMat 不是"改个矩阵"那么简单：它要把 46 万点全量还原、
         * 再逐点变换、再重传 GPU buffer（约 5MB）。每轮迭代都做一次的话，
         * ICP 本身的计算反而被上传淹没 —— 用户看到的就是"配准时帧率很低"。
         * 收敛结果与预览频率无关，降频只影响观感。 */
        /* GPU 预览只是一次 uniform 写入，不再需要节流：每轮都能看到位姿变化，
         * 而 CPU 侧一次顶点拷贝 / 上传都不做。 */
        if (target)
        {
            setGpuPreview(target, toDelta(solver.result().mat));
        }

        if (!r.done)
        {
            if (info)
            {
                info.textContent = '迭代 ' + r.iters + ' / ' + maxIter +
                    '   RMS ' + r.rms.toFixed(4) + '   点 ' + r.used;
            }
            nextIteration(tick);
            return;
        }

        var res = solver.result();
        var dt = Date.now() - t0;

        // 发散保护：残差超过数据尺度的一半，说明没配上。
        // 这时矩阵里的平移可能已经累积到极大值，直接套用会把数据
        // 甩出视野（看起来像"目标消失了"），所以宁可还原也不填。
        var diverged = !isFinite(res.rms) || (diag > 0 && res.rms > diag * 0.5);

        if (diverged)
        {
            clearGpuPreview(target);

            if (info)
            {
                info.textContent = '配准未收敛：迭代 ' + res.iters + ' 次后 RMS = ' +
                    res.rms.toFixed(2) + '（数据尺度 ' + diag.toFixed(1) + '）\n' +
                    '已放弃该结果，数据保持原位。可尝试：调低「采样」数值、\n' +
                    '调大「迭代」，或先用 N-N 配准给一个接近的初值。';
            }
            finishIcpRun();
            xformInfo('配准未收敛，已放弃结果（数据未被移动）', true);
            setInfo('ICP 未收敛（RMS ' + res.rms.toFixed(2) + '）', false, 'fail');
            logTiming('ICP 配准（未收敛）', dt, '迭代 ' + res.iters + ' 次');
            return;
        }

        /* 收尾轮：第一轮 ICP 用的是「容纳粗配准残差」的大容差，
         * 参与点够多但 RMS 仍偏大时，收紧容差再跑一轮能显著降误差
         * （实测 844mm 的数据集：3.39 → 1.50 → 0.56 mm）。
         * 只在结果非发散、参与点足够时才做，避免把噪声当信号。 */
        if (refineCount < 2 && isFinite(res.rms) && res.used >= 500 &&
            diag > 0 && res.rms > diag * 0.001)
        {
            refineCount++;

            var tightDist = Math.max(1, diag * (refineCount === 1 ? 0.008 : 0.003));

            var rs = null;
            try
            {
                rs = global.MV.icp.createSolver(moving.pos, moving.nrm, fixed.pos, fixed.nrm,
                    {
                        maxIter: 20,
                        sampleRatio: sampleRatio,
                        normalThresh: thresh,
                        tol: tol,
                        maxDist: tightDist,
                        /* 收尾轮就是要"只保留贴合的对应点"，不能再放大容差 */
                        trimBoost: 0,
                        initMat: res.mat,
                        kd: fullKd
                    });
            }
            catch (e4) { rs = null; }

            if (rs)
            {
                solver = rs;
                if (info)
                {
                    info.textContent = '容差收紧到 ' + tightDist.toFixed(1) + ' mm，收尾迭代…';
                }
                nextIteration(tick);
                return;
            }
        }

        /* 收敛后**直接烘焙进数据**，不只挂预览 / 矩阵框。
         *
         * 挂预览会留下三个坑：`data.bbox` 还是旧的（fitAll / 剔除 / 统计全不对）；
         * 任何一次 applyPreview 把框重置成单位阵，预览就没了、目标瞬间弹回几米外；
         * 用户还得记得再点一次「应用」，忘了就等于白跑。
         * 会话内还可以用属性面板的「逆变换」退回，所以不算破坏性操作。 */
        /* 本次增量是否≈单位阵（已对齐状态下再跑一次，它必然是单位阵）。
         *
         * 这里先算、再决定要不要烘焙：增量≈单位阵时烘焙是**纯开销** ——
         * 台账里多一条 "ICP 精配准 R 0.00° T (0,0,0)"、数据被逐点变换一遍、
         * GPU 全量重传一次，而结果与不动完全等价。 */
        /* 求解器给的是绝对位姿（原始 → 世界），落地要用相对当前位姿的增量：
         *   delta = T_abs · inv(srcPose)
         * 判"是否几乎没动"也必须看 delta —— 看绝对值时，第二次运行 T_abs 仍是
         * 一个大旋转，会被误判成"动了很多"。 */
        var deltaMat = res.mat ? mat4Mul(res.mat, mat4Invert(srcPose)) : null;

        var movedRot = 0, movedLen = 0;
        if (deltaMat)
        {
            var trm = deltaMat[0] + deltaMat[5] + deltaMat[10];
            movedRot = Math.acos(Math.max(-1, Math.min(1, (trm - 1) / 2))) * 180 / Math.PI;
            movedLen = Math.sqrt(deltaMat[3] * deltaMat[3] +
                                 deltaMat[7] * deltaMat[7] +
                                 deltaMat[11] * deltaMat[11]);
        }
        var stayed = (movedRot < 0.05 && movedLen < 0.01);

        var baked;
        if (stayed)
        {
            /* 不动数据，但要把预览清干净 —— 否则渲染层还乘着最后那个候选矩阵 */
            clearGpuPreview(dstLay);
            clearPreview();
            baked = true;
        }
        else
        {
            /* 走护栏：只有确实更贴近目标才落地（连续点击不会累积漂移） */
            baked = applyXformToLayer(deltaMat, 'ICP 精配准', dstLay);
        }

        /* 烘焙后**自动选中目标层**。
         * 属性面板的「变换」行显示的是【选中图层】，而 ICP 之前不改选中 ——
         * 于是出现"目标层刚被烘焙了 92°，面板却显示 0.0°"，
         * 看起来就像"页面上显示的和算法内部不是同一个矩阵"。 */
        if (baked && app.selectLayer) { app.selectLayer(dstLay.id); }

        var txt = '迭代 ' + res.iters + ' 次' + (refineCount ? '（含 ' + refineCount + ' 轮收紧容差）' : '') +
                  '，RMS = ' + res.rms.toFixed(4) +
                  '\n参与点 ' + res.used + '，' +
                  (res.hasNormals ? '法向已启用（对称目标）' : '无法向，退化为点到点') +
                  '\n耗时 ' + dt + ' ms' + sampleNote + coarseNote;
        if (info) { info.textContent = txt; }

        xformInfo('ICP 完成：RMS = ' + res.rms.toFixed(4) +
            '\n' + (baked
                ? (stayed
                    ? ('「' + dstLay.name + '」已在原位：本次增量≈单位阵（没有重复施加），' +
                       '累计变换见属性面板「变换」')
                    : ('已把增量 ' + xformBrief(res.mat, 2, 2) + ' 烘焙到「' + dstLay.name + '」'))
                : ('未能自动应用，请点「应用」把矩阵作用到「' + dstLay.name + '」')), res.rms > 1);
        setInfo('ICP 完成（RMS ' + res.rms.toFixed(4) + '，' + res.iters + ' 次迭代）');
        var coarseMs = tCoarseEnd ? (tCoarseEnd - tRun) : 0;
        var iterMs = tCoarseEnd ? (nowMs() - tCoarseEnd) : 0;
        var stageNote = '迭代 ' + res.iters + ' 次 · RMS ' + res.rms.toFixed(4);
        if (coarseMs > 0) { stageNote += ' · 粗配准 ' + fmtDur(coarseMs) + ' / 迭代 ' + fmtDur(iterMs); }
        logTiming('ICP 配准', dt, stageNote);
        finishIcpRun();
        }

        function tick()
        {
            /* 编号变了 = 已被终止（或已开始新的一次运行） */
            if (myRun !== icpRunSeq) { return; }

            if (phase === 'coarse') { stepCoarse(); return; }
            if (phase === 'verify') { stepVerify(); return; }
            stepIcp();
        }

        /* ---------------- Worker 路径（与上面同步路径等价） ---------------- */

        function onWorkerStep(m)
        {
            if (myRun !== icpRunSeq) { return; }

            /* 预览只写一个 uniform：数据不动、不上传顶点 */
            if (target && m.mat) { setGpuPreview(target, toDelta(m.mat)); }

            if (info && !m.done)
            {
                info.textContent = '迭代 ' + m.iters + ' 次   RMS ' +
                    (isFinite(m.rms) ? m.rms.toFixed(4) : '—') + '   点 ' + m.used;
            }
        }

        var workerFellBack = false;

        function workerFail(err)
        {
            if (myRun !== icpRunSeq) { return; }

            /* Worker 挂了（脚本加载失败 / 超时）：退回主线程继续算。
             * 用户只是慢一点，而不是「点了完全没反应」。
             * 只在还没有任何结果时回退，避免重复烘焙。 */
            if (icpWorkerBroken && !workerFellBack)
            {
                workerFellBack = true;
                try { solver = buildMainSolver(); } catch (e3) { solver = null; }
                if (solver)
                {
                    if (info) { info.textContent = '计算线程不可用，改在主线程配准…'; }
                    setInfo('计算线程不可用，已回退到主线程配准', false, 'warn');
                    nextIteration(tick, 0);
                    return;
                }
            }

            clearGpuPreview(dstLay);
            if (info) { info.textContent = '配准失败：' + ((err && err.message) || err); }
            xformInfo('ICP 失败：' + ((err && err.message) || err), true);
            finishIcpRun();
        }

        function startWorkerIcp()
        {
            if (info) { info.textContent = '准备精配准…'; }

            icpWorkerCall({ cmd: 'init', fixed: { pos: fixed.pos, nrm: fixed.nrm } })
                .then(function ()
                {
                    if (myRun !== icpRunSeq) { return null; }
                    if (!tCoarseEnd) { tCoarseEnd = nowMs(); }

                    return icpWorkerCall({
                        cmd: 'solve',
                        moving: { pos: moving.pos, nrm: moving.nrm },
                        /* 与主线程路径同一份参数（含"好初值收紧容差"那段决策），
                         * 否则两条路径的迭代次数与 RMS 会对不上 */
                        opts: mainSolveOptions()
                    }, onWorkerStep);
                })
                .then(function (res)
                {
                    if (!res || myRun !== icpRunSeq) { return; }
                    return afterWorkerSolve(res);
                })
                .catch(function (err) { workerFail(err); });
        }

        function afterWorkerSolve(res)
        {
            var dt = Date.now() - t0;
            var diverged = !isFinite(res.rms) || (diag > 0 && res.rms > diag * 0.5);

            if (diverged)
            {
                clearGpuPreview(target || dstLay);
                if (info)
                {
                    info.textContent = '配准未收敛：迭代 ' + res.iters + ' 次后 RMS = ' +
                        res.rms.toFixed(2) + '（数据尺度 ' + diag.toFixed(1) + '）\n' +
                        '已放弃该结果，数据保持原位。可尝试：调低「采样」数值、\n' +
                        '调大「迭代」，或先用 N-N 配准给一个接近的初值。';
                }
                finishIcpRun();
                xformInfo('配准未收敛，已放弃结果（数据未被移动）', true);
                setInfo('ICP 未收敛（RMS ' + res.rms.toFixed(2) + '）', false, 'fail');
                logTiming('ICP 配准（未收敛）', dt, '迭代 ' + res.iters + ' 次');
                return;
            }

            /* 收尾轮：收紧容差再跑一轮，仍然交给 Worker */
            if (refineCount < 2 && isFinite(res.rms) && res.used >= 500 &&
                diag > 0 && res.rms > diag * 0.001)
            {
                refineCount++;
                var tightDist = Math.max(1, diag * (refineCount === 1 ? 0.008 : 0.003));

                if (info)
                {
                    info.textContent = '容差收紧到 ' + tightDist.toFixed(1) + ' mm，收尾迭代…';
                }

                return icpWorkerCall({
                    cmd: 'solve',
                    moving: { pos: moving.pos, nrm: moving.nrm },
                    opts: {
                        maxIter: 20,
                        sampleRatio: sampleRatio,
                        normalThresh: thresh,
                        tol: tol,
                        maxDist: tightDist,
                        trimBoost: 0,
                        initMat: res.mat
                    }
                }, onWorkerStep)
                .then(function (r2)
                {
                    if (myRun !== icpRunSeq) { return null; }
                    return afterWorkerSolve(r2);
                });
            }

            /* 收敛：与同步路径完全相同的烘焙逻辑 */
            /* 同主线程：绝对位姿 → 增量，再判是否几乎没动 */
            var deltaMat = res.mat ? mat4Mul(res.mat, mat4Invert(srcPose)) : null;

            var movedRot = 0, movedLen = 0;
            if (deltaMat)
            {
                var trm = deltaMat[0] + deltaMat[5] + deltaMat[10];
                movedRot = Math.acos(Math.max(-1, Math.min(1, (trm - 1) / 2))) * 180 / Math.PI;
                movedLen = Math.sqrt(deltaMat[3] * deltaMat[3] +
                                     deltaMat[7] * deltaMat[7] +
                                     deltaMat[11] * deltaMat[11]);
            }
            var stayed = (movedRot < 0.05 && movedLen < 0.01);

            var baked;
            if (stayed)
            {
                clearGpuPreview(dstLay);
                clearPreview();
                baked = true;
            }
            else
            {
                /* 走护栏：只有确实更贴近目标才落地（连续点击不会累积漂移） */
            baked = applyXformToLayer(deltaMat, 'ICP 精配准', dstLay);
            }

            if (baked && app.selectLayer) { app.selectLayer(dstLay.id); }

            var txt = '迭代 ' + res.iters + ' 次' +
                      (refineCount ? '（含 ' + refineCount + ' 轮收紧容差）' : '') +
                      '，RMS = ' + res.rms.toFixed(4) +
                      '\n参与点 ' + res.used + '，' +
                      (res.hasNormals ? '法向已启用（对称目标）' : '无法向，退化为点到点') +
                      '\n耗时 ' + dt + ' ms' + sampleNote + coarseNote;
            if (info) { info.textContent = txt; }

            xformInfo('ICP 完成：RMS = ' + res.rms.toFixed(4) +
                '\n' + (baked
                    ? (stayed
                        ? ('「' + dstLay.name + '」已在原位：本次增量≈单位阵（没有重复施加），' +
                           '累计变换见属性面板「变换」')
                        : ('已把增量 ' + xformBrief(res.mat, 2, 2) + ' 烘焙到「' + dstLay.name + '」'))
                    : ('未能自动应用，请点「应用」把矩阵作用到「' + dstLay.name + '」')), res.rms > 1);

            setInfo('ICP 完成（RMS ' + res.rms.toFixed(4) + '，' + res.iters + ' 次迭代）');

            var coarseMs = tCoarseEnd ? (tCoarseEnd - tRun) : 0;
            var iterMs = tCoarseEnd ? (nowMs() - tCoarseEnd) : 0;
            var stageNote = '迭代 ' + res.iters + ' 次 · RMS ' + res.rms.toFixed(4) + ' · Worker';
            if (coarseMs > 0) { stageNote += ' · 粗配准 ' + fmtDur(coarseMs) + ' / 迭代 ' + fmtDur(iterMs); }
            logTiming('ICP 配准', dt, stageNote);
            finishIcpRun();
        }

        /* 到这里说明主线程路径已备好 solver（Worker 路径在 bootMainIcp 里就 return 了） */
        setTimeout(tick, 30);
    }

    /* 旋转对称检查的候选角度；轴在运行时按参考数据的 PCA 主轴确定，
     * 这样工件斜放时也能沿它自身的惯量轴去检查。 */

    /* 世界坐标轴。曾用 PCA 主轴，但 axes 按方差降序、符号也不定，
     * 叫「绕X」时实际可能是绕 Z，结论无法解释；固定用世界轴后名实相符。
     * 需要沿工件自身惯量轴检查时，先把数据摆正再跑。 */
    function bindXform()
    {
        buildXformGrid();

        // 编辑矩阵即时预览
        if (xformInputs)
        {
            for (var pi = 0; pi < 16; pi++)
            {
                xformInputs[pi].addEventListener('input', function ()
                {
                    applyPreview();
                    refreshApplyState();
                });
            }
        }

        var pv = $('xform-preview-on');
        if (pv) { pv.addEventListener('change', applyPreview); }

        bindDialogDrag();

        /* 面板现在常驻侧栏：用户可能直接点标签而不走「工具 → 变换」，
         * 那条路径不会调用 regFillSelects / icpFillSelects，
         * 结果下拉框是空的、选不到图层。这里给标签补一次。 */
        var sideTabsX = document.querySelectorAll('#sidebar .panel-tabs .tab[data-tab]');
        for (var xi = 0; xi < sideTabsX.length; xi++)
        {
            if (sideTabsX[xi].getAttribute('data-tab') !== 'xform') { continue; }

            (function (tabEl)
            {
                tabEl.addEventListener('click', function ()
                {
                    regFillSelects();
                    icpFillSelects();
                    refreshXformTargetLabel();
                });
            })(sideTabsX[xi]);
            break;
        }

        // 首次进入页面也先填一次，避免面板已显示但下拉是空的
        regFillSelects();
        icpFillSelects();

        // 目标层下拉联动，改任一个另一个跟随，并即时刷新预览
        var iSel2 = $('icp-dst');
        var rSel2 = $('reg-dst');
        if (iSel2) { iSel2.addEventListener('change', function () { syncTargetSelects(iSel2); }); }
        if (rSel2) { rSel2.addEventListener('change', function () { syncTargetSelects(rSel2); }); }

        var open = $('btn-xform');
        if (open) { open.addEventListener('click', openXformDialog); }


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
                    appliedMat = new Float64Array(16);
                    for (var qa = 0; qa < 16; qa++) { appliedMat[qa] = inv[qa]; }
                    refreshApplyState();

                    xformInfo('已应用逆矩阵（回到变换前）\n\n' + matToText(inv), false);
                }
            });
        }

        var mHead = $('xform-matrix-head');
        if (mHead) { mHead.addEventListener('click', function () { setMatrixOpen(!matrixOpen); }); }

        var apBtn = $('xform-apply');
        if (apBtn) { apBtn.addEventListener('click', applyPendingXform); }

        /* 待应用横幅上的两个按钮：与主「应用」同一动作，外加一键丢弃 */
        var xpApply = $('xp-apply');
        if (xpApply) { xpApply.addEventListener('click', applyPendingXform); }

        var xpDiscard = $('xp-discard');
        if (xpDiscard)
        {
            xpDiscard.addEventListener('click', function ()
            {
                writeXformMat(IDENT4);
                xformInfo('已丢弃未应用的矩阵（数据未改动）');
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

        // ---- N-N 配准 ----
        regBindCanvas();

        var regStart = $('reg-start');
        if (regStart)
        {
            regStart.addEventListener('click', function () { setRegMode(!regMode); });
        }

        var regClear = $('reg-clear');
        if (regClear)
        {
            regClear.addEventListener('click', function ()
            {
                regClearAll();
                setInfo('已清空点对');
            });
        }

        /* 侧栏摘要点一下就能展开/收起浮动表格 —— 面板里没有多余的按钮位置 */
        var regListEl = $('reg-list');
        if (regListEl)
        {
            regListEl.classList.add('clickable');
            regListEl.addEventListener('click', function ()
            {
                setRegTableVisible(!regTableVisible);
            });
        }

        var regSolveBtn = $('reg-solve');
        if (regSolveBtn)
        {
            /* 兜住异常：点击处理器里抛错时浏览器只写 console，
             * 界面表现就是"点了没反应"，非常难查（本函数就出过这种事故）。 */
            regSolveBtn.addEventListener('click', function ()
            {
                try { regSolve(); }
                catch (e)
                {
                    xformInfo('计算矩阵出错：' + (e && e.message ? e.message : e), true);
                    setInfo('计算矩阵出错：' + (e && e.message ? e.message : e), false, 'fail');
                }
            });
        }

        // ---- ICP ----
        var icpBtn = $('icp-run');
        if (icpBtn)
        {
            icpBtn.addEventListener('click', function ()
            {
                try { icpRun(); }
                catch (e)
                {
                    finishIcpRun();
                    xformInfo('配准出错：' + (e && e.message ? e.message : e), true);
                    setInfo('配准出错：' + (e && e.message ? e.message : e), false, 'fail');
                }
            });
        }

        // ---- 对称翻转检查 ----
    }

    /* 写状态栏单行；noLog 为 true 时只更新摘要、不记历史 */
    function setInfo(text, noLog, level)
    {
        var el = $('st-info');
        if (el) { el.textContent = text; }
        if (!noLog) { pushLog(text, level); }
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

        /* 跟随主题：优先读 app 状态（主题在 init 末尾才设置），
         * 再退回 html 上的 class —— 那是 <head> 内联脚本打的，首帧就有。
         * 顺序很重要：视角器是 canvas，init 之前重绘时只能靠 class 判断。 */
        var light = !!(global.MV.app && global.MV.app.settings && global.MV.app.settings.themeLight)
                 || document.documentElement.classList.contains('theme-light')
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

    /* 顶点 b 处的夹角（度） */

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

        /* 拾取面板的显隐会改变右上角的可用高度，选点表格跟着重排 */
        positionRegTable();

        var list = $('pick-list');
        list.innerHTML = '';

        for (var i = 0; i < points.length; i++)
        {
            var h = points[i];
            var row = document.createElement('div');
            row.className = 'pick-row';

            /* 最近三个点参与距离 / 角度计算，列表里也标出来，
             * 与三维视图里高亮的标记对应。 */
            var inCalc = i >= points.length - 3;

            var title = document.createElement('div');
            title.className = 'pick-title' + (inCalc ? ' pick-title-active' : '');
            title.textContent = 'P' + (i + 1) + '  ' + h.layer.name +
                (h.layer.kind === 'mesh' ? ' · 网格' : ' · 点云') +
                (inCalc ? '   ● 参与计算' : '');
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

        /* 距离 / 角度取【最近拾取的三个点】，而不是最早的三个。
         *
         * 边点边看是这类测量的主要用法：先点一个基准，再连续点几处比较。
         * 用最早的三个会让"刚点的那个点"完全不参与计算，反而要看它就得
         * 清空重来。现在始终跟着最新的走，编号也如实反映（P4→P5 这样）。 */
        var np = points.length;
        var out = [];

        if (np >= 2)
        {
            var a = points[np - 2].pos;
            var b = points[np - 1].pos;
            out.push('距离 P' + (np - 1) + '\u2192P' + np + '  ' + fmtNum(vecLen(a, b)));
            out.push('\u0394x ' + fmtNum(b[0] - a[0]) +
                '   \u0394y ' + fmtNum(b[1] - a[1]) +
                '   \u0394z ' + fmtNum(b[2] - a[2]));
        }
        if (np >= 3)
        {
            var p1 = points[np - 3].pos;
            var p2 = points[np - 2].pos;
            var p3 = points[np - 1].pos;
            out.push('角度 \u2220P' + (np - 2) + 'P' + (np - 1) + 'P' + np +
                '  ' + angleAt(p1, p2, p3).toFixed(2) + '\u00B0');
            out.push('边长 P' + (np - 1) + 'P' + (np - 2) + ' ' + fmtNum(vecLen(p2, p1)) +
                '   P' + (np - 1) + 'P' + np + ' ' + fmtNum(vecLen(p2, p3)));
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

        /* 序号标签（N-N 选点 R/A、工具拾取 P）跟着渲染帧走。
         * 常驻注册一次，内部按模式自行判断要不要画 —— 比"进模式注册、退模式注销"
         * 少一类状态，也不会漏掉 Esc 之类的退出路径。 */
        app.onAfterRender = uiFrameMarks;

        // 图表绑定按区域拆分，便于定位（原 593 行 init 的等价展开）
        bindTopbar();
        bindProps();
        bindViewOpts();
        bindMenus();
        bindRecent();
        bindSplitDrag();
        bindExportMenu();
        bindPairSelects();
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
        /* 确认框由 app.clearAll() 自己弹（它内部就调 showConfirm），
         * 这里**不要**再套一层 —— 双层确认会让用户点两次「确定」才生效，
         * 看起来像按钮失灵。本项只负责视觉：danger 色 + 与「适应」分隔。 */
        $('btn-clear').addEventListener('click', function () { app.clearAll(); });
        $('btn-shot').addEventListener('click', function () { app.screenshot(); });

        $('btn-fit').addEventListener('click', function ()
        {
            app.fitAll();
            setInfo('视图已按当前数据铺满');
        });

        /* 四元数 → yaw/pitch（度）：OrbitCamera.setOrientation 用 back 向量定义朝向，
         * q 把本地 -Z 转到 back，所以 back = q · (0,0,-1)。 */
        function viewAngles(q)
        {
            if (!q || q.length !== 4) { return null; }
            /* 与 core.js 的 OrbitCamera.yaw/pitch 完全一致：
             * q = fromBasis(right, up, back)，即 q 把本地 +Z 转到 back；
             * yaw = atan2(back.y, back.x)，pitch = asin(back.z)。 */
            var x = q[0], y = q[1], z = q[2], w = q[3];
            var tx = 2 * (y * 1 - z * 0);
            var ty = 2 * (z * 0 - x * 1);
            var tz = 2 * (x * 0 - y * 0);
            var bx = 0 + w * tx + (y * tz - z * ty);
            var by = 0 + w * ty + (z * tx - x * tz);
            var bz = 1 + w * tz + (x * ty - y * tx);
            var yaw = Math.atan2(by, bx) * 180 / Math.PI;
            var pitch = Math.asin(Math.max(-1, Math.min(1, bz))) * 180 / Math.PI;
            return { yaw: yaw, pitch: pitch };
        }

        function fmtViewParam(st)
        {
            if (!st || !st.target || !(st.distance > 0)) { return '（无相机参数）'; }
            var t = st.target;
            var a = viewAngles(st.q);
            var f = function (v) { return (Math.round(v * 10) / 10).toFixed(1); };
            var s = '(' + f(t[0]) + ',' + f(t[1]) + ',' + f(t[2]) + ')  d' + f(st.distance);
            if (a) { s += '  ' + f(a.yaw) + '°/' + f(a.pitch) + '°'; }
            return s;
        }

        /* ---- 视角清单：动态重建菜单项 ---- */
        function refreshViewMenu()
        {
            var box = $('views-list');
            if (!box) { return; }
            box.innerHTML = '';
            var store = app.getViewList();
            if (!store.list.length)
            {
                var em = document.createElement('div');
                em.className = 'view-empty';
                em.textContent = '（还没有保存视角）';
                box.appendChild(em);
                return;
            }
            store.list.forEach(function (item)
            {
                var row = document.createElement('div');
                row.className = 'view-item' + (item.id === store.active ? ' active' : '');

                /* 左侧：名称 + 保存时间（两行，避免菜单横向变宽） */
                var meta = document.createElement('div');
                meta.className = 'view-meta';
                var nm = document.createElement('div');
                nm.className = 'view-name';
                nm.textContent = (item.id === store.active ? '● ' : '') + item.name;
                nm.title = item.name;
                var tm = document.createElement('div');
                tm.className = 'view-time';
                if (item.createdAt)
                {
                    var dt = new Date(item.createdAt);
                    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
                    tm.textContent = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' +
                        pad(dt.getDate()) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
                }
                else
                {
                    tm.textContent = '（旧版视角）';
                }
                var pm = document.createElement('div');
                pm.className = 'view-param';
                pm.textContent = fmtViewParam(item.A);
                pm.title = 'A 视角：目标 / 距离 / 方位角、俯仰角';
                meta.appendChild(nm);
                meta.appendChild(pm);
                meta.appendChild(tm);

                /* 右侧两个按钮：应用 / 删除 */
                var go = document.createElement('button');
                go.className = 'view-apply';
                go.textContent = '应用';
                go.title = '应用视角「' + item.name + '」';
                go.addEventListener('click', function (ev)
                {
                    ev.stopPropagation();
                    app.switchToView(item.id);
                    setInfo('已应用视角：' + item.name, true);
                });

                var del = document.createElement('button');
                del.className = 'view-del';
                del.textContent = '删除';
                del.title = '删除视角「' + item.name + '」';
                del.addEventListener('click', function (ev)
                {
                    ev.stopPropagation();
                    app.deleteView(item.id);
                    setInfo('已删除视角：' + item.name, true);
                });

                row.appendChild(meta);
                row.appendChild(go);
                row.appendChild(del);
                box.appendChild(row);
            });
        }
        global.MV.ui.refreshViewMenu = refreshViewMenu;

        /* 视角清单是独立浮层：点开/关闭自己处理，不能冒泡到 tools-menu，
         * 否则父菜单的 click 处理器会立刻 hideTopMenus() 把它关掉。 */
        var viewMenuBtn = $('btn-views');
        var viewMenu = $('views-menu');
        var viewMenuPos = null;          // 本次会话内记住拖动后的位置；null = 尚未拖动
        if (viewMenuBtn && viewMenu)
        {
            viewMenu.style.position = 'fixed';
            viewMenu.style.margin = '0';     /* .menu 的 margin-top:6px 会叠加到 fixed 定位上 */
            viewMenu.style.zIndex = '60';

            viewMenuBtn.addEventListener('click', function (ev)
            {
                ev.stopPropagation();
                var willOpen = viewMenu.classList.contains('hidden');
                /* 先收起所有菜单（包括自己），再按 willOpen 决定是否重开 ——
                 * 这样再点一次按钮必然关闭，不受其它 click 处理器干扰。 */
                document.body.click();
                viewMenu.classList.add('hidden');
                if (!willOpen) { return; }

                refreshViewMenu();
                /* 先显示再量尺寸：浮层高度随清单内容变化，居中要用真实尺寸。 */
                viewMenu.classList.remove('hidden');

                var vr = null;
                var area = $('view-area');
                if (area && area.getBoundingClientRect) { vr = area.getBoundingClientRect(); }
                var wW = global.innerWidth || 1200;
                var wH = global.innerHeight || 800;
                /* getBoundingClientRect 会强制同步布局：清单刚增删一项时
                 * offsetHeight 可能还是上一帧的值，导致居中偏几个像素。 */
                var mr0 = viewMenu.getBoundingClientRect();
                var mw = mr0.width || viewMenu.offsetWidth || 262;
                var mh = mr0.height || viewMenu.offsetHeight || 240;

                var left, top;
                if (viewMenuPos)
                {
                    left = viewMenuPos.left;
                    top = viewMenuPos.top;
                }
                else if (vr && vr.width > 0 && vr.height > 0)
                {
                    /* 默认在三维视图区正中 */
                    left = vr.left + (vr.width - mw) / 2;
                    top = vr.top + (vr.height - mh) / 2;
                }
                else
                {
                    left = (wW - mw) / 2;
                    top = (wH - mh) / 2;
                }
                /* 防止视口变小后浮层跑到屏幕外 */
                left = Math.max(4, Math.min(left, wW - mw - 4));
                top = Math.max(4, Math.min(top, wH - mh - 4));
                viewMenu.style.left = Math.round(left) + 'px';
                viewMenu.style.top = Math.round(top) + 'px';
                viewMenuBtn.classList.add('active');
            });
            viewMenu.addEventListener('click', function (ev) { ev.stopPropagation(); });

            /* ---- 标题栏拖拽移动（位置只在本次会话内记住） ---- */
            var dragHandle = viewMenu.querySelector('.menu-label');
            var dragState = null;
            if (dragHandle)
            {
                dragHandle.addEventListener('pointerdown', function (ev)
                {
                    if (ev.button !== 0) { return; }
                    ev.stopPropagation();
                    var r = viewMenu.getBoundingClientRect();
                    dragState = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
                    dragHandle.setPointerCapture(ev.pointerId);
                    ev.preventDefault();
                });
                dragHandle.addEventListener('pointermove', function (ev)
                {
                    if (!dragState) { return; }
                    ev.stopPropagation();
                    var x = Math.max(0, Math.min(ev.clientX - dragState.dx,
                        (global.innerWidth || 1200) - 80));
                    var y = Math.max(0, Math.min(ev.clientY - dragState.dy,
                        (global.innerHeight || 800) - 40));
                    viewMenu.style.left = x + 'px';
                    viewMenu.style.top = y + 'px';
                });
                dragHandle.addEventListener('pointerup', function (ev)
                {
                    dragState = null;
                    viewMenuPos = {
                        left: parseInt(viewMenu.style.left, 10) || 0,
                        top: parseInt(viewMenu.style.top, 10) || 0
                    };
                    try { dragHandle.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
                });
            }

            /* 点页面其它地方关闭 */
            document.addEventListener('click', function ()
            {
                viewMenu.classList.add('hidden');
                viewMenuBtn.classList.remove('active');
            });
        }

        $('btn-view-add').addEventListener('click', function ()
        {
            var item = app.addCurrentView();
            setInfo('已新增视角：' + item.name + '（Shift+V 可快速新增）', true);
        });
        refreshViewMenu();

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
        /* ---- 属性面板的「变换」行 ---- */
        var xMain = $('p-xform-main');
        if (xMain)
        {
            xMain.addEventListener('click', function ()
            {
                var l = app ? app.getSelected() : null;
                if (!l || !l.xformSteps || !l.xformSteps.length) { return; }
                propXformOpen = !propXformOpen;
                renderXformProp(l);
            });
        }

        var xCopy = $('p-xform-copy');
        if (xCopy)
        {
            xCopy.addEventListener('click', function ()
            {
                var l = app ? app.getSelected() : null;
                if (!l || !l.xformMat || isIdentityMat(l.xformMat)) { return; }

                var t = matToText(l.xformMat);
                function done() { setInfo('已复制 ' + l.name + ' 的累计变换（16 个数）'); }
                if (global.navigator && navigator.clipboard && navigator.clipboard.writeText)
                {
                    navigator.clipboard.writeText(t).then(done, function () { fallbackCopy(t, done); });
                }
                else
                {
                    fallbackCopy(t, done);
                }
            });
        }

        var xUndo = $('p-xform-undo');
        if (xUndo)
        {
            xUndo.addEventListener('click', function ()
            {
                undoLastXformOf(app ? app.getSelected() : null);
            });
        }

        var xInv = $('p-xform-inv');
        if (xInv)
        {
            xInv.addEventListener('click', function ()
            {
                invertLayerXform(app ? app.getSelected() : null);
            });
        }

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
            l.autoColor = false;   /* 手动定过色：切主题时不再自动换 */
            app.markDirty();
            renderTree();
        });

        $('p-backcolor').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.backColor = this.value;
            l.backColorRgb = hexToRgb(this.value);
            l.autoColor = false;
            app.markDirty();
        });

        $('p-wirecolor').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.wireColor = this.value;
            l.wireColorRgb = hexToRgb(this.value);
            l.autoColor = false;
            app.markDirty();
        });

        $('p-vertcolor').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.vertColor = this.value;
            l.vertColorRgb = hexToRgb(this.value);
            l.autoColor = false;
            app.markDirty();
        });

        $('p-boundarycolor').addEventListener('input', function ()
        {
            var l = app.getSelected();
            if (!l) { return; }
            l.boundaryColor = this.value;
            l.boundaryColorRgb = hexToRgb(this.value);
            l.autoColor = false;
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
            /* 与 N-N 选点互斥：两者都是"左键单击取点" */
            if (regMode) { setRegMode(false); }

            app.togglePickInfo();
            app.suppressPick = false;   /* 已退出选点，恢复单击的常规语义 */
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

    /* ============ 文件句柄（File System Access） ============
     * 浏览器不会把拖入文件的绝对路径交给页面，所以「重开」不能靠路径。
     * getAsFileSystemHandle() 给出的 FileSystemFileHandle 是对该文件的真实引用，
     * 可以存进 IndexedDB 跨会话保留；再次打开时用 queryPermission / getFile 取回。
     * 这样任意目录（桌面、U 盘、网络盘）的文件都能从历史重新导入，且不靠猜测。
     */
    var HANDLE_DB = 'viewer3d-fs';
    var HANDLE_STORE = 'handles';

    /* 本次会话内的 file → handle 映射（避免把属性挂在 File 对象上） */
    var fileHandleMap = (global.WeakMap ? new global.WeakMap() : null);

    function setHandleOf(file, handle)
    {
        if (fileHandleMap && file && handle) { fileHandleMap.set(file, handle); }
    }

    function handleOf(file)
    {
        return (fileHandleMap && file) ? (fileHandleMap.get(file) || null) : null;
    }

    /* 连接复用：每次读写都 open 一次既慢又可能被其它标签页的升级阻塞 */
    var handleDbPromise = null;

    function handleDb()
    {
        if (handleDbPromise) { return handleDbPromise; }

        handleDbPromise = new Promise(function (resolve, reject)
        {
            if (!global.indexedDB)
            {
                reject(new Error('浏览器不支持 IndexedDB'));
                return;
            }
            var req = global.indexedDB.open(HANDLE_DB, 1);
            req.onupgradeneeded = function ()
            {
                var db = req.result;
                if (!db.objectStoreNames.contains(HANDLE_STORE))
                {
                    db.createObjectStore(HANDLE_STORE);
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function ()
            {
                handleDbPromise = null;
                reject(req.error || new Error('IndexedDB 打开失败'));
            };
        });

        return handleDbPromise;
    }

    /* 加超时：宁可报错，也不要让「正在恢复…」一直挂着 */
    function withTimeout(promise, ms, text)
    {
        return new Promise(function (resolve, reject)
        {
            var done = false;
            var timer = setTimeout(function ()
            {
                if (done) { return; }
                done = true;
                reject(new Error(text || '操作超时'));
            }, ms || 8000);

            promise.then(function (v)
            {
                if (done) { return; }
                done = true;
                clearTimeout(timer);
                resolve(v);
            }, function (e)
            {
                if (done) { return; }
                done = true;
                clearTimeout(timer);
                reject(e);
            });
        });
    }

    function handlePut(id, handle)
    {
        return handleDb().then(function (db)
        {
            return new Promise(function (resolve, reject)
            {
                var tx = db.transaction(HANDLE_STORE, 'readwrite');
                tx.objectStore(HANDLE_STORE).put(handle, id);
                tx.oncomplete = function () { resolve(id); };
                tx.onerror = function () { reject(tx.error || new Error('写入失败')); };
            });
        });
    }

    function handleGet(id)
    {
        return handleDb().then(function (db)
        {
            return new Promise(function (resolve, reject)
            {
                var tx = db.transaction(HANDLE_STORE, 'readonly');
                var rq = tx.objectStore(HANDLE_STORE).get(id);
                rq.onsuccess = function () { resolve(rq.result || null); };
                rq.onerror = function () { reject(rq.error || new Error('读取失败')); };
            });
        });
    }

    function handleDel(id)
    {
        return handleDb().then(function (db)
        {
            return new Promise(function (resolve)
            {
                var tx = db.transaction(HANDLE_STORE, 'readwrite');
                tx.objectStore(HANDLE_STORE).delete(id);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { resolve(false); };
            });
        }).catch(function () { });
    }

    /* 取回文件：必要时请求一次读权限（点击条目本身是用户手势，满足要求） */
    function reopenHandle(id)
    {
        return withTimeout(handleGet(id), 8000, '读取文件引用超时').then(function (h)
        {
            if (!h) { throw new Error('这条历史没有可用的文件引用'); }

            var opts = { mode: 'read' };
            var q = h.queryPermission ? h.queryPermission(opts) : Promise.resolve('granted');

            /* 取回文件后把句柄绑回 File：这样重开的图层同样带 hasFileRef，
             * 路径栏会继续提示「拖入的文件」，而不是退化成完全未知。 */
            function take()
            {
                return h.getFile().then(function (f)
                {
                    setHandleOf(f, h);
                    return f;
                });
            }

            return q.then(function (st)
            {
                if (st === 'granted') { return take(); }
                if (!h.requestPermission) { throw new Error('无法请求文件读取权限'); }
                return h.requestPermission(opts).then(function (st2)
                {
                    if (st2 === 'granted') { return take(); }
                    throw new Error('未获得读取权限');
                });
            });
        });
    }

    /* ==================== 载入历史（最近 10 个） ====================
     * 只有两类条目能真正重开：
     *   url  —— 由 ?url= 载入，sourceUrl 是完整地址，可直接再取
     *   path —— 磁盘选择 / 拖拽的文件：浏览器不给路径，但 /locate 能按
     *           「文件名 + 大小」反查出绝对路径，再由 GET /file?path= 回读
     * disk 是查不到路径的残条目，只能提示用户重新选择。
     */
    var RECENT_KEY = 'viewer3d.recent';
    var RECENT_MAX = 10;

    function recentRead()
    {
        try
        {
            var raw = global.localStorage.getItem(RECENT_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
        }
        catch (e) { return []; }
    }

    function recentWrite(list)
    {
        try
        {
            global.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
        }
        catch (e) { /* 配额已满 / 隐私模式 */ }
    }

    function recentKeyOf(it)
    {
        if (it && it.kind === 'path' && it.path) { return 'p|' + it.path; }
        if (it && it.kind === 'url' && it.url) { return 'u|' + it.url; }
        return 'd|' + ((it && it.name) || '') + '|' + ((it && it.size) || 0);
    }

    function recentSlotLabel(code)
    {
        return ({ A: '左侧', B: '右侧', S: '公共' })[code] || '公共';
    }

    function recentAgo(t)
    {
        if (!t) { return ''; }
        var d = Math.max(0, Date.now() - t) / 1000;
        if (d < 60) { return '刚刚'; }
        if (d < 3600) { return Math.floor(d / 60) + ' 分钟前'; }
        if (d < 86400) { return Math.floor(d / 3600) + ' 小时前'; }
        return Math.floor(d / 86400) + ' 天前';
    }

    function recentSize(n)
    {
        if (!n) { return ''; }
        return n < 1048576
            ? Math.round(n / 1024) + ' KB'
            : (n / 1048576).toFixed(1) + ' MB';
    }

    /* 记录一次成功载入；同一条目重复载入只更新时间并置顶 */
    function pushRecent(entry)
    {
        if (!entry || !entry.name) { return; }

        var list = recentRead();
        var key = recentKeyOf(entry);
        var out = [entry];

        for (var i = 0; i < list.length && out.length < RECENT_MAX; i++)
        {
            if (recentKeyOf(list[i]) !== key) { out.push(list[i]); }
        }

        recentWrite(out);
        renderLoadRecent();
    }

    /* /locate 命中后，把「无法重开」的 disk 条目升级成可按路径重开的 path 条目 */
    function upgradeRecentPath(name, size, absPath)
    {
        if (!name || !absPath) { return; }

        var list = recentRead();
        var changed = false;

        for (var i = 0; i < list.length; i++)
        {
            var it = list[i];
            if (it.kind === 'disk' && it.name === name && (it.size || 0) === (size || 0))
            {
                list[i] = {
                    kind: 'path',
                    path: absPath,
                    name: it.name,
                    size: it.size,
                    slot: it.slot,
                    t: it.t
                };
                changed = true;
            }
        }

        if (changed)
        {
            recentWrite(list);
            renderLoadRecent();
        }
    }

    function removeRecent(idx)
    {
        var list = recentRead();
        if (idx < 0 || idx >= list.length) { return; }
        list.splice(idx, 1);
        recentWrite(list);
        renderLoadRecent();
    }

    function renderLoadRecent()
    {
        var box = $('load-recent');
        if (!box) { return; }

        var list = recentRead();
        box.innerHTML = '';

        if (!list.length)
        {
            var empty = document.createElement('div');
            empty.className = 'recent-empty';
            empty.textContent = '（暂无记录）';
            box.appendChild(empty);
            return;
        }

        for (var i = 0; i < list.length; i++)
        {
            (function (it, idx)
            {
                var row = document.createElement('div');
                row.className = 'recent-item' + (it.kind === 'disk' ? ' unusable' : '');

                var main = document.createElement('button');
                main.className = 'recent-main';
                main.title = it.kind === 'path' ? it.path
                    : (it.kind === 'url' ? it.url
                        : (it.kind === 'handle'
                            ? it.name + '（浏览器托管的文件引用，不暴露真实路径）'
                            : it.name + '（查不到路径，需重新选择文件）'));

                var nm = document.createElement('span');
                nm.className = 'recent-name';
                nm.textContent = it.name;
                main.appendChild(nm);

                var meta = document.createElement('span');
                meta.className = 'recent-meta';
                meta.textContent = [
                    recentSlotLabel(it.slot),
                    recentSize(it.size),
                    recentAgo(it.t),
                    it.kind === 'disk' ? '需重新选择'
                        : (it.kind === 'handle' ? '可重开' : '')
                ].filter(Boolean).join(' · ');
                main.appendChild(meta);

                main.addEventListener('click', function ()
                {
                    if (global.MV.app && global.MV.app.openRecent) { global.MV.app.openRecent(it); }
                });

                var del = document.createElement('button');
                del.className = 'recent-del';
                del.title = '从历史中移除';
                del.textContent = '×';
                del.addEventListener('click', function (ev)
                {
                    ev.stopPropagation();
                    removeRecent(idx);
                });

                row.appendChild(main);
                row.appendChild(del);
                box.appendChild(row);
            })(list[i], i);
        }
    }

    function bindRecent()
    {
        var btn = $('btn-recent-clear');
        if (btn)
        {
            btn.addEventListener('click', function (ev)
            {
                ev.stopPropagation();
                recentWrite([]);
                renderLoadRecent();
            });
        }
        renderLoadRecent();
    }

    /* ---- 双窗分隔线：左右拖动 ----
     * 拖到接近边缘（<5% 或 >95%）时，比例会缓动到贴边并切进单窗模式，
     * 退出单窗时再从贴边展开回原比例，避免「啪」地跳变。 */
    function bindSplitDrag()
    {
        var line = $('split-line');
        var area = $('view-area');
        if (!line || !area) { return; }

        var dragging = false;

        function ratioAt(clientX)
        {
            var r = area.getBoundingClientRect();
            if (r.width < 20) { return 0.5; }
            return (clientX - r.left) / r.width;
        }

        /* 角标「左侧 (A)」离视口左缘 12px，两侧各留一点余量；
         * 视图一旦窄到这个宽度角标就会被裁掉，那之前就切单窗 */
        function tagNeed()
        {
            var l = $('tag-left'), r = $('tag-right');
            var w = Math.max(l ? l.offsetWidth : 0, r ? r.offsetWidth : 0);
            return w + 30;
        }

        function collapse(dir)
        {
            var app = global.MV.app;
            if (!app) { return; }

            app.animateSplitRatio(dir < 0 ? 0 : 1, 170, function ()
            {
                app.setSingleView(true);
            });
        }

        function stop()
        {
            if (!dragging) { return; }
            dragging = false;
            document.body.classList.remove('split-dragging');
        }

        line.addEventListener('pointerdown', function (ev)
        {
            var app = global.MV.app;
            if (!app || app.settings.singleView) { return; }

            dragging = true;
            document.body.classList.add('split-dragging');
            if (line.setPointerCapture)
            {
                try { line.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
            }
            ev.preventDefault();
        });

        global.addEventListener('pointermove', function (ev)
        {
            if (!dragging) { return; }

            var r = ratioAt(ev.clientX);

            /* 判据从「固定的 5%」改成「放不下角标」：
             * 任一侧比角标还窄，角标就会被视口裁掉，此时直接切单窗 */
            var need = tagNeed();
            var W = area.clientWidth;
            var leftW = W * r;
            var rightW = W - leftW - 2;

            if (leftW <= need)
            {
                stop();
                collapse(-1);
                return;
            }
            if (rightW <= need)
            {
                stop();
                collapse(1);
                return;
            }

            global.MV.app.setSplitRatio(r);
        });

        global.addEventListener('pointerup', stop);
        global.addEventListener('pointercancel', stop);

        /* 窗口尺寸变化后，分隔线的像素位置要按新宽度重算 */
        global.addEventListener('resize', function ()
        {
            var app = global.MV.app;
            if (app) { app.setSplitRatio(app.settings.splitRatio); }
        });
    }

    /* ---- bindMenus ---- */
    /* 导出菜单：按当前选中图层决定哪些项可用。
     * 用 disabled 而不是隐藏 —— 用户能看到「有这项但这次用不了」，
     * 悬停时 title 会说明原因。 */
    function renderExportMenu()
    {
        var l = app && app.getSelected ? app.getSelected() : null;
        var isMesh = !!(l && l.kind === 'mesh');
        var isPoints = !!(l && l.kind === 'points');

        var label = $('exp-target');
        if (label)
        {
            label.textContent = l
                ? ('当前图层：' + l.name + '（' + (isMesh ? 'mesh' : 'points') + '）')
                : '未选中图层';
        }

        function setItem(id, ok, why)
        {
            var el = $(id);
            if (!el) { return; }
            el.disabled = !ok;
            el.title = ok ? (el.getAttribute('data-tip') || '') : why;
        }

        setItem('exp-raw', !!(l && l.sourceFile),
            l ? '该图层没有原始文件（URL 载入或派生的图层）' : '先在场景树里选中一个图层');
        setItem('exp-stl', isMesh, l ? 'STL 只支持网格图层' : '先在场景树里选中一个图层');
        setItem('exp-obj', isMesh, l ? 'OBJ 只支持网格图层' : '先在场景树里选中一个图层');
        setItem('exp-csv', isPoints, l ? '点云文本只支持点云图层' : '先在场景树里选中一个图层');
        setItem('exp-xyz', isPoints, l ? '点云文本只支持点云图层' : '先在场景树里选中一个图层');
        setItem('exp-ply', isMesh || isPoints, '先在场景树里选中一个图层');
        setItem('exp-pcd', isPoints, l ? 'PCD 只支持点云图层' : '先在场景树里选中一个图层');
        setItem('exp-glb', isMesh, l ? 'GLB 只支持网格图层' : '先在场景树里选中一个图层');
    }

    function bindExportMenu()
    {
        var items = [
            ['exp-raw', 'raw'],
            ['exp-stl', 'stl'],
            ['exp-obj', 'obj'],
            ['exp-csv', 'csv'],
            ['exp-xyz', 'xyz'],
            ['exp-ply', 'ply'],
            ['exp-pcd', 'pcd'],
            ['exp-glb', 'glb']
        ];

        for (var i = 0; i < items.length; i++)
        {
            (function (id, fmt)
            {
                var el = $(id);
                if (!el) { return; }
                el.addEventListener('click', function ()
                {
                    if (el.disabled) { return; }
                    app.exportSelected(fmt);
                });
            })(items[i][0], items[i][1]);
        }
    }

    function bindMenus()
    {
        // 顶栏下拉：载入 / 插件 / 工具，三者互斥，点任一项后自动收起
        var topMenus = [
            { btn: $('btn-load'), menu: $('load-menu') },
            { btn: $('btn-export'), menu: $('export-menu') },
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
                        if (it.menu.id === 'load-menu') { renderLoadRecent(); }
                        if (it.menu.id === 'export-menu') { renderExportMenu(); }
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


    /* 主题：切 <html> 上的 class，颜色由 CSS 变量决定。
     *
     * 挂在 <html> 而不是 <body>，是为了让 <head> 里的内联脚本能在首帧之前
     * 就把浅色定下来（那时 body 还不存在）；body 上同步一份只是为了兼容
     * 任何按 body 判断主题的外部脚本，CSS 已经不认它了。 */
    function applyTheme(light)
    {
        document.documentElement.classList.toggle('theme-light', !!light);
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
        pushRecent: pushRecent,
        saveHandle: handlePut,
        dropHandle: handleDel,
        reopenHandle: reopenHandle,
        setHandleOf: setHandleOf,
        handleOf: handleOf,
        upgradeRecentPath: upgradeRecentPath,
        renderLoadRecent: renderLoadRecent,
        renderTree: renderTree,
        refreshUI: refreshUI,
        forceRenderTree: forceRenderTree,
        renderProps: renderProps,
        setProgress: setProgress,
        setInfo: setInfo,
        solveRigid: solveRigid,
        setStats: setStats,
        showConfirm: showConfirm,
        cancelICP: cancelICP,
        isIcpRunning: isIcpRunning,
        beginRenameSelected: beginRenameSelected,
        nowMs: nowMs,
        fmtDur: fmtDur,
        logTiming: logTiming,
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

            /* getAsFileSystemHandle 必须在事件回调里同步发起（等异步回来就失效了），
             * 拿到句柄后与 File 一一配对；句柄用于「下次从历史重开」，与路径无关。 */
            var items = e.dataTransfer.items || [];
            var pending = [];
            for (var hi = 0; hi < files.length; hi++)
            {
                var it = items[hi];
                /* 合成事件 / 非真实拖拽时 getAsFileSystemHandle 可能同步抛错，
                 * 这里单独兜住，绝不能因此让整次拖入失败 */
                try
                {
                    pending.push((it && it.getAsFileSystemHandle)
                        ? Promise.resolve(it.getAsFileSystemHandle())
                            .then(null, function () { return null; })
                        : Promise.resolve(null));
                }
                catch (e2)
                {
                    pending.push(Promise.resolve(null));
                }
            }

            var slot = slotAt(e.clientX);
            var where = slot === 'A' ? '左侧 (A)' : (slot === 'B' ? '右侧 (B)' : '公共场景');
            global.MV.ui.setInfo('正在导入 ' + files.length + ' 个文件到' + where + ' …');

            Promise.all(pending).then(function (handles)
            {
                for (var k = 0; k < files.length; k++)
                {
                    var hd = handles[k];
                    if (hd && hd.kind === 'file') { setHandleOf(files[k], hd); }
                }
                self.addFiles(files, slot);
            }, function ()
            {
                self.addFiles(files, slot);   // 取句柄失败也要能导入
            });
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
