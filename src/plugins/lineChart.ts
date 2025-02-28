import { DataPoint, RenderModel } from "../core/renderModel";
import { resolveColorRGBA, ResolvedCoreOptions, TimeChartSeriesOptions, LineType, ColormapFn } from '../options';
import { domainSearch } from '../utils';
import { vec2 } from 'gl-matrix';
import { TimeChartPlugin } from '.';
import { LinkedWebGLProgram, throwIfFalsy } from './webGLUtils';
import { DataPointsBuffer } from "../core/dataPointsBuffer";

// keep the width as a multiple of 6, to work with the LineType.Bar
const BUFFER_TEXTURE_WIDTH = 30;
const BUFFER_TEXTURE_HEIGHT = 600;

function calcBufferPointCapacity(lineType: LineType) {
    const capacity = BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT;
    if (lineType === LineType.Bar) {
        return capacity / 6
    }
    return capacity;
}

function calcBufferIntervalCapacity(lineType: LineType) {
    return calcBufferPointCapacity(lineType) - 2;
}

class ShaderUniformData {
    data;
    ubo;

    constructor(private gl: WebGL2RenderingContext, size: number) {
        this.data = new ArrayBuffer(size);
        this.ubo = throwIfFalsy(gl.createBuffer());
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
        gl.bufferData(gl.UNIFORM_BUFFER, this.data, gl.DYNAMIC_DRAW);
    }
    get modelScale() {
        return new Float32Array(this.data, 0, 2);
    }
    get modelTranslate() {
        return new Float32Array(this.data, 2 * 4, 2);
    }
    get projectionScale() {
        return new Float32Array(this.data, 4 * 4, 2);
    }

    upload(index = 0) {
        this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, index, this.ubo);
        this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, this.data);
    }
}

const VS_HEADER = `#version 300 es
precision highp float;
layout (std140) uniform proj {
    vec2 modelScale;
    vec2 modelTranslate;
    vec2 projectionScale;
};
uniform highp sampler2D uDataPoints;
uniform int uLineType;
uniform float uStepLocation;

const int TEX_WIDTH = ${BUFFER_TEXTURE_WIDTH};
const int TEX_HEIGHT = ${BUFFER_TEXTURE_HEIGHT};

vec4 dataPoint(int index) {
    int x = index % TEX_WIDTH;
    int y = index / TEX_WIDTH;
    return texelFetch(uDataPoints, ivec2(x, y), 0);
}
`

const LINE_FS_SOURCE = `#version 300 es
precision highp float;
in vec4 vertexColor;
out vec4 outColor;

void main() {
    outColor = vertexColor;
}`;

class NativeLineProgram extends LinkedWebGLProgram {
    locations;
    static VS_SOURCE = `${VS_HEADER}
uniform float uPointSize;
uniform vec4 uColor;
out vec4 vertexColor;
void main() {
    vec4 dp = dataPoint(gl_VertexID);
    vec2 pos2d = projectionScale * modelScale * (dp.xy + modelTranslate);
    gl_Position = vec4(pos2d, 0, 1);
    gl_PointSize = uPointSize;
    float opacity = dp.z;
    if (uColor.xyz != vec3(0.0, 0.0, 0.0)) {
        opacity = max(dp.z, 0.4);
    }
    if (dp.w == 0.0) {
        vertexColor = vec4(uColor.xyz, opacity);
    } else {
        highp int w = int(dp.w);
        float redComp = float(w >> 16) / 255.0;
        float greenComp = float((w >> 8) & 255) / 255.0;
        float blueComp = float(w & 255) / 255.0;
        vertexColor = vec4(vec3(redComp, greenComp, blueComp), opacity);
    }
}
`
    constructor(gl: WebGL2RenderingContext, debug: boolean) {
        super(gl, NativeLineProgram.VS_SOURCE, LINE_FS_SOURCE, debug);
        this.link();

        this.locations = {
            uDataPoints: this.getUniformLocation('uDataPoints'),
            uPointSize: this.getUniformLocation('uPointSize'),
            uColor: this.getUniformLocation('uColor'),
        }

        this.use();
        gl.uniform1i(this.locations.uDataPoints, 0);
        const projIdx = gl.getUniformBlockIndex(this.program, 'proj');
        gl.uniformBlockBinding(this.program, projIdx, 0);
    }
}

class LineProgram extends LinkedWebGLProgram {
    static VS_SOURCE = `${VS_HEADER}
uniform float uLineWidth;
uniform vec4 uColor;
out vec4 vertexColor;
void main() {
    int side = gl_VertexID & 1;
    int di = (gl_VertexID >> 1) & 1;
    int index = gl_VertexID >> 2;

    vec2 dp[2] = vec2[2](dataPoint(index).xy, dataPoint(index + 1).xy);

    vec2 base;
    vec2 off;
    if (uLineType == ${LineType.Line}) {
        base = dp[di];
        vec2 dir = dp[1] - dp[0];
        dir = normalize(modelScale * dir);
        off = vec2(-dir.y, dir.x) * uLineWidth;
    } else if (uLineType == ${LineType.Step}) {
        base = vec2(dp[0].x * (1. - uStepLocation) + dp[1].x * uStepLocation, dp[di].y);
        float up = sign(dp[0].y - dp[1].y);
        off = vec2(uLineWidth * up, uLineWidth);
    }

    if (side == 1)
        off = -off;
    vec2 cssPose = modelScale * (base + modelTranslate);
    vec2 pos2d = projectionScale * (cssPose + off);
    gl_Position = vec4(pos2d, 0, 1);
    vertexColor = vec4(uColor.xyz, 1.0);
}`;

    locations;
    constructor(gl: WebGL2RenderingContext, debug: boolean) {
        super(gl, LineProgram.VS_SOURCE, LINE_FS_SOURCE, debug);
        this.link();

        this.locations = {
            uDataPoints: this.getUniformLocation('uDataPoints'),
            uLineType: this.getUniformLocation('uLineType'),
            uStepLocation: this.getUniformLocation('uStepLocation'),
            uLineWidth: this.getUniformLocation('uLineWidth'),
            uColor: this.getUniformLocation('uColor'),
        }

        this.use();
        gl.uniform1i(this.locations.uDataPoints, 0);
        const projIdx = gl.getUniformBlockIndex(this.program, 'proj');
        gl.uniformBlockBinding(this.program, projIdx, 0);
    }
}

const BUFFER_NUM_FIELDS = 4;

class SeriesSegmentVertexArray {
    dataBuffer;

    constructor(
        private gl: WebGL2RenderingContext,
        private dataPoints: DataPointsBuffer,
        private colormapFn: ColormapFn,
    ) {
        this.dataBuffer = throwIfFalsy(gl.createTexture());
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, BUFFER_TEXTURE_WIDTH, BUFFER_TEXTURE_HEIGHT);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BUFFER_TEXTURE_WIDTH, BUFFER_TEXTURE_HEIGHT, gl.RGBA, gl.FLOAT, new Float32Array(BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT * BUFFER_NUM_FIELDS));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }

    delete() {
        this.gl.deleteTexture(this.dataBuffer);
    }

    syncPoints(start: number, n: number, bufferPos: number) {
        const dps = this.dataPoints;
        let rowStart = Math.floor(bufferPos / BUFFER_TEXTURE_WIDTH);
        let rowEnd = Math.ceil((bufferPos + n) / BUFFER_TEXTURE_WIDTH);
        // Ensure we have some padding at both ends of data.
        if (rowStart > 0 && start === 0 && bufferPos === rowStart * BUFFER_TEXTURE_WIDTH) {
            rowStart--;
        }
        if (rowEnd < BUFFER_TEXTURE_HEIGHT && start + n === dps.length && bufferPos + n === rowEnd * BUFFER_TEXTURE_WIDTH) {
            rowEnd++;
        }

        const buffer = new Float32Array((rowEnd - rowStart) * BUFFER_TEXTURE_WIDTH * BUFFER_NUM_FIELDS);
        for (let r = rowStart; r < rowEnd; r++) {
            for (let c = 0; c < BUFFER_TEXTURE_WIDTH; c++) {
                const p = r * BUFFER_TEXTURE_WIDTH + c;
                const i = Math.max(Math.min(start + p - bufferPos, dps.length - 1), 0);
                const dp = dps[i];
                const bufferIdx = ((r - rowStart) * BUFFER_TEXTURE_WIDTH + c) * BUFFER_NUM_FIELDS;
                buffer[bufferIdx] = dp.x;
                buffer[bufferIdx + 1] = dp.y;
                buffer[bufferIdx + 2] = dp.a === -1 ? 0 : dp.a;
                buffer[bufferIdx + 3] = 0;
            }
        }
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rowStart, BUFFER_TEXTURE_WIDTH, rowEnd - rowStart, gl.RGBA, gl.FLOAT, buffer);
    }

    syncBarPoints(start: number, n: number, bufferPos: number) {
        const deriveDp = (dp: any, x: number, y: number) => ({
            x: dp.x + x,
            y: dp.y + y,
            a: dp.a,
        });

        const numVertices = 6;

        const dps = new Array(this.dataPoints.length * numVertices)
        for (let dataIdx = 0; dataIdx < this.dataPoints.length; dataIdx++) {
            const dp = this.dataPoints[dataIdx];
            const lb = dp.lb != null ? dp.lb : 0.5
            const rb = dp.rb != null ? dp.rb : 0.5
            const idx = dataIdx * numVertices;

            dps[idx] = deriveDp(dp, -lb, -0.5);
            dps[idx + 1] = deriveDp(dp, -lb, 0.5);
            dps[idx + 2] = deriveDp(dp, rb, 0.5);
            dps[idx + 3] = deriveDp(dp, rb, 0.5);
            dps[idx + 4] = deriveDp(dp, -lb, -0.5);
            dps[idx + 5] = deriveDp(dp, rb, -0.5);
        }

        bufferPos = bufferPos > 1 ? (bufferPos - 1) * numVertices + 1 : 1
        start = start > 1 ? (start - 1) * numVertices + 1 : 1
        n = n * numVertices

        let rowStart = Math.floor(bufferPos / BUFFER_TEXTURE_WIDTH);
        let rowEnd = Math.ceil((bufferPos + n) / BUFFER_TEXTURE_WIDTH);

        const buffer = new Float32Array((rowEnd - rowStart) * BUFFER_TEXTURE_WIDTH * BUFFER_NUM_FIELDS);
        for (let r = rowStart; r < rowEnd; r++) {
            for (let c = 0; c < BUFFER_TEXTURE_WIDTH; c++) {
                const p = r * BUFFER_TEXTURE_WIDTH + c;
                const i = Math.max(Math.min(start + p - bufferPos, dps.length - 1), 0);
                const dp = dps[i];
                const bufferIdx = ((r - rowStart) * BUFFER_TEXTURE_WIDTH + c) * BUFFER_NUM_FIELDS;
                buffer[bufferIdx] = dp.x;
                buffer[bufferIdx + 1] = dp.y;
                if (dp.a === -1) {
                    buffer[bufferIdx + 2] = 0.0;
                    buffer[bufferIdx + 3] = 0.0;
                } else if (this.colormapFn == null) {
                    buffer[bufferIdx + 2] = dp.a;
                    buffer[bufferIdx + 3] = 0.0;
                } else {
                    buffer[bufferIdx + 2] = 1.0;
                    buffer[bufferIdx + 3] = this.colorStrToNumber(this.colormapFn(dp.a));
                }
            }
        }
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rowStart, BUFFER_TEXTURE_WIDTH, rowEnd - rowStart, gl.RGBA, gl.FLOAT, buffer);
    }

    colorStrToNumber(color: string): number {
        if (color.startsWith('#')) {
            return parseInt(color.slice(1), 16)
        } else if (color.startsWith('rgb')) {
            return parseInt(this.rgbToHex(color), 16);
        }
        return 0.0;
    }

    rgbToHex(rgb: string): string {
        let [r, g, b]: any = rgb.match(/\d+/g)?.map(x => parseInt(x));
        return ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    /**
     * @param renderInterval [start, end) interval of data points, start from 0
     */
    draw(renderInterval: { start: number, end: number }, type: LineType) {
        const bufferIntervalCapacity = calcBufferIntervalCapacity(type);
        const first = Math.max(0, renderInterval.start);
        const last = Math.min(bufferIntervalCapacity, renderInterval.end)
        const count = last - first
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);
        if (type === LineType.Line) {
            gl.drawArrays(gl.TRIANGLE_STRIP, first * 4, count * 4 + (last !== renderInterval.end ? 2 : 0));
        } else if (type === LineType.Step) {
            let firstP = first * 4;
            let countP = count * 4 + 2;
            if (first === renderInterval.start) {
                firstP -= 2;
                countP += 2;
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, firstP, countP);
        } else if (type === LineType.NativeLine) {
            gl.drawArrays(gl.LINE_STRIP, first, count + 1);
        } else if (type === LineType.NativePoint) {
            gl.drawArrays(gl.POINTS, first, count + 1);
        } else if (type === LineType.Bar) {
            let firstP = Math.max(0, (first * 6) - 6)
            let countP = (count * 6) + 12
            gl.drawArrays(gl.TRIANGLES, firstP, countP);
        }
    }
}

/**
 * An array of `SeriesSegmentVertexArray` to represent a series
 */
class SeriesVertexArray {
    private segments = [] as SeriesSegmentVertexArray[];
    // each segment has at least 2 points
    private validStart = 0;  // start position of the first segment. (0, BUFFER_INTERVAL_CAPACITY]
    private validEnd = 0;    // end position of the last segment. [2, BUFFER_POINT_CAPACITY)

    constructor(
        private gl: WebGL2RenderingContext,
        private series: TimeChartSeriesOptions,
    ) {
    }

    private calcBufferPointCapacity() {
        return calcBufferPointCapacity(this.series.lineType);
    }

    private calcBufferIntervalCapacity() {
        return calcBufferIntervalCapacity(this.series.lineType);
    }

    private segmentSync(segment: SeriesSegmentVertexArray, start: number, n: number, bufferPos: number) {
        if (this.series.lineType == LineType.Bar) {
            segment.syncBarPoints(start, n, bufferPos)
        } else {
            segment.syncPoints(start, n, bufferPos)
        }
    }

    private popFront() {
        if (this.series.data.poped_front === 0)
            return;

        this.validStart += this.series.data.poped_front;

        const bufferIntervalCapacity = this.calcBufferIntervalCapacity();
        while (this.validStart > bufferIntervalCapacity) {
            const activeArray = this.segments[0];
            activeArray.delete();
            this.segments.shift();
            this.validStart -= bufferIntervalCapacity;
        }
        this.segmentSync(this.segments[0], 0, 0, this.validStart);
    }
    private popBack() {
        if (this.series.data.poped_back === 0)
            return;

        this.validEnd -= this.series.data.poped_back;

        const bufferIntervalCapacity = this.calcBufferIntervalCapacity();
        const bufferPointCapacity = this.calcBufferPointCapacity();
        while (this.validEnd < bufferPointCapacity - bufferIntervalCapacity) {
            const activeArray = this.segments[this.segments.length - 1];
            activeArray.delete();
            this.segments.pop();
            this.validEnd += bufferIntervalCapacity;
        }

        this.segmentSync(this.segments[this.segments.length - 1], this.series.data.length, 0, this.validEnd)
    }

    private newArray() {
        return new SeriesSegmentVertexArray(this.gl, this.series.data, this.series.colormapFn);
    }

    private pushFront() {
        let numDPtoAdd = this.series.data.pushed_front;
        if (numDPtoAdd === 0)
            return;
        const bufferPointCapacity = this.calcBufferPointCapacity();
        const bufferIntervalCapacity = this.calcBufferIntervalCapacity();
        const newArray = () => {
            this.segments.unshift(this.newArray());
            this.validStart = bufferPointCapacity;
        }

        if (this.segments.length === 0) {
            newArray();
            this.validEnd = this.validStart = bufferPointCapacity - 1;
        }

        while (true) {
            const activeArray = this.segments[0];
            const n = Math.min(this.validStart, numDPtoAdd);
            this.segmentSync(activeArray, numDPtoAdd - n, n, this.validStart - n);
            numDPtoAdd -= this.validStart - (bufferPointCapacity - bufferIntervalCapacity);
            this.validStart -= n;
            if (this.validStart > 0)
                break;
            newArray();
        }
    }

    private pushBack() {
        let numDPtoAdd = this.series.data.pushed_back;
        if (numDPtoAdd === 0)
            return

        const newArray = () => {
            this.segments.push(this.newArray());
            this.validEnd = 0;
        }

        if (this.segments.length === 0) {
            newArray();
            this.validEnd = this.validStart = 1;
        }
        
        const bufferPointCapacity = this.calcBufferPointCapacity();
        const bufferIntervalCapacity = this.calcBufferIntervalCapacity();
        
        while (true) {
            const activeArray = this.segments[this.segments.length - 1];
            const n = Math.min(bufferPointCapacity - this.validEnd, numDPtoAdd);
            this.segmentSync(activeArray, this.series.data.length - numDPtoAdd, n, this.validEnd)
            // Note that each segment overlaps with the previous one.
            // numDPtoAdd can increase here, indicating the overlapping part should be synced again to the next segment
            numDPtoAdd -= bufferIntervalCapacity - this.validEnd;
            this.validEnd += n;
            // Fully fill the previous segment before creating a new one
            if (this.validEnd < bufferPointCapacity) {
                break;
            }
            newArray();
        }
    }

    deinit() {
        for (const s of this.segments)
            s.delete();
        this.segments = [];
    }

    syncBuffer() {
        const d = this.series.data;
        if (d.length - d.pushed_back - d.pushed_front < 2) {
            this.deinit();
            d.poped_front = d.poped_back = 0;
        }
        if (this.segments.length === 0) {
            if (d.length >= 2) {
                if (d.pushed_back > d.pushed_front) {
                    d.pushed_back = d.length;
                    this.pushBack();
                } else {
                    d.pushed_front = d.length;
                    this.pushFront();
                }
            }
            return;
        }
        this.popFront();
        this.popBack();
        this.pushFront();
        this.pushBack();
    }

    draw(renderDomain: { min: number, max: number }) {
        const data = this.series.data;
        if (this.segments.length === 0 || data[0].x > renderDomain.max || data[data.length - 1].x < renderDomain.min)
            return;

        const bufferIntervalCapacity = this.calcBufferIntervalCapacity();
        const key = (d: DataPoint) => d.x
        const firstDP = domainSearch(data, 1, data.length, renderDomain.min, key) - 1;
        const lastDP = domainSearch(data, firstDP, data.length - 1, renderDomain.max, key)
        const startInterval = firstDP + this.validStart;
        const endInterval = lastDP + this.validStart;
        const startArray = Math.floor(startInterval / bufferIntervalCapacity);
        const endArray = Math.ceil(endInterval / bufferIntervalCapacity);

        for (let i = startArray; i < endArray; i++) {
            const arrOffset = i * bufferIntervalCapacity
            this.segments[i].draw({
                start: startInterval - arrOffset,
                end: endInterval - arrOffset,
            }, this.series.lineType);
        }
    }
}

export class LineChartRenderer {
    private lineProgram = new LineProgram(this.gl, this.options.debugWebGL);
    private nativeLineProgram = new NativeLineProgram(this.gl, this.options.debugWebGL);
    private uniformBuffer;
    private arrays = new Map<TimeChartSeriesOptions, SeriesVertexArray>();
    private height = 0;
    private width = 0;
    private renderHeight = 0;
    private renderWidth = 0;

    constructor(
        private model: RenderModel,
        private gl: WebGL2RenderingContext,
        private options: ResolvedCoreOptions,
    ) {
        const uboSize = gl.getActiveUniformBlockParameter(this.lineProgram.program, 0, gl.UNIFORM_BLOCK_DATA_SIZE);
        this.uniformBuffer = new ShaderUniformData(this.gl, uboSize);

        model.updated.on(() => this.drawFrame());
        model.resized.on((w, h) => this.onResize(w, h));
    }

    syncBuffer() {
        for (const s of this.options.series) {
            let a = this.arrays.get(s);
            if (!a) {
                a = new SeriesVertexArray(this.gl, s);
                this.arrays.set(s, a);
            }
            a.syncBuffer();
        }
    }

    syncViewport() {
        this.renderWidth = this.width - this.options.renderPaddingLeft - this.options.renderPaddingRight;
        this.renderHeight = this.height - this.options.renderPaddingTop - this.options.renderPaddingBottom;

        const scale = vec2.fromValues(this.renderWidth, this.renderHeight)
        vec2.divide(scale, [2., 2.], scale)
        this.uniformBuffer.projectionScale.set(scale);
    }

    onResize(width: number, height: number) {
        this.height = height;
        this.width = width;
    }

    drawFrame() {
        this.syncBuffer();
        this.syncDomain();
        this.uniformBuffer.upload();
        const gl = this.gl;
        for (const [ds, arr] of this.arrays) {
            if (!ds.visible) {
                continue;
            }

            const prog = ds.lineType === LineType.NativeLine || ds.lineType === LineType.NativePoint || ds.lineType === LineType.Bar ? this.nativeLineProgram : this.lineProgram;
            prog.use();
            const color = resolveColorRGBA(ds.color ?? this.options.color);
            gl.uniform4fv(prog.locations.uColor, color);

            const lineWidth = ds.lineWidth ?? this.options.lineWidth;
            if (prog instanceof LineProgram) {
                gl.uniform1i(prog.locations.uLineType, ds.lineType);
                gl.uniform1f(prog.locations.uLineWidth, lineWidth / 2);
                if (ds.lineType === LineType.Step)
                    gl.uniform1f(prog.locations.uStepLocation, ds.stepLocation);
            } else {
                if (ds.lineType === LineType.NativeLine || ds.lineType == LineType.Bar)
                    gl.lineWidth(lineWidth * this.options.pixelRatio);  // Not working on most platforms
                else if (ds.lineType === LineType.NativePoint) {
                    gl.uniform1f(prog.locations.uPointSize, lineWidth * this.options.pixelRatio);
                }
            }

            const renderDomain = {
                min: this.model.xScale.invert(this.options.renderPaddingLeft - lineWidth / 2),
                max: this.model.xScale.invert(this.width - this.options.renderPaddingRight + lineWidth / 2),
            };
            arr.draw(renderDomain);
        }
        if (this.options.debugWebGL) {
            const err = gl.getError();
            if (err != gl.NO_ERROR) {
                throw new Error(`WebGL error ${err}`);
            }
        }
    }

    syncDomain() {
        this.syncViewport();
        const m = this.model;

        // for any x,
        // (x - domain[0]) / (domain[1] - domain[0]) * (range[1] - range[0]) + range[0] - W / 2 - padding = s * (x + t)
        // => s = (range[1] - range[0]) / (domain[1] - domain[0])
        //    t = (range[0] - W / 2 - padding) / s - domain[0]

        // Not using vec2 for precision
        const xDomain = m.xScale.domain();
        const xRange = m.xScale.range();
        const yDomain = m.yScale.domain();
        const yRange = m.yScale.range();
        const s = [
            (xRange[1] - xRange[0]) / (xDomain[1] - xDomain[0]),
            (yRange[0] - yRange[1]) / (yDomain[1] - yDomain[0]),
        ];
        const t = [
            (xRange[0] - this.renderWidth / 2 - this.options.renderPaddingLeft) / s[0] - xDomain[0],
            -(yRange[0] - this.renderHeight / 2 - this.options.renderPaddingTop) / s[1] - yDomain[0],
        ];

        this.uniformBuffer.modelScale.set(s);
        this.uniformBuffer.modelTranslate.set(t);
    }
}

export const lineChart: TimeChartPlugin<LineChartRenderer> = {
    apply(chart) {
        return new LineChartRenderer(chart.model, chart.canvasLayer.gl, chart.options);
    }
}
