/* L2 IO 层 | io：数据进出
 * 允许依赖：core（MV.math）
 * 禁止依赖：render / GL
 * 导出：MV.loaders / MV.optimize / MV.memguard
 * 说明：三段各自独立作用域（原本是三个文件，私有函数名有重名，不能平铺）
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
        renderPickBar: function () {}
    };

    function bindHooks(h)
    {
        if (!h) { return; }
        for (var k in hooks)
        {
            if (typeof h[k] === 'function') { hooks[k] = h[k]; }
        }
    }

    /* 取小写扩展名（loaders 与 memguard 共用，原先各有一份重复实现） */
    function extOf(name)
    {
        var s = name || '';
        var i = s.lastIndexOf('.');
        return i < 0 ? '' : s.substring(i + 1).toLowerCase();
    }

    /* ==================== 文件解析（原 loaders.js） ==================== */
    (function ()
    {
    var CHUNK = 4 << 20;
    var MAX_CARRY = 2 << 20;

    // 默认不限制：Infinity 让所有“超限判断”恒为 false，数据全量载入
    var DEFAULT_MAX_TRIANGLES = Number.POSITIVE_INFINITY;
    var DEFAULT_MAX_POINTS = Number.POSITIVE_INFINITY;

    function yieldToUI()
    {
        return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    function readSlice(file, start, end)
    {
        return file.slice(start, end).arrayBuffer();
    }

    /* ---------------- 动态数组 ---------------- */
    function F32Accum(cap)
    {
        this.data = new Float32Array(cap || 4096);
        this.n = 0;
    }

    F32Accum.prototype.reserve = function (extra)
    {
        if (this.n + extra <= this.data.length)
        {
            return;
        }
        var cap = this.data.length * 2;
        while (cap < this.n + extra)
        {
            cap *= 2;
        }
        var nd = new Float32Array(cap);
        nd.set(this.data.subarray(0, this.n));
        this.data = nd;
    };

    F32Accum.prototype.push = function (v)
    {
        if (this.n >= this.data.length)
        {
            this.reserve(1);
        }
        this.data[this.n++] = v;
    };

    F32Accum.prototype.push3 = function (a, b, c)
    {
        this.reserve(3);
        this.data[this.n++] = a;
        this.data[this.n++] = b;
        this.data[this.n++] = c;
    };

    F32Accum.prototype.result = function ()
    {
        return this.data.subarray(0, this.n);
    };

    function I32Accum(cap)
    {
        this.data = new Int32Array(cap || 4096);
        this.n = 0;
    }

    I32Accum.prototype.push = function (v)
    {
        if (this.n >= this.data.length)
        {
            var cap = this.data.length * 2;
            var nd = new Int32Array(cap);
            nd.set(this.data.subarray(0, this.n));
            this.data = nd;
        }
        this.data[this.n++] = v;
    };

    I32Accum.prototype.result = function ()
    {
        return this.data.subarray(0, this.n);
    };

    /* ---------------- 逐行读取 ---------------- */
    async function forEachLine(file, onLines, onProgress, startOffset)
    {
        var pos = startOffset || 0;
        var dec = new TextDecoder('utf-8');
        var carry = '';

        while (pos < file.size)
        {
            var end = Math.min(pos + CHUNK, file.size);
            var buf = await readSlice(file, pos, end);
            var text = carry + dec.decode(buf, { stream: true });
            var lines = text.split('\n');

            carry = lines.pop();
            if (carry.length > MAX_CARRY)
            {
                carry = '';
            }

            onLines(lines);
            pos = end;

            if (onProgress)
            {
                await onProgress(pos / file.size);
            }
            await yieldToUI();
        }

        if (carry.trim().length > 0)
        {
            onLines([carry]);
        }
    }

    /* ---------------- 数字扫描（比 split 快） ---------------- */
    function scanNumbers(line, out)
    {
        var n = 0;
        var i = 0;
        var len = line.length;
        var cap = out.length;

        while (i < len && n < cap)
        {
            var c = line.charCodeAt(i);
            if (c === 32 || c === 9 || c === 13 || c === 44 || c === 59 || c === 124)
            {
                i++;
                continue;
            }
            if (c === 35 /* # */)
            {
                break;
            }

            var start = i;
            var hasDigit = false;
            while (i < len)
            {
                c = line.charCodeAt(i);
                if (c >= 48 && c <= 57)
                {
                    hasDigit = true;
                    i++;
                }
                else if (c === 46 || c === 43 || c === 45 || c === 101 || c === 69)
                {
                    i++;
                }
                else
                {
                    break;
                }
            }

            if (!hasDigit)
            {
                // 非数字 token（如 vertex / endloop），跳过
                if (i === start)
                {
                    i++;
                }
                continue;
            }

            out[n++] = parseFloat(line.substring(start, i));
        }
        return n;
    }

    /* ---------------- STL ---------------- */
    async function looksLikeBinarySTL(file)
    {
        if (file.size < 84)
        {
            return false;
        }
        var buf = await readSlice(file, 0, 84);
        var dv = new DataView(buf);
        var n = dv.getUint32(80, true);
        var expect = 84 + n * 50;
        return n > 0 && Math.abs(expect - file.size) <= 64;
    }

    async function parseBinarySTL(file, opts, onProgress)
    {
        var maxTri = opts.maxTriangles || DEFAULT_MAX_TRIANGLES;
        var head = new DataView(await readSlice(file, 0, 84));
        var total = head.getUint32(80, true);

        var step = Math.max(1, Math.ceil(total / maxTri));
        var outTri = Math.ceil(total / step);
        var pos = new Float32Array(outTri * 9);
        var bbox = global.MV.math.BBox.empty();
        var w = 0;

        var chunkTri = 20000;
        var src = 0;

        while (src < total)
        {
            var cnt = Math.min(chunkTri, total - src);
            var buf = await readSlice(file, 84 + src * 50, 84 + (src + cnt) * 50);
            var dv = new DataView(buf);

            for (var i = 0; i < cnt; i++)
            {
                if ((src + i) % step !== 0)
                {
                    continue;
                }
                var o = i * 50 + 12;
                for (var k = 0; k < 9; k += 3)
                {
                    var x = dv.getFloat32(o + k * 4, true);
                    var y = dv.getFloat32(o + k * 4 + 4, true);
                    var z = dv.getFloat32(o + k * 4 + 8, true);
                    pos[w++] = x;
                    pos[w++] = y;
                    pos[w++] = z;
                    if (x < bbox.min[0]) { bbox.min[0] = x; }
                    if (y < bbox.min[1]) { bbox.min[1] = y; }
                    if (z < bbox.min[2]) { bbox.min[2] = z; }
                    if (x > bbox.max[0]) { bbox.max[0] = x; }
                    if (y > bbox.max[1]) { bbox.max[1] = y; }
                    if (z > bbox.max[2]) { bbox.max[2] = z; }
                }
            }

            src += cnt;
            if (onProgress)
            {
                await onProgress(src / total, 'STL 解析 ' + Math.round(src / total * 100) + '%');
            }
            await yieldToUI();
        }

        return {
            kind: 'mesh',
            positions: pos.subarray(0, w),
            count: Math.floor(w / 9),
            bbox: bbox,
            format: 'STL(binary)',
            truncated: step > 1,
            totalSource: total,
            note: step > 1 ? ('按 1/' + step + ' 抽样') : ''
        };
    }

    async function parseAsciiSTL(file, opts, onProgress)
    {
        var maxTri = opts.maxTriangles || DEFAULT_MAX_TRIANGLES;
        var buf9 = new Float64Array(9);
        var body = new F32Accum(1 << 20);
        var numBuf = new Float64Array(8);
        var bbox = global.MV.math.BBox.empty();
        var triIdx = 0;
        var accepted = 0;
        var full = false;

        await forEachLine(file, function (lines)
        {
            if (full)
            {
                return;
            }
            for (var i = 0; i < lines.length; i++)
            {
                var s = lines[i];
                if (s.length < 6)
                {
                    continue;
                }
                var t = s.trim();
                if (t.length < 6 || t.substring(0, 6) !== 'vertex')
                {
                    continue;
                }
                var n = scanNumbers(t.substring(6), numBuf);
                if (n < 3)
                {
                    continue;
                }
                // 每 3 个顶点构成一个三角形
                var slot = triIdx % 3;
                triIdx++;
                buf9[slot * 3] = numBuf[0];
                buf9[slot * 3 + 1] = numBuf[1];
                buf9[slot * 3 + 2] = numBuf[2];

                if (slot === 2)
                {
                    if (accepted < maxTri)
                    {
                        for (var k = 0; k < 9; k += 3)
                        {
                            var x = buf9[k], y = buf9[k + 1], z = buf9[k + 2];
                            body.push3(x, y, z);
                            if (x < bbox.min[0]) { bbox.min[0] = x; }
                            if (y < bbox.min[1]) { bbox.min[1] = y; }
                            if (z < bbox.min[2]) { bbox.min[2] = z; }
                            if (x > bbox.max[0]) { bbox.max[0] = x; }
                            if (y > bbox.max[1]) { bbox.max[1] = y; }
                            if (z > bbox.max[2]) { bbox.max[2] = z; }
                        }
                        accepted++;
                    }
                    else
                    {
                        full = true;
                        return;
                    }
                }
            }
        }, async function (f)
        {
            if (onProgress)
            {
                await onProgress(f, 'STL(ascii) 读取 ' + Math.round(f * 100) + '%');
            }
        });

        return {
            kind: 'mesh',
            positions: body.result(),
            count: Math.floor(body.n / 9),
            bbox: bbox,
            format: 'STL(ascii)',
            truncated: full,
            totalSource: Math.floor(triIdx / 3),
            note: full ? ('仅载入前 ' + accepted + ' 个三角形') : ''
        };
    }

    async function parseSTL(file, opts, onProgress)
    {
        var isBin = await looksLikeBinarySTL(file);
        if (isBin)
        {
            return parseBinarySTL(file, opts, onProgress);
        }
        return parseAsciiSTL(file, opts, onProgress);
    }

    /* ---------------- OBJ ---------------- */
    async function parseOBJ(file, opts, onProgress)
    {
        var maxTri = opts.maxTriangles || DEFAULT_MAX_TRIANGLES;
        var verts = new F32Accum(1 << 20);
        var faces = new I32Accum(1 << 20);
        var numBuf = new Float64Array(4);
        var idxBuf = new Int32Array(64);
        var triCount = 0;
        var srcTri = 0;
        var vcount = 0;
        var full = false;
        var bbox = global.MV.math.BBox.empty();

        await forEachLine(file, function (lines)
        {
            if (full)
            {
                return;
            }
            for (var li = 0; li < lines.length; li++)
            {
                var line = lines[li];
                if (line.length < 2)
                {
                    continue;
                }
                var c0 = line.charCodeAt(0);
                var c1 = line.charCodeAt(1);

                // v
                if (c0 === 118 && (c1 === 32 || c1 === 9))
                {
                    var n = scanNumbers(line.substring(1), numBuf);
                    if (n >= 3)
                    {
                        var x = numBuf[0], y = numBuf[1], z = numBuf[2];
                        verts.push3(x, y, z);
                        vcount++;
                        if (x < bbox.min[0]) { bbox.min[0] = x; }
                        if (y < bbox.min[1]) { bbox.min[1] = y; }
                        if (z < bbox.min[2]) { bbox.min[2] = z; }
                        if (x > bbox.max[0]) { bbox.max[0] = x; }
                        if (y > bbox.max[1]) { bbox.max[1] = y; }
                        if (z > bbox.max[2]) { bbox.max[2] = z; }
                    }
                    continue;
                }

                // f
                if (c0 === 102 && (c1 === 32 || c1 === 9))
                {
                    var m = scanFace(line, vcount, idxBuf);
                    if (m >= 3)
                    {
                        for (var k = 1; k + 1 < m; k++)
                        {
                            srcTri++;
                            if (triCount >= maxTri)
                            {
                                full = true;
                                return;
                            }
                            faces.push(idxBuf[0]);
                            faces.push(idxBuf[k]);
                            faces.push(idxBuf[k + 1]);
                            triCount++;
                        }
                    }
                }
            }
        }, async function (f)
        {
            if (onProgress)
            {
                await onProgress(f, 'OBJ 读取 ' + Math.round(f * 100) + '%');
            }
        });

        var vdata = verts.data;
        var fdata = faces.data;
        var pos = new Float32Array(triCount * 9);
        var w = 0;
        for (var i = 0; i < triCount * 3; i++)
        {
            var vi = fdata[i] * 3;
            pos[w++] = vdata[vi];
            pos[w++] = vdata[vi + 1];
            pos[w++] = vdata[vi + 2];
        }

        return {
            kind: 'mesh',
            positions: pos,
            count: triCount,
            bbox: bbox,
            format: 'OBJ',
            truncated: full,
            totalSource: srcTri,
            note: full ? ('仅载入前 ' + triCount + ' 个三角形') : ''
        };
    }

    function scanFace(line, vcount, out)
    {
        var n = 0;
        var i = 1;
        var len = line.length;

        while (i < len && n < out.length)
        {
            while (i < len && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9))
            {
                i++;
            }
            if (i >= len)
            {
                break;
            }

            var start = i;
            while (i < len)
            {
                var c = line.charCodeAt(i);
                if (c === 32 || c === 9 || c === 47 /* / */)
                {
                    break;
                }
                i++;
            }
            var raw = parseInt(line.substring(start, i), 10);
            if (isNaN(raw))
            {
                break;
            }
            // 负索引：相对于当前已解析的顶点数
            var idx = raw < 0 ? (vcount + raw) : (raw - 1);
            out[n++] = idx;

            // 跳过 /vt/normal
            while (i < len)
            {
                var c2 = line.charCodeAt(i);
                if (c2 === 32 || c2 === 9)
                {
                    break;
                }
                i++;
            }
        }
        return n;
    }

    /* ---------------- PLY ---------------- */
    var PLY_TYPES = {
        char: 1, uchar: 1, int8: 1, uint8: 1,
        short: 2, ushort: 2, int16: 2, uint16: 2,
        int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
        double: 8, float64: 8
    };

    function plyReadValue(dv, off, type)
    {
        switch (type)
        {
            case 'char': case 'int8': return dv.getInt8(off);
            case 'uchar': case 'uint8': return dv.getUint8(off);
            case 'short': case 'int16': return dv.getInt16(off, true);
            case 'ushort': case 'uint16': return dv.getUint16(off, true);
            case 'int': case 'int32': return dv.getInt32(off, true);
            case 'uint': case 'uint32': return dv.getUint32(off, true);
            case 'float': case 'float32': return dv.getFloat32(off, true);
            case 'double': case 'float64': return dv.getFloat64(off, true);
            default: return 0;
        }
    }

    function parsePlyHeader(text)
    {
        var lines = text.split('\n');
        var format = null;
        var elements = [];
        var current = null;

        for (var i = 0; i < lines.length; i++)
        {
            var t = lines[i].trim();
            if (t.length === 0 || t.charAt(0) === '#')
            {
                continue;
            }
            var tok = t.split(/\s+/);
            if (tok[0] === 'format')
            {
                format = tok[1];
            }
            else if (tok[0] === 'element')
            {
                current = { name: tok[1], count: parseInt(tok[2], 10), props: [] };
                elements.push(current);
            }
            else if (tok[0] === 'property' && current)
            {
                if (tok[1] === 'list')
                {
                    current.props.push({
                        list: true,
                        countType: tok[2],
                        type: tok[3],
                        name: tok[4]
                    });
                }
                else
                {
                    current.props.push({
                        list: false,
                        type: tok[1],
                        name: tok[2]
                    });
                }
            }
            else if (tok[0] === 'end_header')
            {
                break;
            }
        }
        return { format: format, elements: elements };
    }

    async function parsePLY(file, opts, onProgress)
    {
        var headerLimit = Math.min(file.size, 256 * 1024);
        var headBuf = await readSlice(file, 0, headerLimit);
        var headText = new TextDecoder('utf-8').decode(headBuf);

        var endPos = headText.indexOf('end_header');
        if (endPos < 0)
        {
            throw new Error('PLY 头缺少 end_header');
        }
        var nl = headText.indexOf('\n', endPos);
        if (nl < 0)
        {
            nl = headText.length;
        }
        var headerStr = headText.substring(0, nl + 1);
        var dataStart = new TextEncoder().encode(headerStr).length;

        var head = parsePlyHeader(headerStr);
        var vElem = null;
        var fElem = null;
        for (var i = 0; i < head.elements.length; i++)
        {
            if (head.elements[i].name === 'vertex') { vElem = head.elements[i]; }
            if (head.elements[i].name === 'face') { fElem = head.elements[i]; }
        }
        if (!vElem)
        {
            throw new Error('PLY 中没有 vertex 元素');
        }

        if (head.format === 'ascii')
        {
            return parsePLYAscii(file, dataStart, vElem, fElem, opts, onProgress);
        }
        return parsePLYBinary(file, dataStart, vElem, fElem, head.format, opts, onProgress);
    }

    async function parsePLYBinary(file, dataStart, vElem, fElem, format, opts, onProgress)
    {
        var little = (format !== 'binary_big_endian');
        var maxTri = opts.maxTriangles || DEFAULT_MAX_TRIANGLES;

        // 顶点属性偏移
        var vNames = {};
        var vOff = 0;
        var stride = 0;
        for (var i = 0; i < vElem.props.length; i++)
        {
            var p = vElem.props[i];
            vNames[p.name] = { off: vOff, type: p.type };
            vOff += PLY_TYPES[p.type] || 4;
        }
        stride = vOff;

        var bodySize = file.size - dataStart;
        var totalV = vElem.count;

        var bbox = global.MV.math.BBox.empty();
        var verts = new Float32Array(totalV * 3);
        var normals = null;
        var colors = null;

        var hasN = vNames.nx && vNames.ny && vNames.nz;
        var hasC = vNames.red && vNames.green && vNames.blue;
        if (hasN) { normals = new Float32Array(totalV * 3); }
        if (hasC) { colors = new Float32Array(totalV * 3); }

        var vBuf = await readSlice(file, dataStart, dataStart + totalV * stride);
        var dv = new DataView(vBuf);

        for (var vi = 0; vi < totalV; vi++)
        {
            var base = vi * stride;
            var x = plyReadValue(dv, base + vNames.x.off, vNames.x.type);
            var y = plyReadValue(dv, base + vNames.y.off, vNames.y.type);
            var z = plyReadValue(dv, base + vNames.z.off, vNames.z.type);

            verts[vi * 3] = x;
            verts[vi * 3 + 1] = y;
            verts[vi * 3 + 2] = z;

            if (x < bbox.min[0]) { bbox.min[0] = x; }
            if (y < bbox.min[1]) { bbox.min[1] = y; }
            if (z < bbox.min[2]) { bbox.min[2] = z; }
            if (x > bbox.max[0]) { bbox.max[0] = x; }
            if (y > bbox.max[1]) { bbox.max[1] = y; }
            if (z > bbox.max[2]) { bbox.max[2] = z; }

            if (hasN)
            {
                normals[vi * 3] = plyReadValue(dv, base + vNames.nx.off, vNames.nx.type);
                normals[vi * 3 + 1] = plyReadValue(dv, base + vNames.ny.off, vNames.ny.type);
                normals[vi * 3 + 2] = plyReadValue(dv, base + vNames.nz.off, vNames.nz.type);
            }
            if (hasC)
            {
                var r = plyReadValue(dv, base + vNames.red.off, vNames.red.type);
                var g = plyReadValue(dv, base + vNames.green.off, vNames.green.type);
                var b = plyReadValue(dv, base + vNames.blue.off, vNames.blue.type);
                if (r > 1.0 || g > 1.0 || b > 1.0)
                {
                    r /= 255; g /= 255; b /= 255;
                }
                colors[vi * 3] = r;
                colors[vi * 3 + 1] = g;
                colors[vi * 3 + 2] = b;
            }
        }

        if (onProgress)
        {
            await onProgress(0.5, 'PLY 顶点读取完成');
        }

        // 面无数据（点云）则直接返回点
        if (!fElem || fElem.count === 0)
        {
            return {
                kind: 'points',
                positions: verts,
                count: totalV,
                normals: normals,
                colors: colors,
                tags: null,
                bbox: bbox,
                format: 'PLY(binary)',
                truncated: false,
                totalSource: totalV,
                note: ''
            };
        }

        var faceBuf = await readSlice(file, dataStart + totalV * stride, file.size);
        var fdv = new DataView(faceBuf);
        var off = 0;

        var idxList = fElem.props.filter(function (p) { return p.list; });
        var otherProps = fElem.props.filter(function (p) { return !p.list; });
        var faceStrideOther = 0;
        for (var oi = 0; oi < otherProps.length; oi++)
        {
            faceStrideOther += PLY_TYPES[otherProps[oi].type] || 4;
        }
        var listProp = idxList.length > 0 ? idxList[0] : null;

        var maxFace = Math.min(fElem.count, Math.ceil(maxTri / 2) + fElem.count);
        var outPos = new Float32Array(Math.min(fElem.count * 9, maxTri * 9));
        var w = 0;
        var tri = 0;
        var stop = false;

        for (var fi = 0; fi < fElem.count && !stop; fi++)
        {
            var cnt = 0;
            if (listProp)
            {
                cnt = plyReadValue(fdv, off, listProp.countType);
                off += PLY_TYPES[listProp.countType] || 1;
            }

            var i0 = 0, i1 = 0, i2 = 0;
            for (var k = 0; k < cnt; k++)
            {
                var idx = plyReadValue(fdv, off, listProp ? listProp.type : 'int');
                off += PLY_TYPES[listProp ? listProp.type : 'int'] || 4;
                if (k === 0) { i0 = idx; }
                else if (k === 1) { i1 = idx; }
                else if (k === 2) { i2 = idx; }
                if (k >= 2)
                {
                    if (tri >= maxTri || w + 9 > outPos.length)
                    {
                        stop = true;
                        break;
                    }
                    outPos[w++] = verts[i0 * 3];
                    outPos[w++] = verts[i0 * 3 + 1];
                    outPos[w++] = verts[i0 * 3 + 2];
                    outPos[w++] = verts[i1 * 3];
                    outPos[w++] = verts[i1 * 3 + 1];
                    outPos[w++] = verts[i1 * 3 + 2];
                    outPos[w++] = verts[i2 * 3];
                    outPos[w++] = verts[i2 * 3 + 1];
                    outPos[w++] = verts[i2 * 3 + 2];
                    tri++;
                    i1 = i2;
                }
            }
            off += faceStrideOther;
        }

        return {
            kind: 'mesh',
            positions: outPos.subarray(0, w),
            count: tri,
            bbox: bbox,
            format: 'PLY(binary)',
            truncated: stop,
            totalSource: fElem.count,
            note: stop ? ('仅载入前 ' + tri + ' 个三角形') : ''
        };
    }

    async function parsePLYAscii(file, dataStart, vElem, fElem, opts, onProgress)
    {
        var maxTri = opts.maxTriangles || DEFAULT_MAX_TRIANGLES;
        var numBuf = new Float64Array(16);
        var verts = new Float32Array(vElem.count * 3);
        var bbox = global.MV.math.BBox.empty();
        var vnames = vElem.props.map(function (p) { return p.name; });
        var ix = vnames.indexOf('x'), iy = vnames.indexOf('y'), iz = vnames.indexOf('z');
        var seen = 0;
        var inFace = 0;
        var tri = 0;
        var out = new F32Accum(1 << 18);
        var full = false;

        await forEachLine(file, function (lines)
        {
            for (var li = 0; li < lines.length && !full; li++)
            {
                var t = lines[li].trim();
                if (t.length === 0 || t.charAt(0) === '#')
                {
                    continue;
                }
                if (seen < vElem.count)
                {
                    var n = scanNumbers(t, numBuf);
                    if (n >= 3)
                    {
                        var x = numBuf[ix], y = numBuf[iy], z = numBuf[iz];
                        verts[seen * 3] = x;
                        verts[seen * 3 + 1] = y;
                        verts[seen * 3 + 2] = z;
                        if (x < bbox.min[0]) { bbox.min[0] = x; }
                        if (y < bbox.min[1]) { bbox.min[1] = y; }
                        if (z < bbox.min[2]) { bbox.min[2] = z; }
                        if (x > bbox.max[0]) { bbox.max[0] = x; }
                        if (y > bbox.max[1]) { bbox.max[1] = y; }
                        if (z > bbox.max[2]) { bbox.max[2] = z; }
                    }
                    seen++;
                }
                else if (fElem && inFace < fElem.count)
                {
                    var m = scanNumbers(t, numBuf);
                    if (m >= 4)
                    {
                        var c = numBuf[0];
                        for (var k = 1; k + 1 <= c; k++)
                        {
                            if (tri >= maxTri)
                            {
                                full = true;
                                break;
                            }
                            var a = numBuf[1], b = numBuf[k], d = numBuf[k + 1];
                            out.push3(verts[a * 3], verts[a * 3 + 1], verts[a * 3 + 2]);
                            out.push3(verts[b * 3], verts[b * 3 + 1], verts[b * 3 + 2]);
                            out.push3(verts[d * 3], verts[d * 3 + 1], verts[d * 3 + 2]);
                            tri++;
                        }
                    }
                    inFace++;
                }
            }
        }, async function (f)
        {
            if (onProgress)
            {
                await onProgress(f, 'PLY(ascii) 读取 ' + Math.round(f * 100) + '%');
            }
        }, dataStart);

        return {
            kind: 'mesh',
            positions: out.result(),
            count: tri,
            bbox: bbox,
            format: 'PLY(ascii)',
            truncated: full,
            totalSource: inFace,
            note: full ? ('仅载入前 ' + tri + ' 个三角形') : ''
        };
    }

    /* ---------------- 点云文本 ---------------- */
    var POINT_COL_MAX = 32;
    var POINT_SF_MAX = 8;

    function normColName(s)
    {
        return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function parseHeaderNames(line)
    {
        var t = line.trim();
        var ok = false;
        if (t.substring(0, 2) === '//')
        {
            t = t.substring(2);
            ok = true;
        }
        else if (t.charAt(0) === '#' || t.charAt(0) === ';')
        {
            t = t.substring(1);
            ok = true;
        }
        if (!ok)
        {
            return null;
        }

        var parts = t.split(/[\s,;|\t]+/);
        var out = [];
        for (var i = 0; i < parts.length; i++)
        {
            if (parts[i].length > 0)
            {
                out.push(parts[i]);
            }
        }
        return out.length >= 3 ? out : null;
    }

    function isUnitVector(a, b, c)
    {
        var l2 = a * a + b * b + c * c;
        return l2 > 0.5 && l2 < 1.6 &&
            Math.abs(a) <= 1.001 && Math.abs(b) <= 1.001 && Math.abs(c) <= 1.001;
    }

    function isColor255(a, b, c)
    {
        return a >= 0 && a <= 255 && b >= 0 && b <= 255 && c >= 0 && c <= 255 &&
            Math.floor(a) === a && Math.floor(b) === b && Math.floor(c) === c;
    }

    /* 读取文件头部，探测列数 / 列名 / 首个数据行样例（供列含义确认对话框使用） */
    async function probeTextColumns(file)
    {
        var size = Math.min(file.size, 128 * 1024);
        var buf = await readSlice(file, 0, size);
        var text = new TextDecoder('utf-8').decode(buf);
        var lines = text.split('\n');
        var names = null;
        var sample = null;
        var width = 0;
        var numBuf = new Float64Array(POINT_COL_MAX);

        for (var i = 0; i < lines.length; i++)
        {
            var t = lines[i].replace(/\r$/, '');
            if (t.length === 0)
            {
                continue;
            }
            var c0 = t.charCodeAt(0);
            if (c0 === 35 || c0 === 59 || (c0 === 47 && t.charCodeAt(1) === 47))
            {
                if (!names)
                {
                    names = parseHeaderNames(t);
                }
                continue;
            }

            var n = scanNumbers(t, numBuf);
            if (n < 3)
            {
                if (!names && n === 0 && /[a-z]/i.test(t))
                {
                    var hm = t.trim().split(/[\s,;|\t]+/);
                    if (hm.length >= 3)
                    {
                        names = hm;
                    }
                }
                continue;
            }

            width = n;
            sample = [];
            for (var k = 0; k < n; k++)
            {
                sample.push(numBuf[k]);
            }
            break;
        }

        if (width < 3)
        {
            return null;
        }
        return { width: width, names: names, sample: sample };
    }

    async function parsePointText(file, opts, onProgress, planOverride)
    {
        var maxPoints = opts.maxPoints || DEFAULT_MAX_POINTS;
        var numBuf = new Float64Array(POINT_COL_MAX);

        // 等间隔抽样：按行号每 pstep 行取 1 行（空间均匀，而不是只保留前 N 个）
        var pstep = 1;
        if (maxPoints > 0 && isFinite(maxPoints))
        {
            var estTotal = Math.max(1, Math.round(file.size / 40));
            pstep = Math.max(1, Math.ceil(estTotal / maxPoints));
        }
        var lineNo = 0;

        var pos = new F32Accum(1 << 20);
        var nrm = new F32Accum(1 << 18);
        var tags = new F32Accum(1 << 16);
        var cols = new F32Accum(1 << 16);
        var sfAccums = [];
        var sfMin = [];
        var sfMax = [];

        var headerNames = null;
        var plan = null;
        var colorDiv = 1;
        var count = 0;
        var full = false;
        var bbox = global.MV.math.BBox.empty();

        function findIdx(map, keys)
        {
            for (var i = 0; i < keys.length; i++)
            {
                if (map[keys[i]] !== undefined)
                {
                    return map[keys[i]];
                }
            }
            return -1;
        }

        function buildPlan(width)
        {
            var p = { normal: null, color: null, tag: -1, sf: [] };

            if (headerNames)
            {
                var names = headerNames.slice();
                // 列名可能含空格（如 CloudCompare 的 "Scalar field"），把多余项合并到最后一列
                if (names.length > width)
                {
                    names[width - 1] = names.slice(width - 1).join(' ');
                    names.length = width;
                }

                if (names.length === width)
                {
                    var map = {};
                    for (var i = 0; i < names.length; i++)
                    {
                        map[normColName(names[i])] = i;
                    }

                    var nx = findIdx(map, ['nx', 'normalx']);
                    var ny = findIdx(map, ['ny', 'normaly']);
                    var nz = findIdx(map, ['nz', 'normalz']);
                    var cr = findIdx(map, ['r', 'red']);
                    var cg = findIdx(map, ['g', 'green']);
                    var cb = findIdx(map, ['b', 'blue']);
                    var tg = findIdx(map, ['label', 'id', 'tag', 'class', 'hid', 'index']);

                    var used = { 0: 1, 1: 1, 2: 1 };
                    if (nx >= 0 && ny >= 0 && nz >= 0)
                    {
                        p.normal = [nx, ny, nz];
                        used[nx] = used[ny] = used[nz] = 1;
                    }
                    if (cr >= 0 && cg >= 0 && cb >= 0)
                    {
                        p.color = [cr, cg, cb];
                        used[cr] = used[cg] = used[cb] = 1;
                        colorDiv = 255;
                    }
                    if (tg >= 0)
                    {
                        p.tag = tg;
                        used[tg] = 1;
                    }
                    for (var k = 0; k < names.length && p.sf.length < POINT_SF_MAX; k++)
                    {
                        if (used[k])
                        {
                            continue;
                        }
                        p.sf.push({ i: k, name: names[k] });
                    }
                    return p;
                }
            }

            // 无表头：按列数启发式（兼容 3 / 4 / 6 列以及 x y z + 标量场）
            if (width >= 6)
            {
                if (isUnitVector(numBuf[3], numBuf[4], numBuf[5]))
                {
                    p.normal = [3, 4, 5];
                }
                else if (isColor255(numBuf[3], numBuf[4], numBuf[5]))
                {
                    p.color = [3, 4, 5];
                    colorDiv = 255;
                }

                var start = (p.normal || p.color) ? 6 : 3;
                for (var s = start; s < width && p.sf.length < POINT_SF_MAX; s++)
                {
                    p.sf.push({ i: s, name: 'SF' + (p.sf.length + 1) });
                }
            }
            else if (width === 4)
            {
                p.tag = 3;
                p.sf.push({ i: 3, name: 'SF1' });
            }
            else if (width === 5)
            {
                p.sf.push({ i: 3, name: 'SF1' });
                p.sf.push({ i: 4, name: 'SF2' });
            }
            return p;
        }

        await forEachLine(file, function (lines)
        {
            for (var li = 0; li < lines.length; li++)
            {
                if (full)
                {
                    return;
                }
                var t = lines[li];
                if (t.length === 0)
                {
                    continue;
                }

                var c0 = t.charCodeAt(0);
                if (c0 === 35 || c0 === 59 || (c0 === 47 && t.charCodeAt(1) === 47))
                {
                    if (!headerNames && count === 0)
                    {
                        headerNames = parseHeaderNames(t);
                    }
                    continue;
                }

                var n = scanNumbers(t, numBuf);
                if (n < 3)
                {
                    // 无注释前缀的纯文本列名行
                    if (count === 0 && !headerNames && n === 0 && /[a-z]/i.test(t))
                    {
                        var hm = t.trim().split(/[\s,;|\t]+/);
                        if (hm.length >= 3)
                        {
                            headerNames = hm;
                        }
                    }
                    continue;
                }

                if (!plan)
                {
                    plan = planOverride || buildPlan(n);
                    for (var pi = 0; pi < plan.sf.length; pi++)
                    {
                        sfAccums.push(new F32Accum(1 << 16));
                        sfMin.push(Infinity);
                        sfMax.push(-Infinity);
                    }
                }

                lineNo++;
                if (pstep > 1 && (lineNo % pstep) !== 0)
                {
                    continue;   // 抽样跳过
                }

                var x = numBuf[0], y = numBuf[1], z = numBuf[2];
                pos.push3(x, y, z);
                count++;

                if (x < bbox.min[0]) { bbox.min[0] = x; }
                if (y < bbox.min[1]) { bbox.min[1] = y; }
                if (z < bbox.min[2]) { bbox.min[2] = z; }
                if (x > bbox.max[0]) { bbox.max[0] = x; }
                if (y > bbox.max[1]) { bbox.max[1] = y; }
                if (z > bbox.max[2]) { bbox.max[2] = z; }

                if (plan.normal)
                {
                    nrm.push3(numBuf[plan.normal[0]], numBuf[plan.normal[1]], numBuf[plan.normal[2]]);
                }
                if (plan.color)
                {
                    var cr2 = numBuf[plan.color[0]];
                    var cg2 = numBuf[plan.color[1]];
                    var cb2 = numBuf[plan.color[2]];
                    if (colorDiv === 1 && (cr2 > 1.5 || cg2 > 1.5 || cb2 > 1.5))
                    {
                        colorDiv = 255;
                    }
                    cols.push3(cr2 / colorDiv, cg2 / colorDiv, cb2 / colorDiv);
                }
                if (plan.tag >= 0 && !(plan.sf.length > 0 && plan.sf[0].i === plan.tag))
                {
                    tags.push(numBuf[plan.tag]);
                }
                for (var si = 0; si < plan.sf.length; si++)
                {
                    var sv = numBuf[plan.sf[si].i];
                    sfAccums[si].push(sv);
                    if (sv < sfMin[si]) { sfMin[si] = sv; }
                    if (sv > sfMax[si]) { sfMax[si] = sv; }
                }

                if (count >= maxPoints)
                {
                    full = true;
                    return;
                }
            }
        }, async function (f)
        {
            if (onProgress)
            {
                await onProgress(f, '点云读取 ' + Math.round(f * 100) + '%');
            }
        });

        var scalars = null;
        if (sfAccums.length > 0 && plan)
        {
            scalars = [];
            for (var si2 = 0; si2 < sfAccums.length; si2++)
            {
                scalars.push({
                    name: plan.sf[si2] ? plan.sf[si2].name : ('SF' + (si2 + 1)),
                    values: sfAccums[si2].result(),
                    min: isFinite(sfMin[si2]) ? sfMin[si2] : 0,
                    max: isFinite(sfMax[si2]) ? sfMax[si2] : 1
                });
            }
        }

        var tagArr = null;
        if (plan && plan.tag >= 0)
        {
            tagArr = (plan.sf.length > 0 && plan.sf[0].i === plan.tag) ? scalars[0].values : tags.result();
        }

        var extras = [];
        if (plan && plan.normal) { extras.push('法向'); }
        if (plan && plan.color) { extras.push('颜色'); }
        if (tagArr) { extras.push('标签'); }
        if (scalars)
        {
            var names = [];
            for (var ni = 0; ni < scalars.length; ni++)
            {
                names.push(scalars[ni].name);
            }
            extras.push('标量场 ' + names.join(', '));
        }

        var note = '';
        if (full)
        {
            note = '仅载入前 ' + count + ' 个点';
        }
        else if (extras.length > 0)
        {
            note = extras.join(' · ');
        }

        return {
            kind: 'points',
            positions: pos.result(),
            count: count,
            normals: (plan && plan.normal) ? nrm.result() : null,
            tags: tagArr,
            colors: (plan && plan.color) ? cols.result() : null,
            scalars: scalars,
            bbox: bbox,
            format: 'POINTS(text)',
            truncated: full,
            totalSource: count,
            note: note
        };
    }

    /* ---------------- 入口 ---------------- */

    async function detectKind(file)
    {
        var ext = extOf(file.name);
        if (ext === 'stl') { return 'stl'; }
        if (ext === 'obj') { return 'obj'; }
        if (ext === 'ply') { return 'ply'; }
        if (ext === 'txt' || ext === 'xyz' || ext === 'csv' || ext === 'asc' ||
            ext === 'pts' || ext === 'dat' || ext === 'ptx')
        {
            return 'points';
        }

        // 无扩展名：读取头部嗅探
        var buf = await readSlice(file, 0, Math.min(file.size, 64));
        var dv = new DataView(buf);
        if (file.size >= 84)
        {
            var n = dv.getUint32(80, true);
            if (n > 0 && Math.abs(84 + n * 50 - file.size) <= 64)
            {
                return 'stl';
            }
        }
        var txt = new TextDecoder('utf-8').decode(buf).trim().toLowerCase();
        if (txt.indexOf('ply') === 0) { return 'ply'; }
        if (txt.indexOf('solid') === 0) { return 'stl'; }
        return 'obj';
    }

    async function loadFile(file, opts, onProgress, confirmColumns)
    {
        var o = opts || {};
        var kind = await detectKind(file);
        var res;

        if (kind === 'stl') { res = await parseSTL(file, o, onProgress); }
        else if (kind === 'obj') { res = await parseOBJ(file, o, onProgress); }
        else if (kind === 'ply') { res = await parsePLY(file, o, onProgress); }
        else
        {
            var plan = null;
            var probe = await probeTextColumns(file);

            // 列数 > 3 时让用户确认各列含义（前三列固定为 X/Y/Z）
            if (probe && probe.width > 3 && typeof confirmColumns === 'function')
            {
                plan = await confirmColumns(probe);
                if (!plan)
                {
                    return null;
                }
            }
            res = await parsePointText(file, o, onProgress, plan);
        }

        if (!res || !res.positions || res.positions.length === 0)
        {
            if (!res)
            {
                return null;
            }
            throw new Error('文件中没有可显示的数据');
        }
        res.fileSize = file.size;
        return res;
    }

    global.MV.loaders = {
        loadFile: loadFile,
        extOf: extOf,
        DEFAULT_MAX_TRIANGLES: DEFAULT_MAX_TRIANGLES,
        DEFAULT_MAX_POINTS: DEFAULT_MAX_POINTS
    };

    })();

    /* ==================== 孔位优化调用（原 optimize.js） ==================== */
    (function ()
    {
    // ===== 功能开关：改 false 或整段注释即可一键关闭 =====
    var ENABLE_OPTIMIZE = true;
    if (!ENABLE_OPTIMIZE)
    {
        return;
    }

    // 同源优先：通过 serve.bat / serve.py 打开时（http），/optimize 与页面同源，
    // 只要页面能打开，优化服务一定在；file:// 打开时退回独立桥接服务 8790。
    var IS_HTTP = /^https?:$/i.test(global.location.protocol);
    var BASE = IS_HTTP ? '' : 'http://127.0.0.1:8790';
    var ENDPOINT = BASE + '/optimize';
    var HEALTH = BASE + '/health';

    function $id(id)
    {
        return document.getElementById(id);
    }

    function say(msg)
    {
        hooks.notify(msg);
    }

    function showError(title, detail)
    {
        var dlg = $id('errdlg');
        if (!dlg)
        {
            global.alert(title + '\n\n' + detail);
            return;
        }
        $id('err-title').textContent = title;
        $id('err-text').textContent = detail;
        dlg.classList.remove('hidden');
    }

    async function checkHealth()
    {
        var ctrl = new global.AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 2000);
        try
        {
            var resp = await global.fetch(HEALTH, { signal: ctrl.signal, cache: 'no-store' });
            return await resp.json();
        }
        finally
        {
            clearTimeout(timer);
        }
    }

    // 输入 = 当前显示的网格里“最新启用/载入”的那一个（不看选中项，避免误用已隐藏或旧图层）
    // 优先非优化产物：避免连续点击时把上一次的 *_oh.obj 再优化成 *_oh_oh.obj
    function findMeshLayer()
    {
        var app = global.MV.app;
        var best = null;
        var result = null;

        for (var i = 0; i < app.layers.length; i++)
        {
            var l = app.layers[i];
            if (l.kind !== 'mesh' || !l.visible || !l.sourceFile)
            {
                continue;
            }
            if (l.isResult)
            {
                if (!result || (l.shownAt || 0) >= (result.shownAt || 0))
                {
                    result = l;
                }
                continue;
            }
            if (!best || (l.shownAt || 0) >= (best.shownAt || 0))
            {
                best = l;
            }
        }
        return best || result;
    }

    function findEdgeFile()
    {
        // 同批拖入的 edge_pts.txt 优先；否则由服务端按文件名在 data 下自动查找
        var layers = global.MV.app.layers;
        for (var i = layers.length - 1; i >= 0; i--)
        {
            var l = layers[i];
            if (l.kind === 'points' && l.sourceFile && /edge_pts/i.test(l.sourceFile.name))
            {
                return l.sourceFile;
            }
        }
        return null;
    }

    var running = false;

    async function run()
    {
        if (running)
        {
            return;
        }

        var layer = findMeshLayer();
        if (!layer)
        {
            say('当前没有显示的网格');
            showError('没有可优化的网格',
                '当前没有处于显示状态（勾选）的网格。\n\n' +
                '请先在场景树里勾选一个 STL / OBJ 网格，或在左侧导入一个，再点击「孔位优化」。\n\n' +
                '提示：需要配套的 edge_pts.txt（边界点云），可一起拖入，\n' +
                '或把网格放在 HoleOptimize/data/<数据集>/ 下（同目录含 edge_pts.txt）。');
            return;
        }

        running = true;
        var btn = $id('btn-optimize');
        if (btn)
        {
            btn.disabled = true;
            btn.textContent = '优化中…';
        }

        function resetBtn()
        {
            running = false;
            if (btn)
            {
                btn.disabled = false;
                btn.textContent = '孔位优化';
            }
        }

        // 0) 先确认 bridge 在线、exe 存在，避免只抛出含糊的 "Failed to fetch"
        var health = null;
        try
        {
            health = await checkHealth();
        }
        catch (e)
        {
            resetBtn();
            say('优化失败：本地服务未运行');
            var tip;
            if (IS_HTTP)
            {
                tip = '优化接口不可达。通常是 serve.bat 的控制台窗口已被关闭：\n\n' +
                    '重新双击  viewer3d\\serve.bat  即可（页面与优化接口在同一个服务里）。\n\n' +
                    '若反复失败，请查看 serve 窗口中的 Python 报错。';
            }
            else
            {
                tip = '当前是直接双击 index.html（file://）打开的。\n\n' +
                    '浏览器安全模型不允许网页启动本地程序，所以这一步必须由你触发一次：\n\n' +
                    '    双击  viewer3d\\serve.bat\n\n' +
                    '它会在 http://127.0.0.1:8765/ 打开同一页面，并且页面与优化接口同源，\n' +
                    '之后点「孔位优化」不再需要任何额外步骤。\n\n' +
                    '（也可只双击 bridge\\start_bridge.bat，仅启动优化服务）';
            }
            showError('无法连接优化服务', tip);
            return;
        }

        if (health && health.exists === false)
        {
            resetBtn();
            say('优化失败：找不到 HoleOptimize_cli.exe');
            showError('找不到 HoleOptimize_cli.exe',
                '服务端使用的路径：\n  ' + (health.exe || '(未知)') + '\n\n' +
                '请先构建 C++ 程序：\n' +
                '  cd HoleOptimize\n' +
                '  cmake --build build --config Release --parallel\n\n' +
                '构建后重启 start_bridge.bat；\n' +
                '也可用环境变量 HOLEOPT_EXE 指定 exe 路径。');
            return;
        }

        say('正在优化：' + layer.name + (layer.isResult ? '（结果图层）' : '') + ' …');

        try
        {
            var fd = new global.FormData();
            fd.append('mesh', layer.sourceFile, layer.sourceFile.name);

            var edge = findEdgeFile();
            if (edge)
            {
                fd.append('edge', edge, edge.name);
            }

            var resp = await global.fetch(ENDPOINT, {
                method: 'POST',
                body: fd,
                headers: { 'X-Mesh-Name': encodeURIComponent(layer.sourceFile.name) }
            });

            if (!resp.ok)
            {
                var txt = await resp.text();
                var obj = null;
                try
                {
                    obj = JSON.parse(txt);
                }
                catch (e)
                {
                    obj = null;
                }

                var brief = (obj && obj.error) || txt || ('HTTP ' + resp.status);
                var detail = brief;
                if (obj && obj.trace)
                {
                    detail += '\n\n--- 服务端堆栈 ---\n' + obj.trace;
                }
                if (obj && obj.log)
                {
                    detail += '\n\n日志文件：' + obj.log;
                }

                var httpErr = new Error(detail);
                httpErr.brief = String(brief).split('\n')[0];
                throw httpErr;
            }

            var blob = await resp.blob();
            var name = decodeURIComponent(resp.headers.get('X-Result-Name') || '') || 'result_oh.obj';
            var file = new global.File([blob], name, { type: 'application/octet-stream' });

            await global.MV.app.addFiles([file], 'B');

            // 标记为“优化产物”：下次点击优先选原始网格，避免 _oh -> _oh_oh
            var layers = global.MV.app.layers;
            for (var li = layers.length - 1; li >= 0; li--)
            {
                if (layers[li].sourceFile === file)
                {
                    layers[li].isResult = true;
                    layers[li].parentId = layer.id;   // 结果挂到被优化的源图层下
                    break;
                }
            }

            say('优化完成，已自动载入右侧：' + name);
        }
        catch (err)
        {
            if (global.console)
            {
                global.console.error('[optimize]', err);
            }
            showError('孔位优化失败', err.message || String(err));
            say('优化失败：' + (err.brief || String(err.message || err).split('\n')[0]));
        }
        finally
        {
            resetBtn();
        }
    }

    // 便于调试/自动化：带 ?runoptimize=1 时，左侧载入完成后自动执行一次
    function autoRunIfRequested()
    {
        var cfg = global.MV.config || {};
        if (!cfg.runOptimize)
        {
            return;
        }

        var fired = false;
        function attempt()
        {
            if (fired || !findMeshLayer())
            {
                return;
            }
            fired = true;
            run();
        }

        global.addEventListener('mv:loaded', attempt);
        attempt();                       // ?url= 可能在监听前就已加载完成
        setTimeout(attempt, 3000);       // 兜底
    }

    window.addEventListener('load', function ()
    {
        var btn = $id('btn-optimize');
        if (btn)
        {
            btn.addEventListener('click', run);
        }

        var errClose = $id('err-close');
        if (errClose)
        {
            errClose.addEventListener('click', function ()
            {
                var dlg = $id('errdlg');
                if (dlg)
                {
                    dlg.classList.add('hidden');
                }
            });
        }

        autoRunIfRequested();
    });

    global.MV.ioBindHooks = bindHooks;
    global.MV.optimize = { run: run, enabled: ENABLE_OPTIMIZE };
    })();

    /* ==================== 载入前规模估算与下采样（原 memguard.js） ==================== */
    (function ()
    {
    var MB = 1024 * 1024;
    var MIN_BUDGET = 512 * MB;
    var MAX_BUDGET = 2500 * MB;

    // 每单位数据的字节数（positions 为主，另加解析中间开销的系数）
    var BYTES_PER_TRI = 9 * 4;      // 3 顶点 × 3 float
    var BYTES_PER_POINT = 3 * 4;    // 1 顶点 × 3 float
    var OVERHEAD = 1.7;             // 解析中间数组 / 上传副本 / 索引缓冲

    function fmtBytes(n)
    {
        if (!(n > 0)) { return '0 B'; }
        var u = ['B', 'KB', 'MB', 'GB'];
        var i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return n.toFixed(i === 0 ? 0 : (n < 10 ? 2 : 1)) + ' ' + u[i];
    }

    function budget()
    {
        var cfg = global.MV.config || {};
        if (cfg.memlimit > 0) { return cfg.memlimit * MB; }

        var limit = 0;
        try
        {
            if (global.performance && global.performance.memory &&
                global.performance.memory.jsHeapSizeLimit)
            {
                limit = global.performance.memory.jsHeapSizeLimit * 0.25;
            }
        }
        catch (e) { /* ignore */ }

        if (!(limit > 0))
        {
            var gb = (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory > 0)
                ? navigator.deviceMemory : 8;
            limit = gb * 1024 * MB * 0.12;
        }
        return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, limit));
    }

    /* 规模估算：{ kind, count, bytes, note } */
    function estimate(file)
    {
        var size = file.size || 0;
        var ext = extOf(file.name);
        var count = 0;
        var kind = 'points';
        var note = '按文件大小估算';

        if (ext === 'stl')
        {
            kind = 'mesh';
            var n = Math.floor((size - 84) / 50);
            if (n > 0 && Math.abs(84 + n * 50 - size) <= 64)
            {
                count = n;
                note = '按 STL 头部精确读取';
            }
            else
            {
                count = Math.floor(size / 200);
                note = '按 ASCII STL 行数估算';
            }
        }
        else if (ext === 'obj')
        {
            kind = 'mesh';
            count = Math.floor(size / 120);
        }
        else if (ext === 'ply')
        {
            kind = 'mesh';                 // 保守按 mesh 估（字节/面更大）
            count = Math.floor(size / 60);
        }
        else
        {
            kind = 'points';
            count = Math.floor(size / 40); // 每行 ~40 字节
        }

        var per = (kind === 'mesh') ? BYTES_PER_TRI : BYTES_PER_POINT;
        return {
            kind: kind,
            count: count,
            bytes: Math.round(count * per * OVERHEAD),
            note: note,
            size: size
        };
    }

    /* 弹窗：返回 Promise<{mode:'sample'|'full'|'cancel', pct}> */
    /* 纯计算：把弹窗的选择翻译成载入参数（不涉及 DOM） */
    function decide(ans, est, limit)
    {
        if (!ans || ans.mode === 'cancel')
        {
            return { opts: {}, cancel: true, est: est, limit: limit };
        }
        if (ans.mode === 'full')
        {
            return { opts: {}, cancel: false, est: est, limit: limit, forced: true };
        }

        var pct = Math.max(1, Math.min(100, ans.pct || 100));
        var cap = Math.max(1, Math.floor(est.count * pct / 100));
        var opts = {};
        if (est.kind === 'mesh')
        {
            opts.maxTriangles = cap;
        }
        else
        {
            opts.maxPoints = cap;
        }
        return { opts: opts, cancel: false, est: est, limit: limit, pct: pct };
    }

    global.MV.memguard = {
        estimate: estimate,
        decide: decide,
        budget: budget,
        fmtBytes: fmtBytes
    };
    })();

})(window);