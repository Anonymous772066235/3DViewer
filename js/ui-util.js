/* 3DViewer · 纯工具函数
 *
 * 这里的函数不接触 DOM、不读 App 状态、也不调用 ui.js 里的其它函数，
 * 只做数值计算与字符串格式化 —— 所以可以独立成文件、独立测试。
 *
 * 挂到 MV.util 暴露（不用 MV.ui.util：ui.js 会整个覆盖 MV.ui）；
 * ui.js 在顶部解构成本地变量，
 * 原来所有调用点都不需要改动。
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
