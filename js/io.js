/* L2 IO 层 | io：数据进出
 * 允许依赖：core（MV.math）
 * 禁止依赖：render / GL
 * 导出：MV.loaders / MV.memguard
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

        // 小文件一次读入：file.slice 每次都要走一遍 Blob 复制，
        // 20000 三角形一块对几 MB 的 STL 纯属浪费，还会带来多次 yieldToUI 的调度开销。
        // 大文件保持分块，控制内存峰值 + 保留进度反馈。
        var chunkTri = (file.size <= 8 * 1024 * 1024) ? Math.max(20000, total) : 20000;
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
        /* 8 个槽：v 行可能是 x y z r g b（带顶点色的 OBJ） */
        var numBuf = new Float64Array(8);
        var idxBuf = new Int32Array(64);
        var triCount = 0;
        var srcTri = 0;
        var vcount = 0;
        /* 顶点色：懒分配，只有真的出现 6 列 v 行时才占内存 */
        var vcolors = null;
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

                        /* v x y z r g b —— 有的导出器把顶点色写在坐标后面。
                         * 混合出现时补白，保证颜色索引与顶点索引一一对应。 */
                        if (n >= 6)
                        {
                            if (!vcolors) { vcolors = new F32Accum(1 << 20); }
                            var cr = numBuf[3], cg = numBuf[4], cb = numBuf[5];
                            if (cr > 1.0 || cg > 1.0 || cb > 1.0)
                            {
                                cr /= 255; cg /= 255; cb /= 255;
                            }
                            vcolors.push3(cr, cg, cb);
                        }
                        else if (vcolors)
                        {
                            vcolors.push3(1, 1, 1);
                        }
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

        /* 只有顶点、没有面（扫描点云常这么导出）→ 按点云返回。
         * 以前会返回 0 个三角形的网格，被下游判成"文件中没有可显示的数据"。 */
        if (triCount === 0 && vcount > 0)
        {
            return {
                kind: 'points',
                positions: verts.result(),
                count: vcount,
                colors: vcolors ? vcolors.result() : null,
                tags: null,
                bbox: bbox,
                format: 'OBJ',
                truncated: false,
                totalSource: vcount,
                note: ''
            };
        }

        var pos = new Float32Array(triCount * 9);
        var cdata = vcolors ? vcolors.data : null;
        var cols = vcolors ? new Float32Array(triCount * 9) : null;
        var w = 0;
        for (var i = 0; i < triCount * 3; i++)
        {
            var vi = fdata[i] * 3;
            pos[w] = vdata[vi];
            pos[w + 1] = vdata[vi + 1];
            pos[w + 2] = vdata[vi + 2];
            if (cols)
            {
                cols[w] = cdata[vi];
                cols[w + 1] = cdata[vi + 1];
                cols[w + 2] = cdata[vi + 2];
            }
            w += 3;
        }

        var objRes = {
            kind: 'mesh',
            positions: pos,
            count: triCount,
            bbox: bbox,
            format: 'OBJ',
            truncated: full,
            totalSource: srcTri,
            note: full ? ('仅载入前 ' + triCount + ' 个三角形') : ''
        };
        if (cols) { objRes.colors = cols; }
        return objRes;
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

        /* 三角形数上限按「索引个数」估，而不是「面数 × 9」——
         * 一个四边形面会扇形拆成 2 个三角形、五边形 3 个……
         * 早先按面数分配，四边形只会写出第 1 个三角形，其余被 stop 截断。
         * 索引数 = 面块字节数 / 单索引字节数（fan 的三角形数恒小于索引数）。 */
        var idxSize = PLY_TYPES[listProp ? listProp.type : 'int'] || 4;
        var faceBytes = Math.max(0, file.size - dataStart - totalV * stride);
        var idxCount = Math.floor(faceBytes / idxSize);
        var capTri = Math.max(1, Math.min(maxTri, idxCount));
        var outPos = new Float32Array(capTri * 9);
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
            totalSource: fElem ? fElem.count : totalV,
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

        /* 顶点色：规范里叫 red/green/blue；有些导出器写成 r/g/b，一并认。
         * 点云 PLY 绝大多数带颜色，不解析就等于把颜色丢了。 */
        var ir = vnames.indexOf('red'), ig = vnames.indexOf('green'), ib = vnames.indexOf('blue');
        if (ir < 0 || ig < 0 || ib < 0)
        {
            ir = vnames.indexOf('r'); ig = vnames.indexOf('g'); ib = vnames.indexOf('b');
        }
        var hasC = (ir >= 0 && ig >= 0 && ib >= 0);
        var colors = hasC ? new Float32Array(vElem.count * 3) : null;

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

                        if (hasC && n > ir && n > ig && n > ib)
                        {
                            var cr = numBuf[ir], cg = numBuf[ig], cb = numBuf[ib];
                            if (cr > 1.0 || cg > 1.0 || cb > 1.0)
                            {
                                cr /= 255; cg /= 255; cb /= 255;
                            }
                            colors[seen * 3] = cr;
                            colors[seen * 3 + 1] = cg;
                            colors[seen * 3 + 2] = cb;
                        }
                    }
                    seen++;
                }
                else if (fElem && inFace < fElem.count)
                {
                    var m = scanNumbers(t, numBuf);
                    if (m >= 4)
                    {
                        var c = numBuf[0];

                        /* 扇形三角化：顶点索引在 numBuf[1..c]，第一个三角形是
                         * (numBuf[1], numBuf[2], numBuf[3])，所以 k 必须从 2 起。
                         * k=1 会得到 (v0, v0, v1) 的退化面 —— 一个三角面被读成两个，
                         * 四边形被读成三个，三角形总数凭空翻倍。 */
                        for (var k = 2; k + 1 <= c; k++)
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

        /* face 元素在 PLY 里是**可选**的：扫描仪导出的点云通常只有 vertex。
         * 没有 face（或一个面片都没读到）就按点云返回，不能当成"0 个三角形的网格"。 */
        if (!fElem || fElem.count === 0 || tri === 0)
        {
            var vn = Math.max(0, Math.min(seen, vElem.count));
            return {
                kind: 'points',
                positions: (vn === vElem.count) ? verts : verts.subarray(0, vn * 3),
                count: vn,
                colors: colors ? ((vn === vElem.count) ? colors : colors.subarray(0, vn * 3)) : null,
                tags: null,
                bbox: bbox,
                format: 'PLY(ascii)',
                truncated: false,
                totalSource: vElem.count,
                note: ''
            };
        }

        return {
            kind: 'mesh',
            positions: out.result(),
            count: tri,
            bbox: bbox,
            format: 'PLY(ascii)',
            truncated: full,
            totalSource: fElem ? fElem.count : 0,
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

    /* ==================== 新增格式：OFF / PCD / glTF ==================== */

    /* 逐点统计包围盒（BBox 只有 empty/merge，没有累加器） */
    function bboxAccum(pos, count)
    {
        var b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        for (var i = 0; i < count; i++)
        {
            var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
            if (x < b.min[0]) { b.min[0] = x; }
            if (y < b.min[1]) { b.min[1] = y; }
            if (z < b.min[2]) { b.min[2] = z; }
            if (x > b.max[0]) { b.max[0] = x; }
            if (y > b.max[1]) { b.max[1] = y; }
            if (z > b.max[2]) { b.max[2] = z; }
        }
        if (!isFinite(b.min[0])) { b.min = [0, 0, 0]; b.max = [0, 0, 0]; }
        return b;
    }

    function readText(file)
    {
        if (file.text) { return file.text(); }
        return new Promise(function (resolve, reject)
        {
            var fr = new global.FileReader();
            fr.onload = function () { resolve(fr.result); };
            fr.onerror = function () { reject(fr.error || new Error('读取失败')); };
            fr.readAsText(file);
        });
    }

    /* ---------------- OFF / COFF ---------------- */
    async function parseOFF(file, opts, onProgress)
    {
        var o = opts || {};
        var text = await readText(file);
        var lines = text.split(/\r?\n/);
        var li = 0;

        function nextDataLine()
        {
            while (li < lines.length)
            {
                var l = lines[li++];
                var t = l ? l.trim() : '';
                if (t && t.charAt(0) !== '#') { return t; }
            }
            return '';
        }

        var head = nextDataLine();
        var m = /^(C?OFF)\b(.*)$/i.exec(head);
        if (!m) { throw new Error('不是有效的 OFF 文件：首行应为 OFF 或 COFF'); }

        var withColor = /^C/i.test(m[1]);
        var counts = (m[2] || '').trim() || nextDataLine();
        var c = counts.split(/\s+/);
        var nv = parseInt(c[0], 10) || 0;
        var nf = parseInt(c[1], 10) || 0;
        if (!nv) { throw new Error('OFF 文件里没有顶点'); }

        if (onProgress) { await onProgress(0.2, 'OFF 顶点 ' + nv); }

        var pos = new Float32Array(nv * 3);
        var col = withColor ? new Float32Array(nv * 3) : null;

        for (var v = 0; v < nv; v++)
        {
            var p = nextDataLine().split(/\s+/);
            pos[v * 3] = +p[0];
            pos[v * 3 + 1] = +p[1];
            pos[v * 3 + 2] = +p[2];

            if (col)
            {
                var r = +p[3], g = +p[4], b = +p[5];
                /* 有的导出写 0-255，有的写 0-1 */
                if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
                col[v * 3] = r; col[v * 3 + 1] = g; col[v * 3 + 2] = b;
            }
        }

        var maxTri = o.maxTriangles || DEFAULT_MAX_TRIANGLES;

        /* 面可以是任意边形，三角化后的顶点数无法预先算出，
         * 所以用动态累加器而不是按 nf*9 预分配（四边形按 9 算会越界） */
        var posAcc = new F32Accum(4096);
        var colAcc = col ? new F32Accum(4096) : null;
        var tri = 0;
        var full = false;

        for (var f = 0; f < nf && !full; f++)
        {
            var q = nextDataLine().split(/\s+/);
            var n = parseInt(q[0], 10) || 0;
            if (n < 3) { continue; }

            for (var k = 1; k + 2 <= n; k++)
            {
                if (tri >= maxTri) { full = true; break; }

                var ids = [parseInt(q[k], 10), parseInt(q[k + 1], 10), parseInt(q[k + 2], 10)];
                var bad = false;
                for (var e = 0; e < 3; e++)
                {
                    if (!(ids[e] >= 0 && ids[e] < nv)) { bad = true; }
                }
                if (bad) { continue; }

                for (var m = 0; m < 3; m++)
                {
                    var vi = ids[m];
                    posAcc.push3(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
                    if (colAcc) { colAcc.push3(col[vi * 3], col[vi * 3 + 1], col[vi * 3 + 2]); }
                }
                tri++;
            }
        }

        /* nf = 0（只有顶点）是合法的"点云 OFF"，不是错误。
         * COFF 的顶点色一并带上，此时不用展开成角点色。 */
        if (!tri)
        {
            if (nv > 0)
            {
                return {
                    kind: 'points',
                    positions: pos,
                    count: nv,
                    colors: col,
                    tags: null,
                    bbox: bboxAccum(pos, nv),
                    format: withColor ? 'COFF' : 'OFF',
                    truncated: false,
                    totalSource: nv,
                    note: ''
                };
            }
            throw new Error('OFF 文件里没有面片');
        }

        var outPos = posAcc.result();
        var res = {
            kind: 'mesh',
            positions: outPos,
            count: tri,
            bbox: bboxAccum(outPos, tri * 3),
            format: withColor ? 'COFF' : 'OFF',
            truncated: full,
            totalSource: nf,
            note: full ? ('仅载入前 ' + tri + ' 个三角形') : ''
        };
        if (colAcc) { res.colors = colAcc.result(); }
        return res;
    }

    /* ---------------- PCD（ascii / binary） ---------------- */
    async function parsePCD(file, opts, onProgress)
    {
        var o = opts || {};
        var headLen = Math.min(file.size, 1 << 20);
        var headBuf = await readSlice(file, 0, headLen);
        var headText = new global.TextDecoder('utf-8').decode(new Uint8Array(headBuf));

        var mData = /(?:^|\r?\n)\s*DATA\s+(\S+)/i.exec(headText);
        if (!mData) { throw new Error('不是有效的 PCD 文件：缺少 DATA 行'); }

        var dataType = (mData[1] || 'ascii').toLowerCase();
        var dataStart = mData.index + mData[0].length + 1;   /* 换行之后 */
        var header = headText.slice(0, mData.index);

        function hval(key)
        {
            var mm = new RegExp('^\\s*' + key + '\\s+(.*)$', 'im').exec(header);
            return mm ? mm[1].trim() : '';
        }

        var fields = hval('FIELDS').split(/\s+/).filter(Boolean);
        var sizes = hval('SIZE').split(/\s+/).map(Number);
        var types = hval('TYPE').split(/\s+/);
        var counts = hval('COUNT').split(/\s+/).filter(Boolean).map(Number);
        if (!counts.length) { counts = fields.map(function () { return 1; }); }

        var nPts = parseInt(hval('POINTS'), 10) || 0;
        if (!nPts)
        {
            nPts = (parseInt(hval('WIDTH'), 10) || 0) * (parseInt(hval('HEIGHT'), 10) || 1);
        }

        var ix = fields.indexOf('x'), iy = fields.indexOf('y'), iz = fields.indexOf('z');
        if (ix < 0 || iy < 0 || iz < 0) { throw new Error('PCD 缺少 x / y / z 字段'); }
        if (!nPts) { throw new Error('PCD 头里没有点数'); }

        if (onProgress) { await onProgress(0.2, 'PCD ' + nPts + ' 点'); }

        var pos = new Float32Array(nPts * 3);
        var col = null;
        var irgb = fields.indexOf('rgb') >= 0 ? fields.indexOf('rgb') : fields.indexOf('rgba');

        if (dataType === 'ascii')
        {
            var tail = await readText(file.slice(dataStart));
            var nums = tail.split(/[\s,]+/);

            var tokOff = [];
            var per = 0;
            for (var ti = 0; ti < counts.length; ti++)
            {
                tokOff.push(per);
                per += counts[ti];
            }

            for (var pi = 0; pi < nPts; pi++)
            {
                var base = pi * per;
                pos[pi * 3] = +nums[base + tokOff[ix]];
                pos[pi * 3 + 1] = +nums[base + tokOff[iy]];
                pos[pi * 3 + 2] = +nums[base + tokOff[iz]];
            }

            if (irgb >= 0)
            {
                /* rgb 字段存的是「32 位颜色的浮点表示」，要按位还原：
                 * 先把十进制转成 float32，再读同一块内存的 uint32 */
                var scratchF = new Float32Array(1);
                var scratchU = new Uint32Array(scratchF.buffer);
                col = new Float32Array(nPts * 3);

                for (var pj = 0; pj < nPts; pj++)
                {
                    scratchF[0] = +nums[pj * per + tokOff[irgb]];
                    var packed = scratchU[0];
                    col[pj * 3] = ((packed >> 16) & 255) / 255;
                    col[pj * 3 + 1] = ((packed >> 8) & 255) / 255;
                    col[pj * 3 + 2] = (packed & 255) / 255;
                }
            }
        }
        else if (dataType === 'binary')
        {
            var offs = [];
            var stride = 0;
            for (var fi = 0; fi < fields.length; fi++)
            {
                offs.push(stride);
                stride += sizes[fi] * counts[fi];
            }

            var buf = await readSlice(file, dataStart, dataStart + nPts * stride);
            var dv = new DataView(buf);

            for (var pk = 0; pk < nPts; pk++)
            {
                var b0 = pk * stride;
                pos[pk * 3] = dv.getFloat32(b0 + offs[ix], true);
                pos[pk * 3 + 1] = dv.getFloat32(b0 + offs[iy], true);
                pos[pk * 3 + 2] = dv.getFloat32(b0 + offs[iz], true);
            }

            if (irgb >= 0)
            {
                /* 二进制里无论 TYPE 写 F 还是 U，都是同一块 4 字节位模式，
                 * 直接按 uint32 读即可 */
                col = new Float32Array(nPts * 3);
                for (var pm = 0; pm < nPts; pm++)
                {
                    var packed = dv.getUint32(pm * stride + offs[irgb], true);
                    col[pm * 3] = ((packed >> 16) & 255) / 255;
                    col[pm * 3 + 1] = ((packed >> 8) & 255) / 255;
                    col[pm * 3 + 2] = (packed & 255) / 255;
                }
            }
        }
        else
        {
            throw new Error('PCD 的 ' + dataType + ' 压缩格式暂不支持，请另存为 ascii 或 binary');
        }

        var res = {
            kind: 'points',
            positions: pos,
            count: nPts,
            bbox: bboxAccum(pos, nPts),
            format: 'PCD(' + dataType + ')',
            truncated: false,
            totalSource: nPts,
            note: ''
        };
        if (col) { res.colors = col; }
        return res;
    }

    /* ---------------- glTF 2.0（.glb / .gltf） ---------------- */
    var GLTF_COMP = {
        5120: ['Int8', 1], 5121: ['Uint8', 1], 5122: ['Int16', 2],
        5123: ['Uint16', 2], 5125: ['Uint32', 4], 5126: ['Float32', 4]
    };
    var GLTF_NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

    function base64ToBytes(b64)
    {
        var bin = global.atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
        return out;
    }

    function readAccessor(gltf, buffers, index)
    {
        var acc = gltf.accessors[index];
        if (!acc || acc.bufferView === undefined) { return null; }

        var bv = gltf.bufferViews[acc.bufferView];
        var buf = buffers[bv.buffer];
        if (!buf) { return null; }

        var comp = GLTF_COMP[acc.componentType];
        var num = GLTF_NUM[acc.type] || 1;
        var elem = comp[1] * num;
        var stride = bv.byteStride || elem;
        var base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        var getter = 'get' + comp[0];

        var out = new Float32Array(acc.count * num);
        var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

        for (var i = 0; i < acc.count; i++)
        {
            for (var k = 0; k < num; k++)
            {
                var val = dv[getter](base + i * stride + k * comp[1], true);
                /* 归一化整数颜色（Uint8/Uint16 + normalized） */
                if (acc.normalized && (acc.componentType === 5121 || acc.componentType === 5123))
                {
                    val = val / (acc.componentType === 5121 ? 255 : 65535);
                }
                out[i * num + k] = val;
            }
        }
        return out;
    }

    function quatToMat4(q)
    {
        var x = q[0], y = q[1], z = q[2], w = q[3];
        var x2 = x + x, y2 = y + y, z2 = z + z;
        var xx = x * x2, xy = x * y2, xz = x * z2;
        var yy = y * y2, yz = y * z2, zz = z * z2;
        var wx = w * x2, wy = w * y2, wz = w * z2;

        return [
            1 - (yy + zz), xy + wz, xz - wy, 0,
            xy - wz, 1 - (xx + zz), yz + wx, 0,
            xz + wy, yz - wx, 1 - (xx + yy), 0,
            0, 0, 0, 1
        ];
    }

    function mulMat4(a, b)
    {
        var o = new Array(16);
        for (var c = 0; c < 4; c++)
        {
            for (var r = 0; r < 4; r++)
            {
                o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                    a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
            }
        }
        return o;
    }

    function localMat4(node)
    {
        if (node.matrix) { return node.matrix.slice(); }

        var t = node.translation || [0, 0, 0];
        var q = node.rotation || [0, 0, 0, 1];
        var sc = node.scale || [1, 1, 1];

        var m = quatToMat4(q);
        for (var i = 0; i < 3; i++)
        {
            m[i] *= sc[0];
            m[4 + i] *= sc[1];
            m[8 + i] *= sc[2];
        }
        m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
        return m;
    }

    async function parseGLTF(file, opts, onProgress, isGLB)
    {
        var o = opts || {};
        var json = null;
        var bin = null;

        if (isGLB)
        {
            var headBuf = await readSlice(file, 0, Math.min(file.size, 12));
            if (headBuf.byteLength < 12) { throw new Error('不是有效的 GLB 文件'); }
            var hdv = new DataView(headBuf);
            if (hdv.getUint32(0, true) !== 0x46546C67) { throw new Error('不是有效的 GLB 文件'); }

            var total = Math.min(hdv.getUint32(8, true), file.size);
            var all = await readSlice(file, 0, total);
            var ad = new DataView(all);

            var off = 12;
            while (off + 8 <= all.byteLength)
            {
                var len = ad.getUint32(off, true);
                var type = ad.getUint32(off + 4, true);
                var body = new Uint8Array(all, off + 8, Math.min(len, all.byteLength - off - 8));

                if (type === 0x4E4F534A)
                {
                    json = JSON.parse(new global.TextDecoder('utf-8').decode(body));
                }
                else if (type === 0x004E4942)
                {
                    bin = body;
                }
                off += 8 + len + ((4 - (len % 4)) % 4);
            }
            if (!json) { throw new Error('GLB 里没有 JSON 块'); }
        }
        else
        {
            json = JSON.parse(await readText(file));
        }

        var req = json.extensionsRequired || [];
        if (req.indexOf('KHR_draco_mesh_compression') >= 0)
        {
            throw new Error('该 glTF 使用了 Draco 压缩，暂不支持；请导出未压缩的 .glb');
        }

        /* 取 buffer：GLB 的 BIN 块，或 .gltf 里的 data: base64 */
        var buffers = [];
        var blist = json.buffers || [];
        for (var bi = 0; bi < blist.length; bi++)
        {
            var uri = blist[bi].uri;
            if (!uri)
            {
                if (bi === 0 && bin) { buffers[0] = bin; }
                continue;
            }
            var mm = /^data:[^,]*;base64,(.*)$/i.exec(uri);
            if (!mm)
            {
                throw new Error('.gltf 引用了外部文件「' + uri + '」，请改用自包含的 .glb');
            }
            buffers[bi] = base64ToBytes(mm[1]);
        }

        if (onProgress) { await onProgress(0.25, 'glTF 解析'); }

        var maxTri = o.maxTriangles || DEFAULT_MAX_TRIANGLES;
        var posAcc = new F32Accum(4096);
        var colAcc = null;
        var tri = 0;
        var full = false;
        var hasColor = false;

        /* 点云累加器：glTF 的 primitive.mode = 0（POINTS）是合法的点云。
         * 以前不看 mode，直接把每 3 个顶点拼成三角形，得到一堆垃圾几何。 */
        var ptAcc = null;
        var ptColAcc = null;
        var pts = 0;

        function pushPrimitive(prim, world)
        {
            if (full) { return; }

            var attrs = prim.attributes || {};
            if (attrs.POSITION === undefined) { return; }

            var P = readAccessor(json, buffers, attrs.POSITION);
            if (!P) { return; }

            var C = (attrs.COLOR_0 !== undefined) ? readAccessor(json, buffers, attrs.COLOR_0) : null;
            var idx = (prim.indices !== undefined) ? readAccessor(json, buffers, prim.indices) : null;

            var vertCount = P.length / 3;
            var iCount = idx ? idx.length : vertCount;

            /* 缺省 4 = TRIANGLES */
            var mode = (prim.mode === undefined) ? 4 : (prim.mode | 0);

            function vidx(k)
            {
                return idx ? (idx[k] | 0) : k;
            }

            function emit(vi, outP, outC)
            {
                if (vi < 0 || vi >= vertCount) { vi = 0; }

                var x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2];

                /* 列主序矩阵变换 */
                var wx = world[0] * x + world[4] * y + world[8] * z + world[12];
                var wy = world[1] * x + world[5] * y + world[9] * z + world[13];
                var wz = world[2] * x + world[6] * y + world[10] * z + world[14];

                /* glTF 是 Y 轴向上，本工具按 Z 轴向上显示 */
                outP.push3(wx, -wz, wy);

                if (outC)
                {
                    if (C) { outC.push3(C[vi * 3] || 0, C[vi * 3 + 1] || 0, C[vi * 3 + 2] || 0); }
                    else { outC.push3(1, 1, 1); }
                }
            }

            /* ① POINTS：每个顶点就是一个点 */
            if (mode === 0)
            {
                if (!ptAcc)
                {
                    ptAcc = new F32Accum(4096);
                    if (C) { ptColAcc = new F32Accum(4096); }
                }
                for (var pi = 0; pi < iCount; pi++)
                {
                    emit(vidx(pi), ptAcc, ptColAcc);
                    pts++;
                }
                return;
            }

            /* ② LINES（1/2/3）：既不是面也不是点云，跳过 */
            if (mode >= 1 && mode <= 3) { return; }

            if (C && !colAcc) { colAcc = new F32Accum(4096); hasColor = true; }

            /* ③ TRIANGLES(4) / TRIANGLE_STRIP(5) / TRIANGLE_FAN(6) */
            function emitTri(a, b, c)
            {
                if (tri >= maxTri) { full = true; return false; }
                emit(vidx(a), posAcc, colAcc);
                emit(vidx(b), posAcc, colAcc);
                emit(vidx(c), posAcc, colAcc);
                tri++;
                return true;
            }

            if (mode === 5)
            {
                /* strip：奇数面带一次绕序翻转，否则法向会交替反向 */
                for (var si = 0; si + 2 < iCount; si++)
                {
                    var okS = (si & 1) ? emitTri(si + 1, si, si + 2) : emitTri(si, si + 1, si + 2);
                    if (!okS) { return; }
                }
                return;
            }

            if (mode === 6)
            {
                /* fan：首个顶点与相邻两点成面 */
                for (var fi = 1; fi + 1 < iCount; fi++)
                {
                    if (!emitTri(0, fi, fi + 1)) { return; }
                }
                return;
            }

            for (var i = 0; i + 2 < iCount; i += 3)
            {
                if (!emitTri(i, i + 1, i + 2)) { return; }
            }
        }

        var IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        var nodes = json.nodes || [];
        var scenes = json.scenes || [];

        function walk(nodeIndex, parent, depth)
        {
            if (full || depth > 64) { return; }
            var node = nodes[nodeIndex];
            if (!node) { return; }

            var world = mulMat4(parent, localMat4(node));

            if (node.mesh !== undefined && json.meshes)
            {
                var mesh = json.meshes[node.mesh];
                var prims = (mesh && mesh.primitives) || [];
                for (var pi = 0; pi < prims.length; pi++) { pushPrimitive(prims[pi], world); }
            }

            var kids = node.children || [];
            for (var ki = 0; ki < kids.length; ki++) { walk(kids[ki], world, depth + 1); }
        }

        if (scenes.length)
        {
            var roots = scenes[json.scene || 0] ? scenes[json.scene || 0].nodes || [] : [];
            for (var ri = 0; ri < roots.length; ri++) { walk(roots[ri], IDENT, 0); }
        }
        else if (nodes.length)
        {
            for (var ni = 0; ni < nodes.length; ni++) { walk(ni, IDENT, 0); }
        }
        else if (json.meshes)
        {
            for (var mi = 0; mi < json.meshes.length; mi++)
            {
                var ps = json.meshes[mi].primitives || [];
                for (var pj = 0; pj < ps.length; pj++) { pushPrimitive(ps[pj], IDENT); }
            }
        }

        /* 全是点云（mode 0）→ 返回点图层；三角面优先 */
        if (!tri)
        {
            if (pts > 0 && ptAcc)
            {
                var ppos = ptAcc.result();
                return {
                    kind: 'points',
                    positions: ppos,
                    count: pts,
                    colors: ptColAcc ? ptColAcc.result() : null,
                    tags: null,
                    bbox: bboxAccum(ppos, ppos.length / 3),
                    format: isGLB ? 'GLB' : 'glTF',
                    truncated: false,
                    totalSource: pts,
                    note: ''
                };
            }
            throw new Error('glTF 里没有可显示的三角面');
        }

        var pos = posAcc.result();
        var res = {
            kind: 'mesh',
            positions: pos,
            count: tri,
            bbox: bboxAccum(pos, pos.length / 3),
            format: isGLB ? 'GLB' : 'glTF',
            truncated: full,
            totalSource: tri,
            note: full ? ('仅载入前 ' + tri + ' 个三角形') : ''
        };
        if (colAcc && hasColor) { res.colors = colAcc.result(); }
        return res;
    }

    /* ---------------- 入口 ---------------- */

    /* 扩展名 → 解析器。用表而不是 if 链，新增格式只加一行 */
    var KIND_BY_EXT = {
        stl: 'stl', obj: 'obj', ply: 'ply', off: 'off',
        pcd: 'pcd', glb: 'glb', gltf: 'gltf',
        txt: 'points', xyz: 'points', csv: 'points', asc: 'points',
        pts: 'points', dat: 'points', ptx: 'points'
    };

    /* 认得但做不了的格式：直接给下一步动作，而不是让用户自己猜 */
    var UNSUPPORTED_HINT = {
        step: 'STEP 是 B-rep 格式，需要几何内核，请先导出为 STL 或 GLB',
        stp: 'STEP 是 B-rep 格式，请先导出为 STL 或 GLB',
        iges: 'IGES 是 B-rep 格式，请先导出为 STL 或 GLB',
        igs: 'IGES 是 B-rep 格式，请先导出为 STL 或 GLB',
        fbx: 'FBX 暂不支持，请导出为 GLB 或 OBJ',
        dae: 'Collada 暂不支持，请导出为 GLB 或 OBJ',
        '3mf': '3MF 暂不支持，请导出为 STL 或 GLB',
        '3ds': '3DS 暂不支持，请导出为 GLB 或 OBJ',
        usdz: 'USDZ 暂不支持，请导出为 GLB',
        las: 'LAS 暂不支持，请先转换为 PCD 或 XYZ',
        laz: 'LAZ 是压缩 LAS，请先解压并转换为 PCD 或 XYZ',
        e57: 'E57 暂不支持，请先转换为 PCD 或 XYZ',
        wrl: 'VRML 暂不支持，请导出为 OBJ'
    };

    function isLikelyText(str)
    {
        if (!str) { return false; }
        var ok = 0;
        for (var i = 0; i < str.length; i++)
        {
            var c = str.charCodeAt(i);
            if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) { ok++; }
        }
        return ok / str.length > 0.9;
    }

    function unsupportedMessage(file)
    {
        var ext = extOf(file.name);
        var head = ext ? ('不支持的格式 .' + ext) : '无法识别的文件格式';
        var hint = UNSUPPORTED_HINT[ext];
        return head + '（当前支持 STL / OBJ / PLY / OFF / GLB / glTF / PCD / 点云文本）' +
            (hint ? '：' + hint : '');
    }

    async function detectKind(file)
    {
        var ext = extOf(file.name);
        if (KIND_BY_EXT[ext]) { return KIND_BY_EXT[ext]; }

        /* 认得但做不了的格式（STEP / FBX / LAS …）必须在嗅探之前拦下，
         * 否则它们内容像文本，会被当成点云去解析，最后报“没有可显示的数据” */
        if (UNSUPPORTED_HINT[ext]) { return ''; }

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
        if (file.size >= 12 && dv.getUint32(0, true) === 0x46546C67) { return 'glb'; }

        var raw = new TextDecoder('utf-8').decode(buf).trim();
        var txt = raw.toLowerCase();
        if (txt.indexOf('ply') === 0) { return 'ply'; }
        if (txt.indexOf('solid') === 0) { return 'stl'; }
        if (txt.indexOf('off') === 0 || txt.indexOf('coff') === 0) { return 'off'; }
        if (txt.indexOf('#') === 0 && txt.indexOf('pcd') > 0) { return 'pcd'; }
        if (txt.charAt(0) === '{') { return 'gltf'; }

        /* 无扩展名但内容像文本：仍按点云尝试（兼容手工改名的 CSV / XYZ） */
        if (ext === '' || isLikelyText(raw)) { return 'points'; }

        return '';
    }

    async function loadFile(file, opts, onProgress, confirmColumns)
    {
        var o = opts || {};
        var kind = await detectKind(file);
        var res;

        if (kind === 'stl') { res = await parseSTL(file, o, onProgress); }
        else if (kind === 'obj') { res = await parseOBJ(file, o, onProgress); }
        else if (kind === 'ply') { res = await parsePLY(file, o, onProgress); }
        else if (kind === 'off') { res = await parseOFF(file, o, onProgress); }
        else if (kind === 'pcd') { res = await parsePCD(file, o, onProgress); }
        else if (kind === 'glb') { res = await parseGLTF(file, o, onProgress, true); }
        else if (kind === 'gltf') { res = await parseGLTF(file, o, onProgress, false); }
        else if (kind === 'points')
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
        else
        {
            throw new Error(unsupportedMessage(file));
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

    global.MV.ioBindHooks = bindHooks;


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
        else if (ext === 'off')
        {
            kind = 'mesh';
            count = Math.floor(size / 60);
        }
        else if (ext === 'glb' || ext === 'gltf')
        {
            kind = 'mesh';
            count = Math.floor(size / 48);
        }
        else if (ext === 'pcd')
        {
            kind = 'points';
            count = Math.floor(size / 16);
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

    /* ==================== 导出（与解析对称） ====================
     * 输入统一是图层数据 data：
     *   kind       'mesh' | 'points'
     *   positions  Float32Array；网格为「每 3 顶点一个三角形」的解索引形式
     *   uniqVerts / remap   网格的唯一顶点表与索引（载入时已算好，无需重新焊接）
     *   colors / normals / scalars  可选
     * 输出 Blob，由调用方触发下载。
     *
     * 一律分块拼接：百万级三角形时一次性拼出一个字符串会爆内存。
     */
    (function ()
    {
        var CHUNK_TRI = 20000;
        var CHUNK_ROW = 50000;

        /* 6 位小数足够表达几何，又比 toString 短 */
        function fx(v)
        {
            if (!isFinite(v)) { return '0'; }
            var t = v.toFixed(6);
            if (t.indexOf('.') >= 0)
            {
                t = t.replace(/0+$/, '');
                if (t.charAt(t.length - 1) === '.') { t = t.slice(0, -1); }
            }
            return t === '-0' ? '0' : t;
        }

        function triCountOf(data)
        {
            return Math.floor((data.positions ? data.positions.length : 0) / 9);
        }

        function pointCountOf(data)
        {
            return Math.floor((data.positions ? data.positions.length : 0) / 3);
        }

        /* ---------------- STL（binary） ---------------- */
        function stlBinary(data)
        {
            var pos = data.positions;
            var tris = triCountOf(data);
            if (!tris) { throw new Error('当前图层没有三角形'); }

            var parts = [];
            var head = new ArrayBuffer(84);
            var hv = new DataView(head);
            var title = 'binary STL exported by 3DViewer';
            for (var i = 0; i < title.length && i < 80; i++)
            {
                hv.setUint8(i, title.charCodeAt(i));
            }
            hv.setUint32(80, tris, true);
            parts.push(head);

            for (var base = 0; base < tris; base += CHUNK_TRI)
            {
                var n = Math.min(CHUNK_TRI, tris - base);
                var buf = new ArrayBuffer(n * 50);
                var dv = new DataView(buf);
                var off = 0;

                for (var t = 0; t < n; t++)
                {
                    var ti = (base + t) * 9;
                    var ax = pos[ti], ay = pos[ti + 1], az = pos[ti + 2];
                    var bx = pos[ti + 3], by = pos[ti + 4], bz = pos[ti + 5];
                    var cx = pos[ti + 6], cy = pos[ti + 7], cz = pos[ti + 8];

                    /* 面法向由叉积现算，不依赖 data.normals（它是按角点存的，与面不对应） */
                    var ux = bx - ax, uy = by - ay, uz = bz - az;
                    var vx = cx - ax, vy = cy - ay, vz = cz - az;
                    var nx = uy * vz - uz * vy;
                    var ny = uz * vx - ux * vz;
                    var nz = ux * vy - uy * vx;
                    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
                    else { nx = ny = nz = 0; }

                    dv.setFloat32(off, nx, true); off += 4;
                    dv.setFloat32(off, ny, true); off += 4;
                    dv.setFloat32(off, nz, true); off += 4;

                    dv.setFloat32(off, ax, true); off += 4;
                    dv.setFloat32(off, ay, true); off += 4;
                    dv.setFloat32(off, az, true); off += 4;
                    dv.setFloat32(off, bx, true); off += 4;
                    dv.setFloat32(off, by, true); off += 4;
                    dv.setFloat32(off, bz, true); off += 4;
                    dv.setFloat32(off, cx, true); off += 4;
                    dv.setFloat32(off, cy, true); off += 4;
                    dv.setFloat32(off, cz, true); off += 4;

                    dv.setUint16(off, 0, true); off += 2;
                }
                parts.push(buf);
            }

            return new Blob(parts, { type: 'model/stl' });
        }

        /* ---------------- OBJ ---------------- */
        function objText(data)
        {
            if (data.kind !== 'mesh') { throw new Error('OBJ 只支持网格图层'); }

            var verts = data.uniqVerts;
            var idx = data.remap;
            if (!verts || !idx)
            {
                throw new Error('缺少唯一顶点表，无法导出 OBJ');
            }

            var parts = ['# exported by 3DViewer\n'];
            var vCount = Math.floor(verts.length / 3);

            for (var v0 = 0; v0 < vCount; v0 += CHUNK_TRI)
            {
                var v1 = Math.min(vCount, v0 + CHUNK_TRI);
                var s = '';
                for (var v = v0; v < v1; v++)
                {
                    s += 'v ' + fx(verts[v * 3]) + ' ' +
                        fx(verts[v * 3 + 1]) + ' ' + fx(verts[v * 3 + 2]) + '\n';
                }
                parts.push(s);
            }

            var triCount = Math.floor(idx.length / 3);
            for (var t0 = 0; t0 < triCount; t0 += CHUNK_TRI)
            {
                var t1 = Math.min(triCount, t0 + CHUNK_TRI);
                var s2 = '';
                for (var t = t0; t < t1; t++)
                {
                    /* OBJ 的索引从 1 开始 */
                    s2 += 'f ' + (idx[t * 3] + 1) + ' ' +
                        (idx[t * 3 + 1] + 1) + ' ' + (idx[t * 3 + 2] + 1) + '\n';
                }
                parts.push(s2);
            }

            return new Blob(parts, { type: 'text/plain' });
        }

        /* ---------------- 点云文本（CSV / XYZ） ---------------- */
        function pointsText(data, sep, withHeader)
        {
            var pos = data.positions;
            var n = pointCountOf(data);
            if (!n) { throw new Error('当前图层没有点'); }

            var sfs = data.scalars || [];
            var parts = [];

            if (withHeader)
            {
                var head = 'x' + sep + 'y' + sep + 'z';
                for (var h = 0; h < sfs.length; h++)
                {
                    head += sep + (sfs[h].name || ('SF' + (h + 1)));
                }
                parts.push(head + '\n');
            }

            for (var r0 = 0; r0 < n; r0 += CHUNK_ROW)
            {
                var r1 = Math.min(n, r0 + CHUNK_ROW);
                var s = '';
                for (var r = r0; r < r1; r++)
                {
                    s += fx(pos[r * 3]) + sep + fx(pos[r * 3 + 1]) + sep + fx(pos[r * 3 + 2]);
                    for (var k = 0; k < sfs.length; k++)
                    {
                        var vals = sfs[k].values;
                        s += sep + (vals ? fx(vals[r]) : '');
                    }
                    s += '\n';
                }
                parts.push(s);
            }

            return new Blob(parts, { type: 'text/plain' });
        }

        /* ---------------- 顶点色映射到唯一顶点 ----------------
         * 载入时颜色按「角点」存放（每三角形 3 份），导出 PLY / GLB 需要每顶点一份，
         * 用 remap 取每个唯一顶点的首次出现即可。 */
        function vertexColors(data, vCount)
        {
            var col = data.colors;
            if (!col) { return null; }

            var idx = data.remap;
            if (!idx)
            {
                return col.length >= vCount * 3 ? col : null;
            }

            var out = new Float32Array(vCount * 3);
            var seen = new Uint8Array(vCount);
            var n = Math.min(idx.length, Math.floor(col.length / 3));

            for (var i = 0; i < n; i++)
            {
                var u = idx[i];
                if (u >= vCount || seen[u]) { continue; }
                seen[u] = 1;
                out[u * 3] = col[i * 3];
                out[u * 3 + 1] = col[i * 3 + 1];
                out[u * 3 + 2] = col[i * 3 + 2];
            }
            return out;
        }

        function safeName(str, fallback)
        {
            var t = String(str || '').replace(/[^0-9A-Za-z_\u4e00-\u9fa5]/g, '_');
            return t || fallback;
        }

        /* ---------------- PLY（binary_little_endian） ----------------
         * 网格写成「索引顶点 + 面表」，点云写成纯顶点元素。 */
        function ply(data)
        {
            var isMesh = data.kind === 'mesh';
            var verts;
            var faces = null;
            var vCount;

            if (isMesh)
            {
                verts = data.uniqVerts;
                faces = data.remap;
                if (!verts || !faces) { throw new Error('缺少唯一顶点表，无法导出 PLY'); }
                vCount = Math.floor(verts.length / 3);
            }
            else
            {
                verts = data.positions;
                vCount = pointCountOf(data);
            }
            if (!vCount) { throw new Error('当前图层没有可导出的顶点'); }

            var col = vertexColors(data, vCount);
            var sfs = isMesh ? [] : (data.scalars || []);
            var triCount = faces ? Math.floor(faces.length / 3) : 0;

            var head = 'ply\n';
            head += 'format binary_little_endian 1.0\n';
            head += 'comment exported by 3DViewer\n';
            head += 'element vertex ' + vCount + '\n';
            head += 'property float x\nproperty float y\nproperty float z\n';
            if (col)
            {
                head += 'property uchar red\nproperty uchar green\nproperty uchar blue\n';
            }
            for (var si = 0; si < sfs.length; si++)
            {
                head += 'property float ' + safeName(sfs[si].name, 'sf' + (si + 1)) + '\n';
            }
            if (triCount > 0)
            {
                head += 'element face ' + triCount + '\n';
                head += 'property list uchar int vertex_indices\n';
            }
            head += 'end_header\n';

            var parts = [head];
            var stride = 12 + (col ? 3 : 0) + sfs.length * 4;

            for (var v0 = 0; v0 < vCount; v0 += CHUNK_TRI)
            {
                var v1 = Math.min(vCount, v0 + CHUNK_TRI);
                var buf = new ArrayBuffer((v1 - v0) * stride);
                var dv = new DataView(buf);
                var off = 0;

                for (var v = v0; v < v1; v++)
                {
                    dv.setFloat32(off, verts[v * 3], true); off += 4;
                    dv.setFloat32(off, verts[v * 3 + 1], true); off += 4;
                    dv.setFloat32(off, verts[v * 3 + 2], true); off += 4;

                    if (col)
                    {
                        dv.setUint8(off, Math.max(0, Math.min(255, Math.round(col[v * 3] * 255)))); off += 1;
                        dv.setUint8(off, Math.max(0, Math.min(255, Math.round(col[v * 3 + 1] * 255)))); off += 1;
                        dv.setUint8(off, Math.max(0, Math.min(255, Math.round(col[v * 3 + 2] * 255)))); off += 1;
                    }

                    for (var sk = 0; sk < sfs.length; sk++)
                    {
                        var vals = sfs[sk].values;
                        dv.setFloat32(off, vals ? vals[v] : 0, true); off += 4;
                    }
                }
                parts.push(buf);
            }

            if (triCount > 0)
            {
                for (var t0 = 0; t0 < triCount; t0 += CHUNK_TRI)
                {
                    var t1 = Math.min(triCount, t0 + CHUNK_TRI);
                    var fbuf = new ArrayBuffer((t1 - t0) * 13);
                    var fdv = new DataView(fbuf);
                    var fo = 0;

                    for (var t = t0; t < t1; t++)
                    {
                        fdv.setUint8(fo, 3); fo += 1;
                        fdv.setInt32(fo, faces[t * 3], true); fo += 4;
                        fdv.setInt32(fo, faces[t * 3 + 1], true); fo += 4;
                        fdv.setInt32(fo, faces[t * 3 + 2], true); fo += 4;
                    }
                    parts.push(fbuf);
                }
            }

            return new Blob(parts, { type: 'application/octet-stream' });
        }

        /* ---------------- PCD（binary） ----------------
         * rgb 写成 32 位打包的 U 字段，与本工具的 PCD 解析互为逆运算。 */
        function pcd(data)
        {
            if (data.kind !== 'points') { throw new Error('PCD 只支持点云图层'); }

            var n = pointCountOf(data);
            if (!n) { throw new Error('当前图层没有点'); }

            var col = data.colors;
            var sfs = data.scalars || [];

            var fields = ['x', 'y', 'z'];
            var sizes = [4, 4, 4];
            var types = ['F', 'F', 'F'];
            if (col) { fields.push('rgb'); sizes.push(4); types.push('U'); }
            for (var i = 0; i < sfs.length; i++)
            {
                fields.push(safeName(sfs[i].name, 'sf' + (i + 1)));
                sizes.push(4);
                types.push('F');
            }

            var head = '# .PCD v0.7 - Point Cloud Data file format\n';
            head += 'VERSION 0.7\n';
            head += 'FIELDS ' + fields.join(' ') + '\n';
            head += 'SIZE ' + sizes.join(' ') + '\n';
            head += 'TYPE ' + types.join(' ') + '\n';
            head += 'COUNT ' + fields.map(function () { return 1; }).join(' ') + '\n';
            head += 'WIDTH ' + n + '\nHEIGHT 1\n';
            head += 'VIEWPOINT 0 0 0 1 0 0 0\n';
            head += 'POINTS ' + n + '\n';
            head += 'DATA binary\n';

            var parts = [head];
            var stride = 12 + (col ? 4 : 0) + sfs.length * 4;

            for (var r0 = 0; r0 < n; r0 += CHUNK_ROW)
            {
                var r1 = Math.min(n, r0 + CHUNK_ROW);
                var buf = new ArrayBuffer((r1 - r0) * stride);
                var dv = new DataView(buf);
                var off = 0;

                for (var r = r0; r < r1; r++)
                {
                    dv.setFloat32(off, data.positions[r * 3], true); off += 4;
                    dv.setFloat32(off, data.positions[r * 3 + 1], true); off += 4;
                    dv.setFloat32(off, data.positions[r * 3 + 2], true); off += 4;

                    if (col)
                    {
                        var cr = Math.max(0, Math.min(255, Math.round(col[r * 3] * 255)));
                        var cg = Math.max(0, Math.min(255, Math.round(col[r * 3 + 1] * 255)));
                        var cb = Math.max(0, Math.min(255, Math.round(col[r * 3 + 2] * 255)));
                        dv.setUint32(off, (cr << 16) | (cg << 8) | cb, true);
                        off += 4;
                    }

                    for (var sk = 0; sk < sfs.length; sk++)
                    {
                        var vals = sfs[sk].values;
                        dv.setFloat32(off, vals ? vals[r] : 0, true); off += 4;
                    }
                }
                parts.push(buf);
            }

            return new Blob(parts, { type: 'application/octet-stream' });
        }

        /* ---------------- GLB（glTF 2.0 单文件） ----------------
         * 导出时把 Z 轴向上转回 glTF 的 Y 轴向上：(x, z, -y)，
         * 与载入时的 (x, -z, y) 互为逆运算。 */
        function glb(data)
        {
            if (data.kind !== 'mesh') { throw new Error('GLB 只支持网格图层'); }

            var verts = data.uniqVerts;
            var faces = data.remap;
            if (!verts || !faces) { throw new Error('缺少唯一顶点表，无法导出 GLB'); }

            var vCount = Math.floor(verts.length / 3);
            var triCount = Math.floor(faces.length / 3);
            if (!vCount || !triCount) { throw new Error('当前图层没有三角形'); }

            /* 位置：Z-up -> Y-up */
            var pos = new Float32Array(vCount * 3);
            var mn = [Infinity, Infinity, Infinity];
            var mx = [-Infinity, -Infinity, -Infinity];

            for (var i = 0; i < vCount; i++)
            {
                var x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
                var gx = x, gy = z, gz = -y;

                pos[i * 3] = gx;
                pos[i * 3 + 1] = gy;
                pos[i * 3 + 2] = gz;

                if (gx < mn[0]) { mn[0] = gx; }
                if (gy < mn[1]) { mn[1] = gy; }
                if (gz < mn[2]) { mn[2] = gz; }
                if (gx > mx[0]) { mx[0] = gx; }
                if (gy > mx[1]) { mx[1] = gy; }
                if (gz > mx[2]) { mx[2] = gz; }
            }

            var idx = new Uint32Array(triCount * 3);
            for (var t = 0; t < triCount * 3; t++) { idx[t] = faces[t]; }

            var col = vertexColors(data, vCount);

            /* 组装 BIN：位置 → 索引 → 颜色，每段按 4 字节对齐 */
            var posBytes = pos.byteLength;
            var idxBytes = idx.byteLength;
            var colBytes = col ? col.byteLength : 0;
            var binLength = posBytes + idxBytes + colBytes;

            var bin = new Uint8Array(binLength);
            bin.set(new Uint8Array(pos.buffer, pos.byteOffset, posBytes), 0);
            bin.set(new Uint8Array(idx.buffer, idx.byteOffset, idxBytes), posBytes);
            if (col)
            {
                bin.set(new Uint8Array(col.buffer, col.byteOffset, colBytes), posBytes + idxBytes);
            }

            var bufferViews = [
                { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
                { buffer: 0, byteOffset: posBytes, byteLength: idxBytes, target: 34963 }
            ];
            var accessors = [
                {
                    bufferView: 0, componentType: 5126, count: vCount, type: 'VEC3',
                    min: [mn[0], mn[1], mn[2]], max: [mx[0], mx[1], mx[2]]
                },
                { bufferView: 1, componentType: 5125, count: triCount * 3, type: 'SCALAR' }
            ];
            var attrs = { POSITION: 0 };

            if (col)
            {
                bufferViews.push({
                    buffer: 0, byteOffset: posBytes + idxBytes, byteLength: colBytes, target: 34962
                });
                accessors.push({
                    bufferView: 2, componentType: 5126, count: vCount, type: 'VEC3'
                });
                attrs.COLOR_0 = 2;
            }

            var gltf = {
                asset: { version: '2.0', generator: '3DViewer' },
                scene: 0,
                scenes: [{ nodes: [0] }],
                nodes: [{ mesh: 0 }],
                meshes: [{ primitives: [{ attributes: attrs, indices: 1 }] }],
                buffers: [{ byteLength: binLength }],
                bufferViews: bufferViews,
                accessors: accessors
            };

            var jsonStr = JSON.stringify(gltf);
            var jsonBytes = new global.TextEncoder().encode(jsonStr);
            var jsonPad = (4 - (jsonBytes.length % 4)) % 4;
            var binPad = (4 - (binLength % 4)) % 4;

            var total = 12 + 8 + jsonBytes.length + jsonPad + 8 + binLength + binPad;
            var out = new ArrayBuffer(total);
            var dv = new DataView(out);
            var u8 = new Uint8Array(out);

            dv.setUint32(0, 0x46546C67, true);      /* 'glTF' */
            dv.setUint32(4, 2, true);
            dv.setUint32(8, total, true);

            dv.setUint32(12, jsonBytes.length + jsonPad, true);
            dv.setUint32(16, 0x4E4F534A, true);     /* 'JSON' */
            u8.set(jsonBytes, 20);
            for (var jp = 0; jp < jsonPad; jp++) { u8[20 + jsonBytes.length + jp] = 0x20; }

            var binOff = 20 + jsonBytes.length + jsonPad;
            dv.setUint32(binOff, binLength + binPad, true);
            dv.setUint32(binOff + 4, 0x004E4942, true);  /* 'BIN' */
            u8.set(bin, binOff + 8);

            return new Blob([out], { type: 'model/gltf-binary' });
        }

        global.MV.exporters = {
            stlBinary: stlBinary,
            objText: objText,
            pointsText: pointsText,
            ply: ply,
            pcd: pcd,
            glb: glb,
            /* 供 UI 判断按钮是否可用 */
            triCount: triCountOf,
            pointCount: pointCountOf
        };
    })();

})(window);