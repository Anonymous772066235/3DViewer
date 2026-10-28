/* L1 基础层 | core：数学与相机
 * 允许依赖：无
 * 禁止依赖：DOM / GL / MV.ui / MV.app
 * 导出：MV.math（Vec3 / Mat4 / Quat / BBox / OrbitCamera）
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    /* ==================== 数学与相机（原 math3d.js） ==================== */

    var Vec3 = {
        create: function (x, y, z) { return [x || 0, y || 0, z || 0]; },
        sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
        add: function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
        scale: function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
        dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
        cross: function (a, b)
        {
            return [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0]
            ];
        },
        length: function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
        normalize: function (a)
        {
            var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
            if (l < 1e-12)
            {
                return [0, 0, 0];
            }
            return [a[0] / l, a[1] / l, a[2] / l];
        }
    };

    var Mat4 = {
        create: function ()
        {
            var m = new Float32Array(16);
            m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
            return m;
        },

        identity: function (out)
        {
            out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
            out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
            out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
            out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
            return out;
        },

        // out = a * b
        multiply: function (out, a, b)
        {
            var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
            var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
            var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
            var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

            for (var i = 0; i < 4; i++)
            {
                var b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
                out[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
                out[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
                out[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
                out[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
            }
            return out;
        },

        perspective: function (out, fovy, aspect, near, far)
        {
            var f = 1.0 / Math.tan(fovy * 0.5);
            var nf = 1.0 / (near - far);

            out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
            out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
            out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
            out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
            return out;
        },

        lookAt: function (out, eye, center, up)
        {
            var z = Vec3.normalize(Vec3.sub(eye, center));
            var x = Vec3.normalize(Vec3.cross(up, z));
            var y = Vec3.cross(z, x);

            out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
            out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
            out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
            out[12] = -Vec3.dot(x, eye);
            out[13] = -Vec3.dot(y, eye);
            out[14] = -Vec3.dot(z, eye);
            out[15] = 1;
            return out;
        }
    };

    /* ---------------- 包围盒 ---------------- */
    var BBox = {
        empty: function ()
        {
            return {
                min: [Infinity, Infinity, Infinity],
                max: [-Infinity, -Infinity, -Infinity]
            };
        },

        valid: function (b)
        {
            return isFinite(b.min[0]) && isFinite(b.max[0]);
        },

        expandArray: function (b, arr, stride)
        {
            var s = stride || 3;
            for (var i = 0; i + 2 < arr.length; i += s)
            {
                var x = arr[i], y = arr[i + 1], z = arr[i + 2];
                if (x < b.min[0]) { b.min[0] = x; }
                if (y < b.min[1]) { b.min[1] = y; }
                if (z < b.min[2]) { b.min[2] = z; }
                if (x > b.max[0]) { b.max[0] = x; }
                if (y > b.max[1]) { b.max[1] = y; }
                if (z > b.max[2]) { b.max[2] = z; }
            }
            return b;
        },

        merge: function (a, b)
        {
            if (!BBox.valid(b))
            {
                return a;
            }
            for (var i = 0; i < 3; i++)
            {
                if (b.min[i] < a.min[i]) { a.min[i] = b.min[i]; }
                if (b.max[i] > a.max[i]) { a.max[i] = b.max[i]; }
            }
            return a;
        },

        center: function (b)
        {
            return [(b.min[0] + b.max[0]) * 0.5, (b.min[1] + b.max[1]) * 0.5, (b.min[2] + b.max[2]) * 0.5];
        },

        size: function (b)
        {
            return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
        },

        radius: function (b)
        {
            var s = BBox.size(b);
            return 0.5 * Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
        }
    };

    /* ---------------- 四元数（轨迹球旋转用） ---------------- */
    var Quat = {
        identity: function () { return [0, 0, 0, 1]; },

        fromAxisAngle: function (axis, ang)
        {
            var h = ang * 0.5;
            var s = Math.sin(h);
            var l = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
            if (!(l > 1e-12))
            {
                return [0, 0, 0, 1];
            }
            return [axis[0] / l * s, axis[1] / l * s, axis[2] / l * s, Math.cos(h)];
        },

        mul: function (a, b)
        {
            return [
                a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
                a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
                a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
            ];
        },

        normalize: function (q)
        {
            var l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
            if (!(l > 1e-12))
            {
                return [0, 0, 0, 1];
            }
            return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
        },

        rotate: function (q, v)
        {
            var x = q[0], y = q[1], z = q[2], w = q[3];
            var tx = 2 * (y * v[2] - z * v[1]);
            var ty = 2 * (z * v[0] - x * v[2]);
            var tz = 2 * (x * v[1] - y * v[0]);
            return [
                v[0] + w * tx + (y * tz - z * ty),
                v[1] + w * ty + (z * tx - x * tz),
                v[2] + w * tz + (x * ty - y * tx)
            ];
        },

        /* 由正交基（右 / 上 / 后）构造四元数：相机本地轴 → 世界 */
        fromBasis: function (r, u, b)
        {
            var m00 = r[0], m01 = u[0], m02 = b[0];
            var m10 = r[1], m11 = u[1], m12 = b[1];
            var m20 = r[2], m21 = u[2], m22 = b[2];
            var tr = m00 + m11 + m22;
            var q;

            if (tr > 0)
            {
                var s0 = Math.sqrt(tr + 1) * 2;
                q = [(m21 - m12) / s0, (m02 - m20) / s0, (m10 - m01) / s0, 0.25 * s0];
            }
            else if (m00 > m11 && m00 > m22)
            {
                var s1 = Math.sqrt(1 + m00 - m11 - m22) * 2;
                q = [0.25 * s1, (m01 + m10) / s1, (m02 + m20) / s1, (m21 - m12) / s1];
            }
            else if (m11 > m22)
            {
                var s2 = Math.sqrt(1 + m11 - m00 - m22) * 2;
                q = [(m01 + m10) / s2, 0.25 * s2, (m12 + m21) / s2, (m02 - m20) / s2];
            }
            else
            {
                var s3 = Math.sqrt(1 + m22 - m00 - m11) * 2;
                q = [(m02 + m20) / s3, (m12 + m21) / s3, 0.25 * s3, (m10 - m01) / s3];
            }
            return Quat.normalize(q);
        }
    };

    /* ---------------- 轨道相机（轨迹球：无极旋转，无俯仰限制） ---------------- */
    function OrbitCamera()
    {
        this.target = [0, 0, 0];
        this.distance = 500;
        this.fov = 45 * Math.PI / 180;
        this.minDistance = 1e-3;
        this.maxDistance = 1e9;
        this.q = Quat.identity();               // 相机本地 → 世界
        this.setOrientation(-Math.PI * 0.25, 0.55);
    }

    /* 用 yaw/pitch（Z 向上）重建朝向，滚转归零 */
    OrbitCamera.prototype.setOrientation = function (yaw, pitch)
    {
        var lim = Math.PI * 0.5 - 0.002;
        if (pitch > lim) { pitch = lim; }
        if (pitch < -lim) { pitch = -lim; }

        var cp = Math.cos(pitch);
        var sp = Math.sin(pitch);
        var back = [cp * Math.cos(yaw), cp * Math.sin(yaw), sp];   // target → eye
        var fwd = [-back[0], -back[1], -back[2]];

        var right = Vec3.cross(fwd, [0, 0, 1]);
        if (Math.sqrt(right[0] * right[0] + right[1] * right[1] + right[2] * right[2]) < 1e-6)
        {
            right = [1, 0, 0];
        }
        right = Vec3.normalize(right);
        var up = Vec3.cross(right, fwd);

        this.q = Quat.fromBasis(right, up, back);
    };

    /* yaw / pitch 作为派生属性保留（URL 参数、视角立方体、状态栏仍可用） */
    Object.defineProperty(OrbitCamera.prototype, 'yaw', {
        get: function ()
        {
            var b = Quat.rotate(this.q, [0, 0, 1]);
            return Math.atan2(b[1], b[0]);
        },
        set: function (v) { this.setOrientation(v, this.pitch); }
    });

    Object.defineProperty(OrbitCamera.prototype, 'pitch', {
        get: function ()
        {
            var b = Quat.rotate(this.q, [0, 0, 1]);
            return Math.asin(Math.max(-1, Math.min(1, b[2])));
        },
        set: function (v) { this.setOrientation(this.yaw, v); }
    });

    /* 清除滚转：保持当前朝向的水平角/俯仰角，把滚转归零 */
    OrbitCamera.prototype.level = function ()
    {
        this.setOrientation(this.yaw, this.pitch);
    };

    OrbitCamera.prototype.getPosition = function ()
    {
        var b = Quat.rotate(this.q, [0, 0, 1]);
        return [
            this.target[0] + this.distance * b[0],
            this.target[1] + this.distance * b[1],
            this.target[2] + this.distance * b[2]
        ];
    };

    OrbitCamera.prototype.basis = function ()
    {
        var back = Quat.rotate(this.q, [0, 0, 1]);
        return {
            forward: [-back[0], -back[1], -back[2]],
            right: Quat.rotate(this.q, [1, 0, 0]),
            up: Quat.rotate(this.q, [0, 1, 0]),
            eye: this.getPosition()
        };
    };

    OrbitCamera.prototype.viewMatrix = function (out)
    {
        var b = this.basis();
        return Mat4.lookAt(out, b.eye, this.target, b.up);
    };

    OrbitCamera.prototype.projMatrix = function (out, aspect)
    {
        var near = Math.max(this.distance * 0.002, 1e-4);
        var far = this.distance * 60 + 1e6 * 0.0 + 1e5;
        far = Math.max(far, near * 1000);
        return Mat4.perspective(out, this.fov, aspect, near, far);
    };

    /* 无极旋转：绕“相机本地轴”累积四元数 —— 没有俯仰限制，也没有极点/翻转 */
    OrbitCamera.prototype.orbit = function (dxPix, dyPix)
    {
        var sens = 0.0075;
        if (dxPix)
        {
            this.q = Quat.normalize(Quat.mul(this.q,
                Quat.fromAxisAngle([0, 1, 0], -dxPix * sens)));
        }
        if (dyPix)
        {
            this.q = Quat.normalize(Quat.mul(this.q,
                Quat.fromAxisAngle([1, 0, 0], -dyPix * sens)));
        }
    };

    OrbitCamera.prototype.pan = function (dxPix, dyPix, viewportH)
    {
        var b = this.basis();
        var wpp = 2 * this.distance * Math.tan(this.fov * 0.5) / Math.max(viewportH, 1);
        this.target[0] += (-b.right[0] * dxPix + b.up[0] * dyPix) * wpp;
        this.target[1] += (-b.right[1] * dxPix + b.up[1] * dyPix) * wpp;
        this.target[2] += (-b.right[2] * dxPix + b.up[2] * dyPix) * wpp;
    };

    OrbitCamera.prototype.zoom = function (deltaPix)
    {
        this.distance *= Math.exp(deltaPix * 0.0015);
        if (this.distance < this.minDistance) { this.distance = this.minDistance; }
        if (this.distance > this.maxDistance) { this.distance = this.maxDistance; }
    };

    OrbitCamera.prototype.fit = function (bbox)
    {
        if (!BBox.valid(bbox))
        {
            return;
        }
        this.target = BBox.center(bbox);
        var r = BBox.radius(bbox);
        if (!(r > 1e-6)) { r = 1; }
        this.distance = r / Math.sin(this.fov * 0.5) * 1.25;
        this.minDistance = r * 1e-4;
        this.maxDistance = r * 1e4;
    };

    OrbitCamera.prototype.copyFrom = function (other)
    {
        this.target = [other.target[0], other.target[1], other.target[2]];
        this.distance = other.distance;
        this.q = [other.q[0], other.q[1], other.q[2], other.q[3]];
        this.fov = other.fov;
        this.minDistance = other.minDistance;
        this.maxDistance = other.maxDistance;
    };

    global.MV.math = {
        Vec3: Vec3,
        Quat: Quat,
        Mat4: Mat4,
        BBox: BBox,
        OrbitCamera: OrbitCamera
    };



})(window);