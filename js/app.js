/* L6 编排层 | app：状态、图层、输入分派、渲染循环
 * 允许依赖：全部下层（core / io / algo / render / ui）
 * 启动时依次安装下层提供的 App 方法
 */
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

    var PALETTE = {
        A: ['#4da3ff', '#6fc3ff', '#3f8fd8', '#8fb9ff'],
        B: ['#ffb347', '#ff8f6b', '#f0c05a', '#ff9f43'],
        S: ['#8fd694', '#a9d46e', '#5fd0a8', '#c2d97a']
    };

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
            bg: [0.078, 0.094, 0.129],
            grid: true,
            axes: true,
            ghost: true,
            ghostMode: 0,
            singleView: false,
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
        if (this.urlMark > 0)
        {
            this.renderer.pickMarkLen = this.urlMark;   // ?mark= 覆盖拾取十字的单臂长度
        }

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
            colors: params.get('colors') === '1',
            noconfirm: params.get('noconfirm') === '1',
            debug: params.get('debug') === '1',
            cull: params.get('cull') !== '0'
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
        // ?zoom= 在载入完成后生效（fitAll 会重置距离，这里统一乘一次）
        if (this.urlZoom && this.urlZoom !== 1)
        {
            global.addEventListener('mv:loaded', function ()
            {
                var cams = self.settings.syncCam
                    ? [self.views[0].camera]
                    : [self.views[0].camera, self.views[1].camera];
                for (var zi = 0; zi < cams.length; zi++)
                {
                    cams[zi].distance *= self.urlZoom;
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

        if (params.get('single') === '1')
        {
            this.setSingleView(true);
        }
        this.debug = params.get('debug') === '1';

        global.MV.ui.init(this);
        global.MV.ui.setInfo('就绪 — 支持 STL / OBJ / PLY / 点云文本');

        this.bindPointer();
        this.bindDrop();
        this.bindKeys();

        var self = this;
        window.addEventListener('resize', function () { self.dirty = true; });

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
        var autoUrl = params.get('url');
        if (autoUrl)
        {
            var slot = (params.get('slot') || 'B').toUpperCase();
            if (slot !== 'A' && slot !== 'B' && slot !== 'BOTH')
            {
                slot = 'B';
            }
            this.loadFromUrl(autoUrl, slot);
        }
    };

    App.prototype.loadFromUrl = async function (url, slot)
    {
        global.MV.ui.setProgress(true, '下载 ' + url, 0);
        try
        {
            var resp = await global.fetch(url, { cache: 'no-store' });
            if (!resp.ok)
            {
                throw new Error('HTTP ' + resp.status);
            }
            var buf = await resp.arrayBuffer();
            var name = decodeURIComponent((url.split('/').pop() || 'model').split('?')[0]);
            var file = new global.File([buf], name);

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
                '（file:// 下无法读取本地文件，请用 serve.bat 启动本地服务）');
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
            this.canvas.width = Math.max(1, Math.round(cw * dpr));
            this.canvas.height = Math.max(1, Math.round(ch * dpr));
            this.dirty = true;
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
        var half = Math.max(1, (this.cssW - gap) * 0.5);

        this.views[0].rect = { x: 0, y: 0, w: Math.round(half * dpr), h: fullH };
        this.views[1].rect = {
            x: Math.round((half + gap) * dpr),
            y: 0,
            w: Math.round(half * dpr),
            h: fullH
        };
    };

    /* ---------------- 图层管理 ---------------- */
    App.prototype.pickColor = function (slot)
    {
        var list = PALETTE[slot] || PALETTE.S;
        var c = list[this.paletteCursor[slot] % list.length];
        this.paletteCursor[slot] = (this.paletteCursor[slot] + 1) % list.length;
        return c;
    };

    // 同一文件的多个图层之间双向联动的显示属性
    var LINK_KEYS = [
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
        var hex = '#22d3ee';
        lay.color = hex;
        lay.colorRgb = global.MV.ui.hexToRgb(hex);
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

        var pos = src.data.positions;
        var nTri = Math.floor(pos.length / 9);
        var map = new Map();
        var out = new Float32Array(nTri * 3 * 3);
        var n = 0;
        var Q = 1e4;

        var minX = Infinity, minY = Infinity, minZ = Infinity;
        var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (var t = 0; t < nTri * 3; t++)
        {
            var o = t * 3;
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

    App.prototype.createLayer = function (name, slot, data, key)
    {
        // 树里要立即显示「点数量」：在导入时就统计一次唯一顶点数（焊接结果与它一致）
        // 网格只分析一次：顶点数 / 包围盒 / 去重顶点集，后续（树显示、顶点云拷贝）全部复用
        if (data.kind === 'mesh' && data.positions && data.uniqVerts === undefined)
        {
            if (global.MV.render && global.MV.render.analyzeMesh)
            {
                var an = global.MV.render.analyzeMesh(data.positions);
                data.vertCount = an.vertCount;
                data.bbox = an.bbox;
                data.uniqVerts = an.uniqVerts;
            }
            else
            {
                data.vertCount = Math.floor(data.positions.length / 9);
            }
        }

        var hex = this.pickColor(slot);
        var layer = {
            id: this.nextId++,
            name: name,
            slot: slot,
            kind: data.kind,
            data: data,
            visible: true,
            shownAt: Date.now(),      // 最近一次被启用/载入的时间，供“孔位优化”选择最新显示的网格
            gpu: null
        };

        // 同一模型（同名同大小）在 A / B 两侧共享一份显示属性：改任一侧，另一侧同步
        var k = key || ('data:' + (data.uid || ''));
        var props = this.propsByKey[k];
        if (!props)
        {
            props = {
                color: hex,
                colorRgb: global.MV.ui.hexToRgb(hex),
                backColor: '#b03a30',
                backColorRgb: global.MV.ui.hexToRgb('#6b7078'),   // 背面色：中性灰，避免与正面色抢眼
                wireColor: '#2f9df0',
                wireColorRgb: global.MV.ui.hexToRgb('#2f9df0'),
                vertColor: '#f2f3fa',
                vertColorRgb: global.MV.ui.hexToRgb('#f2f3fa'),
                boundaryColor: '#22d3ee',
                boundaryColorRgb: global.MV.ui.hexToRgb('#22d3ee'),
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
            ' 个图层？该操作不可撤销。', function ()
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
                continue;
            }
            B.merge(box, l.data.bbox);
        }
        return box;
    };

    App.prototype.fitView = function (vi, fitEmpty)
    {
        var v = this.views[vi];
        var box = this.computeBBox(v.slots);
        if (!B.valid(box))
        {
            box = this.computeBBox(v.slots, true);
        }
        if (!B.valid(box))
        {
            box = this.computeBBox(null);
        }
        if (B.valid(box))
        {
            v.camera.fit(box);
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

    App.prototype.fitAll = function ()
    {
        this.fitView(0, true);
        if (!this.settings.singleView)
        {
            this.fitView(1, true);
        }
    };

    /* 单窗口 / 双窗口切换：单窗口时 A/B/S 全部图层在同一个视口渲染 */
    App.prototype.setSingleView = function (on)
    {
        on = !!on;
        if (this.settings.singleView === on)
        {
            return;
        }
        this.settings.singleView = on;

        var Ctor = global.MV.math.OrbitCamera;
        if (on)
        {
            // 进入单窗口：右视图相机独立出来，主相机自适应全部图层
            this.syncBeforeSingle = this.settings.syncCam;
            this.settings.syncCam = false;
            this.views[1].camera = new Ctor();
            this.views[1].camera.copyFrom(this.views[0].camera);
            this.fitView(0, true);
        }
        else
        {
            // 回到双窗口：右视图继承当前视角，再各自自适应
            this.views[1].camera = new Ctor();
            this.views[1].camera.copyFrom(this.views[0].camera);
            this.fitView(0, false);
            this.fitView(1, true);

            // 进入单窗口前是同步状态的话，退出后恢复共享相机
            if (this.syncBeforeSingle)
            {
                this.views[1].camera = this.views[0].camera;
                this.settings.syncCam = true;
            }
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
        if (this.views[0].slots[layer.slot])
        {
            this.views[0].camera.fit(layer.data.bbox);
        }
        if (this.views[1].slots[layer.slot])
        {
            this.views[1].camera.fit(layer.data.bbox);
        }
        if (!this.views[0].slots[layer.slot] && !this.views[1].slots[layer.slot])
        {
            this.views[0].camera.fit(layer.data.bbox);
        }
        this.markDirty();
    };

    /* ---------------- 文件载入 ---------------- */
    App.prototype.pickFiles = function (slot)
    {
        this.pendingSlot = slot;
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
                    global.MV.ui.setInfo('已取消载入：' + file.name);
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
                    global.MV.ui.setInfo('已取消载入');
                    break;
                }
                global.MV.ui.setInfo('载入失败: ' + file.name + ' — ' + err.message);
                console.error(err);
            }
        }

        this.loading = false;
        global.MV.ui.setProgress(false, '');
        global.MV.ui.refreshUI();
        this.markDirty();

        // 通知扩展（如孔位优化的自动触发）加载已完成
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
       就按“文件名 + 大小”在 HoleOptimize/data 下反查（命中才填，静默失败） */
    App.prototype.locateSource = function (layer)
    {
        if (layer.sourceUrl || !layer.sourceFile || !global.fetch)
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
        var before = [B.valid(this.computeBBox(this.views[0].slots)), B.valid(this.computeBBox(this.views[1].slots))];

        global.MV.ui.setProgress(true, '读取 ' + file.name, 0);

        var data = await global.MV.loaders.loadFile(file,
            {
                maxTriangles: (limitOpts && limitOpts.maxTriangles) ||
                    this.urlMaxTri || global.MV.loaders.DEFAULT_MAX_TRIANGLES,
                maxPoints: (limitOpts && limitOpts.maxPoints) ||
                    this.urlMaxPts || global.MV.loaders.DEFAULT_MAX_POINTS
            },
            async function (frac, text)
            {
                if (self._abortLoad)
                {
                    throw new Error('__abort__');
                }
                global.MV.ui.setProgress(true, (text || '读取中') + ' · ' + file.name, frac);
                await new Promise(function (r) { setTimeout(r, 0); });
            },
            function (info)
            {
                // 列数 > 3 时弹窗确认每列含义（前三列固定 XYZ）
                if (self.noConfirmColumns)
                {
                    return global.MV.ui.autoColumnPlan(info);
                }
                return global.MV.ui.showColumnDialog(info);
            });

        if (!data)
        {
            global.MV.ui.setProgress(false, '');
            global.MV.ui.setInfo('已取消导入 ' + file.name);
            this.loading = false;
            return;
        }

        var baseName = file.name.replace(/\.[^.]+$/, '');
        var firstLayer = null;

        for (var i = 0; i < slots.length; i++)
        {
            var layer = self.createLayer(baseName, slots[i], data, file.name + '|' + file.size);
            // 记住原始文件：供“孔位优化”上传原始字节（bridge 服务使用）
            layer.sourceFile = file;
            layer.sourceUrl = file.sourceUrl || '';   // 来源地址（?url= 载入时有值）
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

        // 调试钩子：首个图层就绪时立刻执行（事件驱动，不依赖定时器）
        if (!self._dbgFired && global.MV.config)
        {
            if (global.MV.config.selone)
            {
                self._dbgFired = true;
                self.selectLayer(layer.id);
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

        if (this.selectedId === null && firstLayer)
        {
            // 导入后不自动选中：需要用户点一下网格，才显示它的 vertices 子树
        this.selectedId = null;
        }

        // 仅在视图此前为空时自动适配，避免打断已有视角
        if (!before[0])
        {
            this.fitView(0, false);
        }
        if (!before[1] && !this.settings.singleView)
        {
            this.fitView(1, false);
        }

        document.getElementById('drop-hint').classList.add('hidden');

        var info = data.format + ' · ' +
            (data.kind === 'mesh' ? (data.count + ' 三角形') : (data.count + ' 点'));
        if (data.note)
        {
            info += ' · ' + data.note;
        }
        global.MV.ui.setInfo(file.name + ' — ' + info);

        await new Promise(function (r) { setTimeout(r, 0); });
    };

    /* ---------------- 截图 ---------------- */
    App.prototype.screenshot = function ()
    {
        this.renderFrame();

        var stamp = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var name = 'view_' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
            '_' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + '.png';

        this.canvas.toBlob(function (blob)
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

            for (var li = 0; li < this.layers.length; li++)
            {
                var l = this.layers[li];
                if (!l.visible)
                {
                    continue;
                }
                if (v.slots[l.slot])
                {
                    list.push({ layer: l, ghost: false });
                }
                else if (this.settings.ghost && l.slot !== 'S')
                {
                    list.push({ layer: l, ghost: true });
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

    App.prototype.renderFrame = function ()
    {
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

        this.resize();
        this.updateRects();

        if (this.dirty)
        {
            this.renderer.pickMarks = this.pickPoints;
            this.renderFrame();
            this.dirty = false;
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
            global.MV.ui.setStats(this.fps, this.layers.length, this.lastStats.triangles, this.lastStats.points);
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

        if (global.MV.ui && global.MV.ui.applyTheme)
        {
            global.MV.ui.applyTheme(light);
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
        if (this.canvas)
        {
            this.canvas.style.cursor = on ? 'crosshair' : '';
        }
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

            // Ctrl + 单击，或点过「重设旋转中心」按钮后的单击：拾取表面点作为新的旋转中心
            var still = d.mode === 'orbit' && (d.moved || 0) < 5;
            var wantPick = (e.ctrlKey || self.pickMode) && still;
            if (wantPick)
            {
                self.pickMode = false;
                canvas.style.cursor = '';
                self.pickTarget(d.sx, d.sy);
            }
            else if (self.pickInfo && still)
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
            // 拾取模式下双击仍作“取点”，不重设旋转中心
            if (self.pickInfo)
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
            self.fitView(self.viewIndexAt(e.clientX), true);
        });
    };

    App.prototype.bindKeys = function ()
    {
        var self = this;
        window.addEventListener('keydown', function (e)
        {
            var tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')
            {
                return;
            }

            if (e.key === 'f' || e.key === 'F')
            {
                self.fitAll();
            }
            else if (e.key === 'w' || e.key === 'W')
            {
                var l = self.getSelected();
                if (l && l.data.kind === 'mesh')
                {
                    l.showWire = !l.showWire;
                    global.MV.ui.renderProps();
                    self.markDirty();
                }
            }
            else if (e.key === 'n' || e.key === 'N')
            {
                var l2 = self.getSelected();
                if (l2 && l2.data.kind === 'mesh')
                {
                    l2.showNormals = !l2.showNormals;
                    global.MV.ui.renderProps();
                    self.markDirty();
                }
            }
            else if (e.key === 'p' || e.key === 'P')
            {
                self.togglePickInfo();
            }
            else if (e.key === 'Delete')
            {
                // 移除当前选中图层
                if (self.selectedId !== null)
                {
                    self.removeLayer(self.selectedId);
                }
            }
            else if (e.key === 'Escape')
            {
                // 载入中按 Esc = 取消载入（优先于其它 Escape 语义）
                if (self.loading)
                {
                    self.cancelLoad();
                    return;
                }

                if (self.pickMode)
                {
                    self.cancelPickCenter();
                }
                if (self.pickInfo)
                {
                    self.setPickInfo(false);
                }

                // 裁剪进行中：Esc 只退出裁剪，不清图层选中（否则要重新点树才能再进）
                if (global.MV.algo && global.MV.algo.currentMode && global.MV.algo.currentMode())
                {
                    global.MV.algo.setMode(null);
                    return;
                }

                self.selectedId = null;
                global.MV.ui.refreshUI();
            }
        });
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
            refreshTree: global.MV.ui.renderTree, notify: global.MV.ui.setInfo, refreshProps: global.MV.ui.renderProps });
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
            on('seg-btn-rect', function () { A.toggleMode('rect'); });
            on('seg-btn-poly', function () { A.toggleMode('poly'); });
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
