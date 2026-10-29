/* L4 渲染层 | render：WebGL 与视角器
 * 允许依赖：core
 * 禁止依赖：DOM 面板（除 own canvas）/ MV.app 状态
 * 导出：MV.Renderer（类）、MV.render.installAppMethods（视角器 App 方法）
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    /* ---- 分层契约：渲染层不直接操作界面，通过 app 注入的 hooks 通知 ---- */
    var renderHooks = {
        notify: function () {},
        refreshProps: function () {}
    };

    function bindRenderHooks(h)
    {
        if (!h) { return; }
        for (var k in renderHooks)
        {
            if (typeof h[k] === 'function') { renderHooks[k] = h[k]; }
        }
    }

    /* ==================== WebGL 渲染（原 renderer.js） ==================== */

    var MESH_VS = [
        '#version 300 es',
        'precision highp float;',
        'in vec3 aPos;',
        'uniform mat4 uMVP;',
        'uniform mat4 uView;',
        'out vec3 vViewPos;',
        'void main()',
        '{',
        '    vViewPos = (uView * vec4(aPos, 1.0)).xyz;',
        '    gl_Position = uMVP * vec4(aPos, 1.0);',
        '}'
    ].join('\n');

    var MESH_FS = [
        '#version 300 es',
        'precision highp float;',
        'in vec3 vViewPos;',
        'uniform vec4 uColor;',
        'uniform vec4 uBackColor;',     // 背面颜色（uTwoSided=1 时生效）
        'uniform vec3 uLightView;',
        'uniform int uShade;',
        'uniform int uBackShade;',
        'uniform int uTwoSided;',       // 1 = 一次绘制正/背面（不透明图层的快路径）
        'out vec4 fragColor;',
        'void main()',
        '{',
        '    vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));',
        '    vec4 col = uColor;',
        '    int sm = uShade;',
        '    if (uTwoSided == 1 && !gl_FrontFacing)',
        '    {',
        '        col = uBackColor;',
        '        sm = uBackShade;',
        '    }',
        '    vec3 base;',
        '    if (sm == 2)',
        '    {',
        '        // 按法向：法向编码为 RGB（n 由屏幕空间导数求得，总朝相机）',
        '        base = n * 0.5 + 0.5;',
        '    }',
        '    else if (sm == 1)',
        '    {',
        '        // 光照：按面法向与光照方向做单向漫反射，背光面为黑',
        '        float diff = max(dot(n, uLightView), 0.0);',
        '        base = col.rgb * (0.08 + 0.92 * diff);',
        '    }',
        '    else',
        '    {',
        '        base = col.rgb;',
        '    }',
        '    fragColor = vec4(base, col.a);',
        '}'
    ].join('\n');

    var POINT_VS = [
        '#version 300 es',
        'precision highp float;',
        'in vec3 aPos;',
        'in vec3 aAux;',
        'in float aTag;',
        'in vec3 aCol;',
        'in float aSF;',
        'uniform mat4 uMVP;',
        'uniform mat4 uView;',
        'uniform float uPointSize;',
        'uniform float uDepthBias;',
        'uniform int uColorMode;',
        'uniform vec3 uColor;',
        'uniform float uZMin;',
        'uniform float uZMax;',
        'uniform float uSFMin;',
        'uniform float uSFMax;',
        'out vec3 vColor;',
        'vec3 hsv2rgb(vec3 c)',
        '{',
        '    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);',
        '    return c.z * mix(vec3(1.0), rgb, c.y);',
        '}',
        'uniform int uRamp;',
        'vec3 rampJet(float t)',
        '{',
        '    vec3 c0 = vec3(0.15, 0.30, 0.95);',
        '    vec3 c1 = vec3(0.10, 0.85, 0.90);',
        '    vec3 c2 = vec3(0.25, 0.90, 0.35);',
        '    vec3 c3 = vec3(1.00, 0.85, 0.15);',
        '    vec3 c4 = vec3(0.98, 0.22, 0.18);',
        '    if (t < 0.25) { return mix(c0, c1, t / 0.25); }',
        '    if (t < 0.50) { return mix(c1, c2, (t - 0.25) / 0.25); }',
        '    if (t < 0.75) { return mix(c2, c3, (t - 0.50) / 0.25); }',
        '    return mix(c3, c4, (t - 0.75) / 0.25);',
        '}',
        'vec3 rampBGR(float t)',
        '{',
        '    vec3 a = vec3(0.16, 0.34, 0.90);',
        '    vec3 b = vec3(0.16, 0.78, 0.44);',
        '    vec3 c = vec3(0.90, 0.22, 0.18);',
        '    if (t < 0.5) { return mix(a, b, t / 0.5); }',
        '    return mix(b, c, (t - 0.5) / 0.5);',
        '}',
        'vec3 rampGray(float t)',
        '{',
        '    return vec3(mix(0.08, 0.94, t));',
        '}',
        'vec3 rampBWR(float t)',
        '{',
        '    vec3 a = vec3(0.14, 0.36, 0.88);',
        '    vec3 b = vec3(0.96, 0.96, 0.96);',
        '    vec3 c = vec3(0.86, 0.20, 0.18);',
        '    if (t < 0.5) { return mix(a, b, t / 0.5); }',
        '    return mix(b, c, (t - 0.5) / 0.5);',
        '}',
        'vec3 ramp(float t)',
        '{',
        '    if (uRamp == 1) { return rampBGR(t); }',
        '    if (uRamp == 2) { return rampGray(t); }',
        '    if (uRamp == 3) { return rampBWR(t); }',
        '    return rampJet(t);',
        '}',
        'void main()',
        '{',
        '    vec3 c = uColor;',
        '    if (uColorMode == 1)',
        '    {',
        '        float t = clamp((aPos.z - uZMin) / max(uZMax - uZMin, 1e-6), 0.0, 1.0);',
        '        c = ramp(t);',
        '    }',
        '    else if (uColorMode == 2)',
        '    {',
        '        // 按法向：法向编码为 RGB，同时按"法向 vs 视线"做朝向衰减，背向视线的点为黑',
        '        vec3 n = normalize(aAux);',
        '        vec3 nv = normalize(mat3(uView) * n);',
        '        float facing = dot(nv, normalize(-(uView * vec4(aPos, 1.0)).xyz));',
        '        c = (n * 0.5 + 0.5) * (0.05 + 0.95 * max(facing, 0.0));',
        '    }',
        '    else if (uColorMode == 3)',
        '    {',
        '        float h = fract(sin(aTag * 12.9898 + 4.1414) * 43758.5453);',
        '        c = hsv2rgb(vec3(h, 0.62, 0.98));',
        '    }',
        '    else if (uColorMode == 4)',
        '    {',
        '        c = aCol;',
        '    }',
        '    else if (uColorMode == 5)',
        '    {',
        '        float t = clamp((aSF - uSFMin) / max(uSFMax - uSFMin, 1e-12), 0.0, 1.0);',
        '        c = ramp(t);',
        '    }',
        '    vColor = c;',
        '    gl_Position = uMVP * vec4(aPos, 1.0);',
        '    gl_Position.z -= uDepthBias * gl_Position.w;',
        '    gl_PointSize = uPointSize;',
        '}'
    ].join('\n');

    var POINT_FS = [
        '#version 300 es',
        'precision highp float;',
        'in vec3 vColor;',
        'uniform float uAlpha;',
        'uniform int uRound;',
        'out vec4 fragColor;',
        'void main()',
        '{',
        '    if (uRound == 1)',
        '    {',
        '        vec2 d = gl_PointCoord - vec2(0.5);',
        '        if (dot(d, d) > 0.25) { discard; }',
        '    }',
        '    fragColor = vec4(vColor, uAlpha);',
        '}'
    ].join('\n');

    var LINE_VS = [
        '#version 300 es',
        'precision highp float;',
        'in vec3 aPos;',
        'uniform mat4 uMVP;',
        'uniform float uDepthBias;',
        'void main()',
        '{',
        '    gl_Position = uMVP * vec4(aPos, 1.0);',
        '    gl_Position.z -= uDepthBias * gl_Position.w;',
        '}'
    ].join('\n');

    var LINE_FS = [
        '#version 300 es',
        'precision highp float;',
        'uniform vec4 uColor;',
        'out vec4 fragColor;',
        'void main()',
        '{',
        '    fragColor = uColor;',
        '}'
    ].join('\n');

    function compile(gl, type, src)
    {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        {
            var log = gl.getShaderInfoLog(sh);
            gl.deleteShader(sh);
            throw new Error('着色器编译失败: ' + log);
        }
        return sh;
    }

    function program(gl, vsSrc, fsSrc)
    {
        var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
        var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
        var p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        {
            throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
        }
        return p;
    }

    function uniforms(gl, p, names)
    {
        var out = {};
        for (var i = 0; i < names.length; i++)
        {
            out[names[i]] = gl.getUniformLocation(p, names[i]);
        }
        return out;
    }

    /* 空间分块：按三角形质心分配到 N×N×N 格，重排索引让同格三角形连续
     * 与「按顺序切块」相比，每块 AABB 只覆盖局部区域，视锥剔除率高得多 */
    function buildSpaceChunks(ix, tri)
    {
        var N = Math.max(3, Math.min(8, Math.round(Math.cbrt(tri / 4000)) || 3));

        var mnx = Infinity, mny = Infinity, mnz = Infinity;
        var mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        var i;
        for (i = 0; i < ix.vcount; i++)
        {
            var vx = ix.verts[i * 3], vy = ix.verts[i * 3 + 1], vz = ix.verts[i * 3 + 2];
            if (vx < mnx) { mnx = vx; } if (vx > mxx) { mxx = vx; }
            if (vy < mny) { mny = vy; } if (vy > mxy) { mxy = vy; }
            if (vz < mnz) { mnz = vz; } if (vz > mxz) { mxz = vz; }
        }

        var sx = ((mxx - mnx) / N) || 1;
        var sy = ((mxy - mny) / N) || 1;
        var sz = ((mxz - mnz) / N) || 1;
        var grid = new Array(N * N * N);

        for (var t = 0; t < tri; t++)
        {
            // 索引数组是「每三角形 3 个」，不是 positions 的 9 float 步长
            var a0 = ix.idx[t * 3] * 3, a1 = ix.idx[t * 3 + 1] * 3, a2 = ix.idx[t * 3 + 2] * 3;
            var cx = (ix.verts[a0] + ix.verts[a1] + ix.verts[a2]) / 3;
            var cy = (ix.verts[a0 + 1] + ix.verts[a1 + 1] + ix.verts[a2 + 1]) / 3;
            var cz = (ix.verts[a0 + 2] + ix.verts[a1 + 2] + ix.verts[a2 + 2]) / 3;

            var gi = Math.min(N - 1, Math.max(0, Math.floor((cx - mnx) / sx)));
            var gj = Math.min(N - 1, Math.max(0, Math.floor((cy - mny) / sy)));
            var gk = Math.min(N - 1, Math.max(0, Math.floor((cz - mnz) / sz)));
            var key = (gi * N + gj) * N + gk;

            if (!grid[key]) { grid[key] = []; }
            grid[key].push(t);
        }

        var newIdx = new Uint32Array(tri * 3);
        var chunks = [];
        var w = 0;

        for (var ck = 0; ck < grid.length; ck++)
        {
            var list = grid[ck];
            if (!list) { continue; }

            var start = w;
            var cmnx = Infinity, cmny = Infinity, cmnz = Infinity;
            var cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;

            for (var q = 0; q < list.length; q++)
            {
                var o2 = list[q] * 3;
                for (var k = 0; k < 3; k++)
                {
                    var id = ix.idx[o2 + k];
                    newIdx[w++] = id;
                    var vo = id * 3;
                    var qx = ix.verts[vo], qy = ix.verts[vo + 1], qz = ix.verts[vo + 2];
                    if (qx < cmnx) { cmnx = qx; } if (qx > cmxx) { cmxx = qx; }
                    if (qy < cmny) { cmny = qy; } if (qy > cmxy) { cmxy = qy; }
                    if (qz < cmnz) { cmnz = qz; } if (qz > cmxz) { cmxz = qz; }
                }
            }

            chunks.push({
                count: w - start,
                offset: start * 4,
                mnx: cmnx, mny: cmny, mnz: cmnz,
                mxx: cmxx, mxy: cmxy, mxz: cmxz
            });
        }

        return { idx: newIdx, chunks: chunks, n: N };
    }

    /* 从 MVP 提取 6 个视锥平面（Gribb–Hartmann，列主序：m 的前 4 个是第 1 列） */
    function frustumFromMVP(m)
    {
        var r0 = [m[0], m[4], m[8], m[12]];
        var r1 = [m[1], m[5], m[9], m[13]];
        var r2 = [m[2], m[6], m[10], m[14]];
        var r3 = [m[3], m[7], m[11], m[15]];

        function nrm(a)
        {
            var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
            return [a[0] / l, a[1] / l, a[2] / l, a[3] / l];
        }

        return [
            nrm([r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]]),
            nrm([r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]]),
            nrm([r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]]),
            nrm([r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]]),
            nrm([r3[0] + r2[0], r3[1] + r2[1], r3[2] + r2[2], r3[3] + r2[3]]),
            nrm([r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]])
        ];
    }

    /* AABB 是否与 6 个平面相交（保守：假阳性可以，绝不漏画） */
    function aabbVisible(c, planes)
    {
        if (!isFinite(c.mnx) || !isFinite(c.mxx))
        {
            return true;                 // 包围盒无效时一律画，宁可多画也不漏
        }
        for (var i = 0; i < 6; i++)
        {
            var p = planes[i];
            var x = p[0] > 0 ? c.mxx : c.mnx;
            var y = p[1] > 0 ? c.mxy : c.mny;
            var z = p[2] > 0 ? c.mxz : c.mnz;
            if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0)
            {
                return false;
            }
        }
        return true;
    }

    /* 顶点去重 + 索引化：非索引三角面（9 float/三角）→ (verts, idx)
     * 量化键 Q=1e4（mm 级坐标 = 0.1 μm 精度），只用于判重，顶点坐标保留原值 */
    function buildIndexed(positions)
    {
        var tri = Math.floor(positions.length / 9);
        var map = new Map();
        var verts = new Float32Array(tri * 9);
        var idx = new Uint32Array(tri * 3);
        var n = 0;
        var Q = 1e4;

        for (var t = 0; t < tri; t++)
        {
            for (var k = 0; k < 3; k++)
            {
                var o = t * 9 + k * 3;
                var x = positions[o];
                var y = positions[o + 1];
                var z = positions[o + 2];
                var key = Math.round(x * Q) + ',' + Math.round(y * Q) + ',' + Math.round(z * Q);
                var id = map.get(key);
                if (id === undefined)
                {
                    id = n++;
                    verts[id * 3] = x;
                    verts[id * 3 + 1] = y;
                    verts[id * 3 + 2] = z;
                    map.set(key, id);
                }
                idx[t * 3 + k] = id;
            }
        }

        return { verts: verts.subarray(0, n * 3), idx: idx, vcount: n };
    }

    function Renderer(canvas)
    {

        // 上下文丢失/恢复：显存被驱动或系统回收时不再黑屏到刷新
        var self = this;
        this.contextLost = false;
        this.onContextEvent = null;      // app 注入：('lost' | 'restored')

        canvas.addEventListener('webglcontextlost', function (e)
        {
            e.preventDefault();          // 必须阻止默认行为，否则不会触发 restored
            self.contextLost = true;
            if (self.onContextEvent) { self.onContextEvent('lost'); }
        }, false);

        canvas.addEventListener('webglcontextrestored', function ()
        {
            self.contextLost = true;
            if (self.init())             // 重建 program / uniform / attribute 位置
            {
                self.contextLost = false;
                if (self.onContextEvent) { self.onContextEvent('restored'); }
            }
        }, false);

        this.canvas = canvas;
        this.gl = null;
        this.idxOk = true;   // 索引值域自检结果（false = 曾有越界）
        this.ready = false;
        this.stats = { triangles: 0, points: 0, draws: 0, meshCalls: 0, wireCalls: 0, vertCalls: 0, normalCalls: 0, boundaryCalls: 0, chunksDrawn: 0, chunksTotal: 0 };

        // 编辑选区预览
        this.previewGeo = null;
        this.previewVao = null;
        this.previewBuffer = null;
        this.previewCount = 0;

        // 拾取十字标记：恒定世界尺寸，单臂 1（数据单位，本工程为 mm）
        this.pickMarkLen = 1;
        this.gridCache = { key: '', buffer: null, count: 0 };
        this.axisBuffer = null;
        this.error = '';
    }

    Renderer.prototype.init = function ()
    {
        var gl = this.canvas.getContext('webgl2', {
            antialias: true,
            alpha: false,
            depth: true,
            powerPreference: 'high-performance'
        });

        if (!gl)
        {
            this.error = '当前浏览器不支持 WebGL2，请使用 Chrome / Edge 最新版';
            return false;
        }
        this.gl = gl;

        var meshP = program(gl, MESH_VS, MESH_FS);
        var pointP = program(gl, POINT_VS, POINT_FS);
        var lineP = program(gl, LINE_VS, LINE_FS);

        this.meshP = meshP;
        this.pointP = pointP;
        this.lineP = lineP;

        this.meshA = { pos: gl.getAttribLocation(meshP, 'aPos') };
        this.pointA = {
            pos: gl.getAttribLocation(pointP, 'aPos'),
            aux: gl.getAttribLocation(pointP, 'aAux'),
            tag: gl.getAttribLocation(pointP, 'aTag'),
            col: gl.getAttribLocation(pointP, 'aCol'),
            sf: gl.getAttribLocation(pointP, 'aSF')
        };
        this.lineA = { pos: gl.getAttribLocation(lineP, 'aPos') };


        this.meshU = uniforms(gl, meshP, ['uMVP', 'uView', 'uColor', 'uBackColor',
            'uLightView', 'uShade', 'uBackShade', 'uTwoSided']);
        this.pointU = uniforms(gl, pointP, ['uMVP', 'uView', 'uPointSize', 'uDepthBias', 'uColorMode',
            'uColor', 'uZMin', 'uZMax', 'uSFMin', 'uSFMax', 'uRamp', 'uAlpha', 'uRound']);
        this.lineU = uniforms(gl, lineP, ['uMVP', 'uColor', 'uDepthBias']);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this.ready = true;
        return true;
    };

    /* ---------------- 资源上传 ---------------- */
    Renderer.prototype.uploadLayer = function (layer)
    {
        if (!this.ready || layer.gpu || layer._uploadFailed)
        {
            return;
        }
        var gl = this.gl;
        var d = layer.data;

        if (d.kind === 'mesh')
        {
            // 索引化：顶点去重后上传 + 索引缓冲（显存约降 50%，顶点着色器调用大减）
            var ix = buildIndexed(d.positions);

            // 空间分块：按质心分格 + 重排索引（同格三角形连续，AABB 更紧凑）
            var sc = buildSpaceChunks(ix, d.count);

            // 自检：索引值域越界会让三角形塌到顶点 0（画面破碎但 err=0、面数也对）
            var badIdx = 0;
            for (var bi = 0; bi < sc.idx.length; bi++)
            {
                if (sc.idx[bi] >= ix.vcount) { badIdx++; }
            }
            if (badIdx > 0)
            {
                this.idxOk = false;
                layer._uploadFailed = true;
                if (renderHooks && renderHooks.notify)
                {
                    renderHooks.notify('内部错误：索引越界 ' + badIdx + ' 处（顶点数 ' + ix.vcount +
                        '，索引上限 ' + (sc.idx.length / 3 | 0) * 3 + '），已跳过该图层');
                }
                return;
            }

            var vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            var pb = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, pb);
            gl.bufferData(gl.ARRAY_BUFFER, ix.verts, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(this.meshA.pos);
            gl.vertexAttribPointer(this.meshA.pos, 3, gl.FLOAT, false, 0, 0);

            var ib = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sc.idx, gl.STATIC_DRAW);
            gl.bindVertexArray(null);

            layer.gpu = {
                refs: 1,
                vao: vao,
                posBuffer: pb,
                indexBuffer: ib,
                srcIndex: ix.idx,          // CPU 侧保留，供线框生成边索引
                indexed: true,
                vertCount: ix.vcount,
                triCount: d.count,
                chunks: sc.chunks,
                normalVao: null,
                normalBuffer: null,
                normalCount: 0
            };
        }
        else
        {
            var pbuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, pbuf);
            gl.bufferData(gl.ARRAY_BUFFER, d.positions, gl.STATIC_DRAW);

            var auxBuf = null;
            if (d.normals)
            {
                auxBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, auxBuf);
                gl.bufferData(gl.ARRAY_BUFFER, d.normals, gl.STATIC_DRAW);
            }

            var tagBuf = null;
            if (d.tags)
            {
                tagBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, tagBuf);
                gl.bufferData(gl.ARRAY_BUFFER, d.tags, gl.STATIC_DRAW);
            }

            var colBuf = null;
            if (d.colors)
            {
                colBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
                gl.bufferData(gl.ARRAY_BUFFER, d.colors, gl.STATIC_DRAW);
            }

            // 同一批点共用 position/aux/tag/col，按标量场各建一个 VAO（只多绑一个 aSF）
            var R = this;
            var buildPointVao = function (sfBuf)
            {
                var v = gl.createVertexArray();
                gl.bindVertexArray(v);

                gl.bindBuffer(gl.ARRAY_BUFFER, pbuf);
                gl.enableVertexAttribArray(R.pointA.pos);
                gl.vertexAttribPointer(R.pointA.pos, 3, gl.FLOAT, false, 0, 0);

                if (auxBuf)
                {
                    gl.bindBuffer(gl.ARRAY_BUFFER, auxBuf);
                    gl.enableVertexAttribArray(R.pointA.aux);
                    gl.vertexAttribPointer(R.pointA.aux, 3, gl.FLOAT, false, 0, 0);
                }
                else
                {
                    gl.disableVertexAttribArray(R.pointA.aux);
                }

                if (tagBuf)
                {
                    gl.bindBuffer(gl.ARRAY_BUFFER, tagBuf);
                    gl.enableVertexAttribArray(R.pointA.tag);
                    gl.vertexAttribPointer(R.pointA.tag, 1, gl.FLOAT, false, 0, 0);
                }
                else
                {
                    gl.disableVertexAttribArray(R.pointA.tag);
                }

                if (colBuf)
                {
                    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
                    gl.enableVertexAttribArray(R.pointA.col);
                    gl.vertexAttribPointer(R.pointA.col, 3, gl.FLOAT, false, 0, 0);
                }
                else
                {
                    gl.disableVertexAttribArray(R.pointA.col);
                }

                if (sfBuf)
                {
                    gl.bindBuffer(gl.ARRAY_BUFFER, sfBuf);
                    gl.enableVertexAttribArray(R.pointA.sf);
                    gl.vertexAttribPointer(R.pointA.sf, 1, gl.FLOAT, false, 0, 0);
                }
                else
                {
                    gl.disableVertexAttribArray(R.pointA.sf);
                }

                gl.bindVertexArray(null);
                return v;
            };

            var vao2 = buildPointVao(null);
            var sfVao = null;
            var sfBufs = null;
            if (d.scalars && d.scalars.length > 0)
            {
                sfVao = [];
                sfBufs = [];
                for (var sfi = 0; sfi < d.scalars.length; sfi++)
                {
                    var sb = gl.createBuffer();
                    gl.bindBuffer(gl.ARRAY_BUFFER, sb);
                    gl.bufferData(gl.ARRAY_BUFFER, d.scalars[sfi].values, gl.STATIC_DRAW);
                    sfBufs.push(sb);
                    sfVao.push(buildPointVao(sb));
                }
            }

            layer.gpu = {
                refs: 1,
                vao: vao2,
                posBuffer: pbuf,
                auxBuffer: auxBuf,
                tagBuffer: tagBuf,
                colBuffer: colBuf,
                sfVao: sfVao,
                sfBuffer: sfBufs,
                count: d.count
            };
        }

        // 上传后检查 GL 错误：显存不足 / 驱动拒绝时不要静默失败成白屏
        var upErr = gl.getError();
        if (upErr !== gl.NO_ERROR)
        {
            layer.gpu = null;
            layer._uploadFailed = true;
            if (renderHooks && renderHooks.notify)
            {
                renderHooks.notify('上传失败（GL 0x' + upErr.toString(16) + '）：' +
                    (layer.name || '图层') +
                    '，多为显存不足。可缩小数据量，或用 ?maxtri= / ?maxpts= 限制后重试');
            }
            if (global.MV.ui && global.MV.ui.renderTree)
            {
                global.MV.ui.renderTree();
            }
            return;
        }
    };

    Renderer.prototype.releaseLayer = function (layer)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!gl || !g)
        {
            return;
        }
        layer.gpu = null;

        // 共享 GPU 资源（同一文件同时载入左右两侧）按引用计数释放
        if (g.refs && g.refs > 1)
        {
            g.refs--;
            return;
        }

        if (g.vao) { gl.deleteVertexArray(g.vao); }
        if (g.posBuffer) { gl.deleteBuffer(g.posBuffer); }
        if (g.auxBuffer) { gl.deleteBuffer(g.auxBuffer); }
        if (g.tagBuffer) { gl.deleteBuffer(g.tagBuffer); }
        if (g.colBuffer) { gl.deleteBuffer(g.colBuffer); }
        if (g.normalVao) { gl.deleteVertexArray(g.normalVao); }
        if (g.normalBuffer) { gl.deleteBuffer(g.normalBuffer); }
        if (g.wireVao) { gl.deleteVertexArray(g.wireVao); }
        if (g.wireBuffer) { gl.deleteBuffer(g.wireBuffer); }
        if (g.vertVao) { gl.deleteVertexArray(g.vertVao); }
        if (g.vertBuffer) { gl.deleteBuffer(g.vertBuffer); }
        if (g.sfVao)
        {
            for (var vi = 0; vi < g.sfVao.length; vi++)
            {
                gl.deleteVertexArray(g.sfVao[vi]);
            }
        }
        if (g.sfBuffer)
        {
            for (var bi = 0; bi < g.sfBuffer.length; bi++)
            {
                gl.deleteBuffer(g.sfBuffer[bi]);
            }
        }
        if (g.boundaryVao) { gl.deleteVertexArray(g.boundaryVao); }
        if (g.boundaryBuffer) { gl.deleteBuffer(g.boundaryBuffer); }
    };

    /* ---------------- 法向线段 ---------------- */
    Renderer.prototype.ensureNormals = function (layer, lengthScale)
    {
        if (!layer.gpu || layer.data.kind !== 'mesh')
        {
            return;
        }
        var g = layer.gpu;
        var key = String(lengthScale);
        if (g.normalVao && g.normalKey === key)
        {
            return;
        }
        if (g.normalVao)
        {
            this.gl.deleteVertexArray(g.normalVao);
            this.gl.deleteBuffer(g.normalBuffer);
            g.normalVao = null;
            g.normalBuffer = null;
        }

        var gl = this.gl;
        var pos = layer.data.positions;
        var tri = Math.floor(pos.length / 9);
        if (tri <= 0)
        {
            return;
        }

        // 逐个面计算法向；默认不抽稀（maxFaces = Infinity），仅显式限制时才按步长抽样
        var maxFaces = Number.POSITIVE_INFINITY;
        var stride = Math.max(1, Math.ceil(tri / maxFaces));
        var n = Math.floor((tri + stride - 1) / stride);
        var out = new Float32Array(n * 6);

        // 法向长度按平均边长缩放，使长度与面尺寸相关
        var probe = Math.max(1, Math.floor(tri / 512));
        var sumEdge = 0;
        var cntEdge = 0;
        for (var q = 0; q < tri; q += probe)
        {
            var oq = q * 9;
            var ex = pos[oq + 3] - pos[oq];
            var ey = pos[oq + 4] - pos[oq + 1];
            var ez = pos[oq + 5] - pos[oq + 2];
            var fx = pos[oq + 6] - pos[oq + 3];
            var fy = pos[oq + 7] - pos[oq + 4];
            var fz = pos[oq + 8] - pos[oq + 5];
            var gx = pos[oq] - pos[oq + 6];
            var gy = pos[oq + 1] - pos[oq + 7];
            var gz = pos[oq + 2] - pos[oq + 8];
            sumEdge += (Math.sqrt(ex * ex + ey * ey + ez * ez)
                + Math.sqrt(fx * fx + fy * fy + fz * fz)
                + Math.sqrt(gx * gx + gy * gy + gz * gz)) / 3;
            cntEdge++;
        }
        var avgEdge = cntEdge > 0 ? sumEdge / cntEdge : 1;
        if (!(avgEdge > 0))
        {
            avgEdge = 1;
        }
        var len = avgEdge * 1.2 * lengthScale;

        var w = 0;
        for (var i = 0; i < tri; i += stride)
        {
            var o = i * 9;
            var x0 = pos[o], y0 = pos[o + 1], z0 = pos[o + 2];
            var x1 = pos[o + 3], y1 = pos[o + 4], z1 = pos[o + 5];
            var x2 = pos[o + 6], y2 = pos[o + 7], z2 = pos[o + 8];

            var ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
            var bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
            var nx = ay * bz - az * by;
            var ny = az * bx - ax * bz;
            var nz = ax * by - ay * bx;
            var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nl < 1e-12)
            {
                continue;
            }
            nx /= nl; ny /= nl; nz /= nl;

            var cx = (x0 + x1 + x2) / 3;
            var cy = (y0 + y1 + y2) / 3;
            var cz = (z0 + z1 + z2) / 3;

            out[w++] = cx;
            out[w++] = cy;
            out[w++] = cz;
            out[w++] = cx + nx * len;
            out[w++] = cy + ny * len;
            out[w++] = cz + nz * len;
        }

        var vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, w), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.lineA.pos);
        gl.vertexAttribPointer(this.lineA.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        g.normalVao = vao;
        g.normalBuffer = buf;
        g.normalCount = Math.floor(w / 6);
        g.normalKey = key;
    };

    /* ---------------- 网格 / 坐标轴 ---------------- */
    Renderer.prototype.ensureGrid = function (bbox)
    {
        var gl = this.gl;
        var B = global.MV.math.BBox;
        var c = B.center(bbox);
        var size = B.size(bbox);
        var extent = Math.max(size[0], size[1], size[2]);
        if (!(extent > 0))
        {
            extent = 100;
        }

        var raw = extent / 8;
        var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
        var norm = raw / pow;
        var step = (norm < 2 ? 2 : (norm < 5 ? 5 : 10)) * pow;

        var z = bbox.min[2];
        var half = Math.ceil(extent * 0.8 / step) * step;
        var cx = c[0], cy = c[1];

        var key = [step.toFixed(6), half.toFixed(6), z.toFixed(6), cx.toFixed(6), cy.toFixed(6)].join('|');
        if (this.gridCache.key === key && this.gridCache.buffer)
        {
            return;
        }

        var pts = [];
        for (var v = -half; v <= half + 1e-9; v += step)
        {
            pts.push(cx + v, cy - half, z, cx + v, cy + half, z);
            pts.push(cx - half, cy + v, z, cx + half, cy + v, z);
        }

        if (this.gridCache.buffer)
        {
            gl.deleteBuffer(this.gridCache.buffer);
        }
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);

        var vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.enableVertexAttribArray(this.lineA.pos);
        gl.vertexAttribPointer(this.lineA.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        if (this.gridCache.vao)
        {
            gl.deleteVertexArray(this.gridCache.vao);
        }

        this.gridCache = {
            key: key,
            buffer: buf,
            vao: vao,
            count: pts.length / 3,
            step: step
        };
    };

    Renderer.prototype.ensureAxis = function (len)
    {
        var gl = this.gl;
        if (this.axisBuffer && this.axisLen === len)
        {
            return;
        }
        if (this.axisBuffer)
        {
            gl.deleteVertexArray(this.axisBuffer);
            gl.deleteBuffer(this.axisBufData);
        }
        var vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 0, 0, len, 0, 0,
            0, 0, 0, 0, len, 0,
            0, 0, 0, 0, 0, len
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.lineA.pos);
        gl.vertexAttribPointer(this.lineA.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.axisBuffer = vao;
        this.axisBufData = buf;
        this.axisLen = len;
    };

    /* ---------------- 绘制 ---------------- */
    Renderer.prototype.drawMesh = function (layer, mvp, view, color, shade, pushBack, noStat, backCol, backShade)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!g || !g.triCount)
        {
            return;
        }

        if (pushBack)
        {
            // 面片整体后移，让共面的线框/顶点/边界始终压在上面（不依赖视距）
            // factor 保持 0：斜率项在倾斜面上可能为负，会把面片反向推近而盖住线
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(1.5, 2.0);
        }

        gl.useProgram(this.meshP);
        gl.uniformMatrix4fv(this.meshU.uMVP, false, mvp);
        gl.uniformMatrix4fv(this.meshU.uView, false, view);
        gl.uniform4fv(this.meshU.uColor, color);
        // 双面一次绘制：背面用 uBackColor / uBackShade（见 drawMeshLayer 快路径）
        gl.uniform4fv(this.meshU.uBackColor, backCol || color);
        gl.uniform1i(this.meshU.uBackShade, (backShade === undefined || backShade === null) ? shade : backShade);
        gl.uniform1i(this.meshU.uTwoSided, backCol ? 1 : 0);
        gl.uniform3fv(this.meshU.uLightView, this.lightView || [0, 0, 1]);
        gl.uniform1i(this.meshU.uShade, shade);

        gl.bindVertexArray(g.vao);

        // 分块 + 视锥剔除（?cull=0 可关闭以便对比）
        var cullOn = !(global.MV.config && global.MV.config.cull === false);
        if (cullOn && g.chunks && g.chunks.length > 1)
        {
            var planes = frustumFromMVP(mvp);
            var drawn = 0;
            for (var ci3 = 0; ci3 < g.chunks.length; ci3++)
            {
                var ch = g.chunks[ci3];
                if (!aabbVisible(ch, planes))
                {
                    continue;
                }
                gl.drawElements(gl.TRIANGLES, ch.count, gl.UNSIGNED_INT, ch.offset);
                drawn++;
            }
            this.stats.chunksDrawn = (this.stats.chunksDrawn || 0) + drawn;
            this.stats.chunksTotal = (this.stats.chunksTotal || 0) + g.chunks.length;
        }
        else
        {
            gl.drawElements(gl.TRIANGLES, g.triCount * 3, gl.UNSIGNED_INT, 0);
            this.stats.chunksDrawn = (this.stats.chunksDrawn || 0) + 1;
            this.stats.chunksTotal = (this.stats.chunksTotal || 0) + 1;
        }
        gl.bindVertexArray(null);

        if (pushBack)
        {
            gl.disable(gl.POLYGON_OFFSET_FILL);
        }

        if (!noStat)
        {
            this.stats.triangles += g.triCount;
        }
        this.stats.draws++;
        this.stats.meshCalls++;
    };

    /* 按图层当前完整状态绘制网格（面片正/反面、线框、顶点、法向） */
    Renderer.prototype.drawMeshLayer = function (layer, mvp, viewM, ctx, alpha)
    {
        var gl = this.gl;
        var col = [layer.colorRgb[0], layer.colorRgb[1], layer.colorRgb[2], alpha];

        if (layer.showFaces)
        {
            // 正面 / 背面分两遍绘制：绕序由 GPU 判定，两面颜色各自独立
            var pushBack = layer.showWire || layer.showVerts || layer.showBoundary;
            var bc = layer.backColorRgb || [0.69, 0.23, 0.19];
            var backCol = [bc[0], bc[1], bc[2], alpha];
            var shade = layer.shadeMode;
            var backShade = shade;

            if (shade === 2)
            {
                // 按法向模式：正面显示法向 RGB，背面直接黑
                backShade = 0;
                backCol = [0, 0, 0, alpha];
            }

            if (alpha >= 0.999)
            {
                // 快路径：不透明图层一次绘制，正/背面由着色器按 gl_FrontFacing 选色
                // （原先是剔除背面画一遍 + 剔除正面再画一遍，绘制量是两倍）
                gl.disable(gl.CULL_FACE);
                this.drawMesh(layer, mvp, viewM, col, shade, pushBack, false, backCol, backShade);
            }
            else
            {
                // 半透明：仍需两遍（先背面后正面），保证混合顺序
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
                this.drawMesh(layer, mvp, viewM, col, shade, pushBack, false);
                gl.cullFace(gl.FRONT);
                this.drawMesh(layer, mvp, viewM, backCol, backShade, pushBack, true);
                gl.disable(gl.CULL_FACE);
            }
        }
        if (layer.showWire)
        {
            this.drawWire(layer, mvp);
        }
        // 边界线不在这里画：由 renderFrame 在本视图末尾统一绘制（避免被面片绘制状态影响）
        if (layer.showVerts)
        {
            this.drawVerts(layer, mvp, ctx, alpha);
        }
        if (layer.showNormals)
        {
            this.ensureNormals(layer, layer.normalLen);
            this.drawNormals(layer, mvp, Math.min(1, alpha + 0.15));
        }
    };

    /* 线框：为每个三角形生成 3 条边索引（全部面，不做抽稀） */
    Renderer.prototype.ensureWire = function (layer)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!g || !g.triCount || g.wireVao)
        {
            return;
        }

        var tri = g.triCount;
        var buf = new Uint32Array(tri * 6);
        var src = g.srcIndex;          // 索引化后的三角形顶点（去重后编号）
        var LIM = 67108864;            // 2^26：边键 a*LIM+b 不会溢出
        var seen = new Set();          // 共享边只画一次（相邻两个面各有一条，原先重复绘制）
        var w = 0;

        function addEdge(p, q)
        {
            var key = p < q ? p * LIM + q : q * LIM + p;
            if (seen.has(key))
            {
                return;
            }
            seen.add(key);
            buf[w++] = p;
            buf[w++] = q;
        }

        for (var i = 0; i < tri; i++)
        {
            var b = i * 3;
            var a0 = src ? src[b] : b;
            var a1 = src ? src[b + 1] : b + 1;
            var a2 = src ? src[b + 2] : b + 2;
            if (a0 === a1 || a1 === a2 || a2 === a0)
            {
                continue;              // 退化三角形不产生边
            }
            addEdge(a0, a1);
            addEdge(a1, a2);
            addEdge(a2, a0);
        }

        var idx = buf.subarray(0, w);

        var vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuffer);
        gl.enableVertexAttribArray(this.lineA.pos);
        gl.vertexAttribPointer(this.lineA.pos, 3, gl.FLOAT, false, 0, 0);
        var ebo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);

        g.wireVao = vao;
        g.wireBuffer = ebo;
        g.wireCount = w;                  // 唯一端的索引数（= 唯一边数 × 2）
    };

    Renderer.prototype.drawWire = function (layer, mvp)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!g)
        {
            return;
        }
        this.ensureWire(layer);
        if (!g.wireVao)
        {
            return;
        }

        // 独立渲染线框（关面片）时关闭深度测试：显示全部边（含被遮挡部分）
        var xray = !layer.showFaces;
        if (xray)
        {
            gl.disable(gl.DEPTH_TEST);
        }

        var wc = layer.wireColorRgb || [0.20, 0.62, 0.95];
        gl.useProgram(this.lineP);
        gl.uniformMatrix4fv(this.lineU.uMVP, false, mvp);
        gl.uniform1f(this.lineU.uDepthBias, 0.0);
        gl.uniform4f(this.lineU.uColor, wc[0], wc[1], wc[2], 1.0);
        gl.bindVertexArray(g.wireVao);
        gl.drawElements(gl.LINES, g.wireCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);

        gl.enable(gl.DEPTH_TEST);

        this.stats.draws++;
        this.stats.wireCalls++;
    };

    /* 边界边：只被一个三角形使用的边（模型开放边界 / 破洞），按需一次性计算 */
    Renderer.prototype.ensureBoundary = function (layer)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!g || !g.triCount || g.boundaryVao || g.boundaryDone)
        {
            return;
        }
        g.boundaryDone = true;

        var pos = layer.data.positions;
        var tri = g.triCount;
        var bb = layer.data.bbox;
        var rad = 1;
        if (bb && bb.min && bb.max)
        {
            rad = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1],
                bb.max[2] - bb.min[2]) || 1;
        }
        var q = Math.max(rad * 1e-6, 1e-9);

        // 1) 位置去重：量化坐标 -> 代表顶点序号
        var vmap = new Map();
        var vi = new Uint32Array(tri * 3);
        for (var v = 0; v < tri * 3; v++)
        {
            var o = v * 3;
            var key = Math.round(pos[o] / q) + ',' +
                Math.round(pos[o + 1] / q) + ',' +
                Math.round(pos[o + 2] / q);
            var id = vmap.get(key);
            if (id === undefined)
            {
                id = v;
                vmap.set(key, id);
            }
            vi[v] = id;
        }

        // 2) 统计每条边被几个三角形使用
        //    LIM 必须大于"顶点序号最大值"，否则 a*LIM+b 会溢出串键（大网格曾因此误判）
        var edgeUse = new Map();
        var LIM = 67108864;   // 2^26，可容纳 6700 万顶点，乘积 2^26*5e6 仍在安全整数内
        for (var t = 0; t < tri; t++)
        {
            var a = vi[t * 3];
            var b = vi[t * 3 + 1];
            var c = vi[t * 3 + 2];

            // 退化三角形（含重复顶点）不产生有效边
            if (a === b || b === c || c === a)
            {
                continue;
            }

            var e0 = a < b ? a * LIM + b : b * LIM + a;
            var e1 = b < c ? b * LIM + c : c * LIM + b;
            var e2 = c < a ? c * LIM + a : a * LIM + c;
            edgeUse.set(e0, (edgeUse.get(e0) || 0) + 1);
            edgeUse.set(e1, (edgeUse.get(e1) || 0) + 1);
            edgeUse.set(e2, (edgeUse.get(e2) || 0) + 1);
        }

        // 3) 只出现一次的边 = 边界边
        var segs = [];
        edgeUse.forEach(function (cnt, k)
        {
            if (cnt === 1)
            {
                segs.push(k);
            }
        });

        var notifyStat = function ()
        {
            try
            {
                renderHooks.refreshProps();   // 刷新"统计"里的边界边数（由 app 注入）
            }
            catch (e)
            {
                /* ignore */
            }
        };

        if (segs.length === 0)
        {
            g.boundaryEdges = 0;
            notifyStat();
            return;   // 封闭模型，无边界
        }

        // 直接复用网格的顶点缓冲，只额外建一个"边界边"索引缓冲（与线框同一套机制）
        var out = new Uint32Array(segs.length * 2);
        var w = 0;
        // 索引化后 posBuffer 存的是去重顶点；边界边序号基于原始 positions，
        // 必须用 srcIndex 映射一次，否则边界线会连到错误的顶点上
        var vmap2 = g.indexed ? g.srcIndex : null;
        for (var s = 0; s < segs.length; s++)
        {
            var kk = segs[s];
            var ia = Math.floor(kk / LIM);
            var ib = kk - ia * LIM;
            out[w++] = vmap2 ? vmap2[ia] : ia;
            out[w++] = vmap2 ? vmap2[ib] : ib;
        }

        var vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuffer);
        gl.enableVertexAttribArray(this.lineA.pos);
        gl.vertexAttribPointer(this.lineA.pos, 3, gl.FLOAT, false, 0, 0);
        var ebo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, out, gl.STATIC_DRAW);
        gl.bindVertexArray(null);

        g.boundaryVao = vao;
        g.boundaryBuffer = ebo;
        g.boundaryCount = segs.length * 2;   // 索引数
        g.boundaryEdges = segs.length;
        notifyStat();
    };

    Renderer.prototype.drawBoundary = function (layer, mvp)
    {
        var gl = this.gl;
        this.stats.boundaryCalls++;
        var g = layer.gpu;
        if (!g)
        {
            return;
        }
        this.ensureBoundary(layer);
        if (!g.boundaryVao)
        {
            return;
        }

        // 边界属于"检查用"的辅助线：绘制时关闭深度测试，保证任何视角都完整可见
        gl.disable(gl.DEPTH_TEST);

        // 抬升量按模型尺度取（约 3e-4 半径）：足以压过面片，又不会穿透薄板背面
        var bc = layer.boundaryColorRgb || [0.13, 0.83, 0.93];
        gl.useProgram(this.lineP);
        gl.uniformMatrix4fv(this.lineU.uMVP, false, mvp);
        // 裁剪空间前移（乘 w 等价于按视距等比前移），远近视角都稳定可见
        gl.uniform1f(this.lineU.uDepthBias, 0.0008);
        gl.uniform4f(this.lineU.uColor, bc[0], bc[1], bc[2], 1.0);

        // 关键：默认 depthFunc 是 LESS，线与面片深度相等时会被判为"更远"而丢弃；
        // 改成 LEQUAL 让共面的边界线稳定通过（只放行相等或更近，不会穿透背面）
        gl.depthFunc(gl.LEQUAL);
        gl.bindVertexArray(g.boundaryVao);
        gl.drawElements(gl.LINES, g.boundaryCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
        gl.depthFunc(gl.LESS);

        gl.enable(gl.DEPTH_TEST);

        this.stats.draws++;
    };

    /* ---------------- 编辑选区预览（半透明高亮待拆分部分） ---------------- */
    Renderer.prototype.setPreview = function (geo)
    {
        var gl = this.gl;
        var self = this;

        this.previewGeo = geo || null;
        this.previewCount = 0;
        this.previewRemCount = 0;
        this.previewOverlayId = (geo && geo.layerId) || null;
        this.previewColor = (geo && geo.color) || [0.44, 0.67, 0.93];
        this.previewBackColor = (geo && geo.backColor) || [0.69, 0.23, 0.19];
        this.previewShade = (geo && geo.shade) || 0;

        var olds = [this.previewVao, this.previewRemVao];
        var oldb = [this.previewBuffer, this.previewRemBuffer];
        for (var i = 0; i < olds.length; i++)
        {
            if (olds[i]) { gl.deleteVertexArray(olds[i]); }
            if (oldb[i]) { gl.deleteBuffer(oldb[i]); }
        }
        this.previewVao = null;
        this.previewRemVao = null;
        this.previewBuffer = null;
        this.previewRemBuffer = null;

        if (!geo)
        {
            return;
        }

        var isPoints = geo.kind === 'points';
        var loc = isPoints ? this.pointA.pos : this.meshA.pos;

        function makeVao(positions)
        {
            var vao = gl.createVertexArray();
            var buf = gl.createBuffer();
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
            gl.bindVertexArray(null);
            return { vao: vao, buf: buf, n: positions.length / 3 };
        }

        // 选中部分（高亮）
        var segPos = (geo.seg && geo.seg.positions) || (isPoints ? geo.positions : null);
        if (segPos && segPos.length)
        {
            var a = makeVao(segPos);
            this.previewVao = a.vao;
            this.previewBuffer = a.buf;
            this.previewCount = a.n;
        }

        // 剩余部分（原色）—— 只有网格才有
        if (!isPoints && geo.rem && geo.rem.positions && geo.rem.positions.length)
        {
            var b = makeVao(geo.rem.positions);
            this.previewRemVao = b.vao;
            this.previewRemBuffer = b.buf;
            this.previewRemCount = b.n;
        }

        self.previewCalls = 0;
    };

    Renderer.prototype.drawPreviewSeg = function (mvp, viewM, ctx)
    {
        this.previewCalls = (this.previewCalls || 0) + 1;
        var geo = this.previewGeo;
        if (!geo || !this.previewCount || !this.previewVao)
        {
            return;
        }

        var gl = this.gl;
        // 高亮纯色覆盖，但保留正确遮挡：
        //   不透明            → 与原始三角形不会混色
        //   LEQUAL + 偏移     → 与原始三角形共面时能覆盖（切片后顶点不同，深度有微小差异）
        //   不关深度测试      → 真正挡在前面的几何会正确遮住高亮
        gl.disable(gl.BLEND);
        gl.depthMask(false);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1.0, -2.0);
        gl.disable(gl.CULL_FACE);

        if (!this.previewVao || !this.previewCount)
        {
            gl.disable(gl.POLYGON_OFFSET_FILL);
            gl.depthFunc(gl.LESS);
            gl.depthMask(true);
            return;
        }
        gl.bindVertexArray(this.previewVao);

        if (geo.kind === 'points')
        {
            gl.useProgram(this.pointP);
            gl.uniformMatrix4fv(this.pointU.uMVP, false, mvp);
            gl.uniformMatrix4fv(this.pointU.uView, false, viewM);
            gl.uniform1f(this.pointU.uPointSize, 4 * ((ctx && ctx.dpr) || 1));
            gl.uniform1f(this.pointU.uDepthBias, -0.00002);
            gl.uniform1i(this.pointU.uColorMode, 0);
            gl.uniform4f(this.pointU.uColor, 0.10, 0.95, 0.85, 1.0);
            gl.uniform1f(this.pointU.uZMin, 0);
            gl.uniform1f(this.pointU.uZMax, 1);
            gl.uniform1f(this.pointU.uSFMin, 0);
            gl.uniform1f(this.pointU.uSFMax, 1);
            gl.uniform1i(this.pointU.uRamp, 0);
            gl.uniform1f(this.pointU.uAlpha, 0.95);
            gl.uniform1i(this.pointU.uRound, 0);
            if (this.pointA.sf !== undefined)
            {
                gl.disableVertexAttribArray(this.pointA.sf);
                gl.vertexAttrib1f(this.pointA.sf, 0);
            }
            gl.drawArrays(gl.POINTS, 0, this.previewCount);
        }
        else
        {
            gl.useProgram(this.meshP);
            gl.uniformMatrix4fv(this.meshU.uMVP, false, mvp);
            gl.uniformMatrix4fv(this.meshU.uView, false, viewM);
            if (this.meshU.uTwoSided) { gl.uniform1i(this.meshU.uTwoSided, 0); }
            gl.uniform4f(this.meshU.uColor, 0.10, 0.95, 0.85, 1.0);
            gl.uniform3fv(this.meshU.uLightView, this.lightView || [0, 0, 1]);
            gl.uniform1i(this.meshU.uShade, 0);
            gl.drawArrays(gl.TRIANGLES, 0, this.previewCount);
        }

        gl.bindVertexArray(null);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        this.stats.draws++;
    };

    /* 拾取点标记：3D 十字，关闭深度测试，任何视角可见 */
    Renderer.prototype.drawPickMarks = function (mvp, marks, len)
    {
        if (!marks || !marks.length)
        {
            return;
        }
        var gl = this.gl;
        var n = marks.length;
        var data = new Float32Array(n * 18);

        for (var i = 0; i < n; i++)
        {
            var p = marks[i].pos;
            var o = i * 18;
            data[o] = p[0] - len; data[o + 1] = p[1]; data[o + 2] = p[2];
            data[o + 3] = p[0] + len; data[o + 4] = p[1]; data[o + 5] = p[2];
            data[o + 6] = p[0]; data[o + 7] = p[1] - len; data[o + 8] = p[2];
            data[o + 9] = p[0]; data[o + 10] = p[1] + len; data[o + 11] = p[2];
            data[o + 12] = p[0]; data[o + 13] = p[1]; data[o + 14] = p[2] - len;
            data[o + 15] = p[0]; data[o + 16] = p[1]; data[o + 17] = p[2] + len;
        }

        if (!this.markVao)
        {
            this.markVao = gl.createVertexArray();
            this.markBuffer = gl.createBuffer();
        }

        gl.bindVertexArray(this.markVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.markBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.lineA.pos);
        gl.vertexAttribPointer(this.lineA.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        var COLORS = [[1.0, 0.85, 0.2], [0.35, 1.0, 0.55], [0.45, 0.75, 1.0]];

        gl.useProgram(this.lineP);
        gl.uniformMatrix4fv(this.lineU.uMVP, false, mvp);
        gl.uniform1f(this.lineU.uDepthBias, 0.0);
        gl.disable(gl.DEPTH_TEST);
        gl.bindVertexArray(this.markVao);
        for (var k = 0; k < n; k++)
        {
            var c = COLORS[k % COLORS.length];
            gl.uniform4f(this.lineU.uColor, c[0], c[1], c[2], 1.0);
            gl.drawArrays(gl.LINES, k * 6, 6);
        }
        gl.bindVertexArray(null);
        gl.enable(gl.DEPTH_TEST);

        this.stats.draws++;
    };

    /* 顶点：把网格的三角形顶点作为点绘制（超过上限时按步长抽稀） */
    Renderer.prototype.ensureVerts = function (layer)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!g || g.vertVao || !g.triCount)
        {
            return;
        }

        // 索引化后 posBuffer 里已是去重顶点，直接 0..vertCount-1
        var total = g.vertCount || (g.triCount * 3);
        var n = total;
        var idx = new Uint32Array(n);
        for (var i = 0; i < n; i++)
        {
            idx[i] = i;
        }

        var vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuffer);
        gl.enableVertexAttribArray(this.pointA.pos);
        gl.vertexAttribPointer(this.pointA.pos, 3, gl.FLOAT, false, 0, 0);
        var ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);

        g.vertVao = vao;
        g.vertBuffer = ibo;
        g.vertCount = n;
    };

    Renderer.prototype.drawVerts = function (layer, mvp, ctx, alpha)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!g)
        {
            return;
        }
        this.ensureVerts(layer);
        if (!g.vertVao)
        {
            return;
        }

        gl.useProgram(this.pointP);
        gl.uniformMatrix4fv(this.pointU.uMVP, false, mvp);
        var vc = layer.vertColorRgb || [0.95, 0.95, 0.98];
        gl.uniform1f(this.pointU.uPointSize, (layer.pointSize || 3) * (ctx.dpr || 1) * ctx.settings.pointScale);
        gl.uniform1f(this.pointU.uDepthBias, 0.0);
        gl.uniform1i(this.pointU.uColorMode, 0);
        gl.uniform3f(this.pointU.uColor, vc[0], vc[1], vc[2]);
        gl.uniform1f(this.pointU.uZMin, layer.data.bbox.min[2]);
        gl.uniform1f(this.pointU.uZMax, layer.data.bbox.max[2]);
        gl.uniform1f(this.pointU.uAlpha, alpha);
        gl.uniform1i(this.pointU.uRound, 1);
        gl.bindVertexArray(g.vertVao);
        gl.drawElements(gl.POINTS, g.vertCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);

        this.stats.draws++;
        this.stats.vertCalls++;
    };

    Renderer.prototype.drawPoints = function (layer, mvp, viewM, pointSize, alpha, round)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!g || !g.count)
        {
            return;
        }

        var mode = layer.pointColorMode || 0;
        if (mode === 2 && !layer.data.normals) { mode = 0; }
        if (mode === 3 && !layer.data.tags) { mode = 0; }
        if (mode === 4 && !layer.data.colors) { mode = 0; }
        if (mode === 5 && !(layer.data.scalars && layer.data.scalars.length && g.sfVao)) { mode = 0; }

        var vao = g.vao;
        var sfMin = 0;
        var sfMax = 1;
        if (mode === 5)
        {
            var si = layer.sfIndex || 0;
            if (si >= g.sfVao.length) { si = 0; }
            vao = g.sfVao[si];

            var sf = layer.data.scalars[si];
            sfMin = (typeof layer.sfMin === 'number' && isFinite(layer.sfMin)) ? layer.sfMin : sf.min;
            sfMax = (typeof layer.sfMax === 'number' && isFinite(layer.sfMax)) ? layer.sfMax : sf.max;
            if (!(sfMax > sfMin))
            {
                sfMax = sfMin + 1;
            }
        }

        gl.useProgram(this.pointP);
        gl.uniformMatrix4fv(this.pointU.uMVP, false, mvp);
        gl.uniformMatrix4fv(this.pointU.uView, false, viewM);
        gl.uniform1f(this.pointU.uPointSize, pointSize);
        gl.uniform1f(this.pointU.uDepthBias, 0.0);
        gl.uniform1i(this.pointU.uColorMode, mode);
        gl.uniform3fv(this.pointU.uColor, layer.colorRgb);
        gl.uniform1f(this.pointU.uZMin, layer.data.bbox.min[2]);
        gl.uniform1f(this.pointU.uZMax, layer.data.bbox.max[2]);
        gl.uniform1f(this.pointU.uSFMin, sfMin);
        gl.uniform1f(this.pointU.uSFMax, sfMax);
        gl.uniform1i(this.pointU.uRamp, layer.sfRamp | 0);
        gl.uniform1f(this.pointU.uAlpha, alpha);
        gl.uniform1i(this.pointU.uRound, round);

        gl.bindVertexArray(vao);

        if (!layer.data.normals)
        {
            gl.disableVertexAttribArray(this.pointA.aux);
            gl.vertexAttrib3f(this.pointA.aux, 0, 0, 1);
        }
        if (!layer.data.tags)
        {
            gl.disableVertexAttribArray(this.pointA.tag);
            gl.vertexAttrib1f(this.pointA.tag, 0);
        }
        if (!layer.data.colors)
        {
            gl.disableVertexAttribArray(this.pointA.col);
            gl.vertexAttrib3f(this.pointA.col, 1, 1, 1);
        }
        if (mode !== 5)
        {
            gl.disableVertexAttribArray(this.pointA.sf);
            gl.vertexAttrib1f(this.pointA.sf, 0);
        }

        gl.drawArrays(gl.POINTS, 0, g.count);
        gl.bindVertexArray(null);

        this.stats.points += g.count;
        this.stats.draws++;
    };

    Renderer.prototype.drawNormals = function (layer, mvp, alpha)
    {
        var gl = this.gl;
        var g = layer.gpu;
        if (!g || !g.normalCount)
        {
            return;
        }
        gl.useProgram(this.lineP);
        gl.uniformMatrix4fv(this.lineU.uMVP, false, mvp);
        gl.uniform1f(this.lineU.uDepthBias, 0.00001);
        // 法向固定用青色，与任意图层颜色区分
        gl.uniform4fv(this.lineU.uColor, [0.55, 0.93, 1.0, alpha]);
        gl.bindVertexArray(g.normalVao);
        gl.drawArrays(gl.LINES, 0, g.normalCount * 2);
        gl.bindVertexArray(null);
        this.stats.draws++;
        this.stats.normalCalls++;
    };

    Renderer.prototype.render = function (ctx)
    {
        if (!this.ready)
        {
            return;
        }
        var gl = this.gl;
        var W = this.canvas.width;
        var H = this.canvas.height;

        this.stats.triangles = 0;
        this.stats.points = 0;
        this.stats.draws = 0;
        this.stats.meshCalls = 0;
        this.stats.wireCalls = 0;
        this.stats.vertCalls = 0;
        this.stats.normalCalls = 0;
        this.stats.boundaryCalls = 0;
        this.stats.chunksDrawn = 0;
        this.stats.chunksTotal = 0;

        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, W, H);
        gl.depthMask(true);
        var bg = ctx.settings.bg;
        gl.clearColor(bg[0], bg[1], bg[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        var mvp = new Float32Array(16);
        var proj = new Float32Array(16);
        var viewM = new Float32Array(16);

        for (var vi = 0; vi < ctx.views.length; vi++)
        {
            var v = ctx.views[vi];
            if (v.w < 2 || v.h < 2)
            {
                continue;
            }

            var gy = H - (v.y + v.h);
            gl.viewport(v.x, gy, v.w, v.h);
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(v.x, gy, v.w, v.h);
            gl.clear(gl.DEPTH_BUFFER_BIT);

            var cam = v.camera;
            cam.viewMatrix(viewM);
            cam.projMatrix(proj, v.w / Math.max(v.h, 1));
            global.MV.math.Mat4.multiply(mvp, proj, viewM);

            // 光照方向：世界空间 → 视图空间（跟随相机 / 用户指定方位角+俯仰角）
            var lw;
            if (ctx.settings.lightFollow)
            {
                var ep = cam.getPosition();
                lw = [ep[0] - cam.target[0], ep[1] - cam.target[1], ep[2] - cam.target[2]];
            }
            else
            {
                var laz = ctx.settings.lightAz || 0;
                var lel = ctx.settings.lightEl || 0;
                lw = [Math.cos(lel) * Math.cos(laz), Math.cos(lel) * Math.sin(laz), Math.sin(lel)];
            }
            var llen = Math.sqrt(lw[0] * lw[0] + lw[1] * lw[1] + lw[2] * lw[2]) || 1;
            lw[0] /= llen;
            lw[1] /= llen;
            lw[2] /= llen;

            var lv = [
                viewM[0] * lw[0] + viewM[4] * lw[1] + viewM[8] * lw[2],
                viewM[1] * lw[0] + viewM[5] * lw[1] + viewM[9] * lw[2],
                viewM[2] * lw[0] + viewM[6] * lw[1] + viewM[10] * lw[2]
            ];
            var lvlen = Math.sqrt(lv[0] * lv[0] + lv[1] * lv[1] + lv[2] * lv[2]) || 1;
            this.lightView = [lv[0] / lvlen, lv[1] / lvlen, lv[2] / lvlen];

            // 全场景包围盒：网格与坐标轴统一尺寸，左右视图一致
            var GB = global.MV.math.BBox;
            var gb = (ctx.sceneBBox && GB.valid(ctx.sceneBBox)) ? ctx.sceneBBox : v.bbox;

            // 地面网格
            if (ctx.settings.grid && gb && GB.valid(gb))
            {
                this.ensureGrid(gb);
                if (this.gridCache.vao)
                {
                    gl.useProgram(this.lineP);
                    gl.uniformMatrix4fv(this.lineU.uMVP, false, mvp);
                    gl.uniform1f(this.lineU.uDepthBias, 0.0);
                    var gc = this.gridColor || [0.22, 0.26, 0.32];
            gl.uniform4f(this.lineU.uColor, gc[0], gc[1], gc[2], 1.0);
                    gl.bindVertexArray(this.gridCache.vao);
                    gl.drawArrays(gl.LINES, 0, this.gridCache.count);
                    gl.bindVertexArray(null);
                }
            }

            // 坐标轴
            if (ctx.settings.axes && gb && GB.valid(gb))
            {
                var r = GB.radius(gb);
                var alen = Math.max(r * 0.18, 1e-3);
                this.ensureAxis(alen);
                gl.useProgram(this.lineP);
                gl.uniformMatrix4fv(this.lineU.uMVP, false, mvp);
                gl.uniform1f(this.lineU.uDepthBias, 0.0);
                gl.bindVertexArray(this.axisBuffer);
                gl.uniform4f(this.lineU.uColor, 0.92, 0.28, 0.28, 1.0);
                gl.lineWidth(1);
                // 轴线按比例缩放：直接用 uniform 不好缩放，改为顶点缓冲预乘
                gl.drawArrays(gl.LINES, 0, 2);
                gl.uniform4f(this.lineU.uColor, 0.28, 0.85, 0.35, 1.0);
                gl.drawArrays(gl.LINES, 2, 2);
                gl.uniform4f(this.lineU.uColor, 0.32, 0.55, 1.0, 1.0);
                gl.drawArrays(gl.LINES, 4, 2);
                gl.bindVertexArray(null);
            }

            // 图层：不透明在前
            var opaque = [];
            var trans = [];
            for (var li = 0; li < v.layers.length; li++)
            {
                var item = v.layers[li];
                var lay = item.layer;
                if (!lay.visible || !lay.gpu)
                {
                    continue;
                }
                var ghostSolid = item.ghost && (ctx.settings.ghostMode === 1);
                if ((item.ghost && !ghostSolid) || lay.opacity < 0.995)
                {
                    trans.push(item);
                }
                else
                {
                    opaque.push(item);
                }
            }

            gl.depthMask(true);
            gl.disable(gl.BLEND);
            // 记录当前视图相机位置：边界线据此前移（世界单位）
            this.curCamPos = cam.getPosition();
            this.drawList(opaque, v, mvp, viewM, ctx, false);
            gl.depthMask(false);
            gl.enable(gl.BLEND);
            this.drawList(trans, v, mvp, viewM, ctx, true);

            // 边界线：本视图所有图层画完后单独一遍，避免受面片绘制状态影响
            for (var bi = 0; bi < v.layers.length; bi++)
            {
                var bl = v.layers[bi].layer;
                if (bl && bl.kind === 'mesh' && bl.visible && bl.showBoundary && bl.gpu)
                {
                    this.drawBoundary(bl, mvp);
                }
            }

            // 拾取点标记
            if (this.pickMarks && this.pickMarks.length)
            {
                // 恒定世界尺寸（默认单臂 1 mm）；远距离时不足 1 px 会画不出来，
                // 因此加“最少 6 px”保护：放大到足够近时才真正按 1 mm 显示
                var baseLen = this.pickMarkLen || 1;
                var eyeP = cam.getPosition();
                var ddx = eyeP[0] - cam.target[0];
                var ddy = eyeP[1] - cam.target[1];
                var ddz = eyeP[2] - cam.target[2];
                var dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1;
                var perPx = 2 * dist * Math.tan(cam.fov * 0.5) / Math.max(v.h, 1);
                this.drawPickMarks(mvp, this.pickMarks, Math.max(baseLen, perPx * 6));
            }

            // 编辑选区预览
            this.drawPreviewSeg(mvp, viewM, ctx);
            gl.depthMask(true);
        }

        gl.disable(gl.SCISSOR_TEST);

        var err = gl.getError();
        if (err !== gl.NO_ERROR)
        {
            this.glError = err;
        }
    };

    Renderer.prototype.drawList = function (list, view, mvp, viewM, ctx, isTransparent)
    {
        var gl = this.gl;

        for (var i = 0; i < list.length; i++)
        {
            var item = list[i];
            var lay = item.layer;

            if (lay.data.kind === 'mesh')
            {
                if (item.ghost)
                {
                    if (ctx.settings.ghostMode === 1)
                    {
                        // 实体叠加：完全按对面图层当前显示状态绘制（颜色、线框、顶点、法向、着色、透明度）
                        this.drawMeshLayer(lay, mvp, viewM, ctx, lay.opacity);
                    }
                    else
                    {
                        // 半透明灰色轮廓，正反面同色，不显示线框与法向
                        this.drawMesh(lay, mvp, viewM, [0.62, 0.68, 0.78, 0.16], 0, false);
                    }
                }
                else
                {
                    this.drawMeshLayer(lay, mvp, viewM, ctx, lay.opacity);
                }
            }
            else
            {
                var ps = lay.pointSize * ctx.settings.pointScale * (ctx.dpr || 1);
                if (item.ghost && ctx.settings.ghostMode !== 1)
                {
                    // 透明叠加：固定浅灰
                    this.drawPoints({
                        gpu: lay.gpu,
                        data: lay.data,
                        colorRgb: [0.62, 0.68, 0.78],
                        pointColorMode: 0,
                        pointSize: lay.pointSize,
                        opacity: 0.22
                    }, mvp, viewM, ps, 0.22, 1);
                }
                else
                {
                    this.drawPoints(lay, mvp, viewM, ps, lay.opacity, 1);
                }
            }
        }
    };

    /* ==================== 视角器（削角六面体 26 面 + X/Y/Z 箭头） ==================== */
/* App 方法，由 app.js 在启动时调用 MV.render.installAppMethods() 安装 */
function installGizmoMethods()
    {
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
                renderHooks.notify('视角：' + dirName(h.n));
                return true;
            }
        }
        return false;
    };

    global.MV.gizmoGeo = HEX_GEO;   // 供 app.js 读取面数等元信息

    }

global.MV.Renderer = Renderer;


    global.MV.render = global.MV.render || {};
    global.MV.render.bindHooks = bindRenderHooks;
    global.MV.render.installAppMethods = installGizmoMethods;

})(window);