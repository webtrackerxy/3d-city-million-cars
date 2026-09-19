/**
 * Directed road graph in local metres, built once from a RoadNetworkFile. Typed arrays
 * only, so it can be built inside a worker and shared by the simulation and (later)
 * routing. Each edge is a straight segment between two OSM nodes.
 */

import type { HeightField } from "@/geo/HeightField.ts";
import type { RoadNetworkFile } from "@/types/roads.ts";

export type ToLocal = (longitude: number, latitude: number) => { x: number; z: number };

export class RoadNetwork {
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** node positions, local metres */
  readonly nodeX: Float32Array;
  readonly nodeZ: Float32Array;
  /** node elevation above sea level, metres (0 until applyElevation) */
  readonly nodeY: Float32Array;
  /** per edge */
  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeLength: Float32Array;
  readonly edgeSpeed: Float32Array;
  readonly edgeClass: Uint8Array;
  /** compass heading of the edge in radians (clockwise from north) */
  readonly edgeHeading: Float32Array;
  /** unit direction of the edge in local metres */
  readonly edgeDirX: Float32Array;
  readonly edgeDirZ: Float32Array;
  /** 1 when the opposite direction exists as its own edge (two-way road) */
  readonly edgeTwoWay: Uint8Array;
  /** CSR adjacency: outgoing edges of node n are outEdges[outStart[n] .. outStart[n+1]) */
  readonly outStart: Int32Array;
  readonly outEdges: Int32Array;
  readonly totalLength: number;
  /** cumulative edge length, for uniform spawning along the network */
  readonly cumulativeLength: Float64Array;

  constructor(file: RoadNetworkFile, toLocal: ToLocal) {
    this.nodeCount = file.nodes.length / 2;
    this.nodeX = new Float32Array(this.nodeCount);
    this.nodeZ = new Float32Array(this.nodeCount);
    this.nodeY = new Float32Array(this.nodeCount);
    for (let i = 0; i < this.nodeCount; i++) {
      const p = toLocal(file.nodes[i * 2] as number, file.nodes[i * 2 + 1] as number);
      this.nodeX[i] = p.x;
      this.nodeZ[i] = p.z;
    }
    this.edgeCount = file.edges.length / 4;
    const n = this.edgeCount;
    this.edgeFrom = new Int32Array(n);
    this.edgeTo = new Int32Array(n);
    this.edgeLength = new Float32Array(n);
    this.edgeSpeed = new Float32Array(n);
    this.edgeClass = new Uint8Array(n);
    this.edgeHeading = new Float32Array(n);
    this.edgeDirX = new Float32Array(n);
    this.edgeDirZ = new Float32Array(n);
    this.cumulativeLength = new Float64Array(n + 1);
    const outCount = new Int32Array(this.nodeCount + 1);
    let total = 0;
    for (let e = 0; e < n; e++) {
      const from = file.edges[e * 4] as number;
      const to = file.edges[e * 4 + 1] as number;
      this.edgeFrom[e] = from;
      this.edgeTo[e] = to;
      this.edgeSpeed[e] = file.edges[e * 4 + 2] as number;
      this.edgeClass[e] = file.edges[e * 4 + 3] as number;
      const dx = (this.nodeX[to] as number) - (this.nodeX[from] as number);
      const dz = (this.nodeZ[to] as number) - (this.nodeZ[from] as number);
      const len = Math.hypot(dx, dz) || 1e-3;
      this.edgeLength[e] = len;
      this.edgeDirX[e] = dx / len;
      this.edgeDirZ[e] = dz / len;
      // heading clockwise from north: north is -z, east is +x
      this.edgeHeading[e] = Math.atan2(dx, -dz);
      outCount[from + 1] = (outCount[from + 1] as number) + 1;
      this.cumulativeLength[e] = total;
      total += len;
    }
    this.cumulativeLength[n] = total;
    this.totalLength = total;
    // CSR
    this.outStart = new Int32Array(this.nodeCount + 1);
    for (let i = 0; i < this.nodeCount; i++) {
      this.outStart[i + 1] = (this.outStart[i] as number) + (outCount[i + 1] as number);
    }
    this.outEdges = new Int32Array(n);
    const fill = new Int32Array(this.nodeCount);
    for (let e = 0; e < n; e++) {
      const from = this.edgeFrom[e] as number;
      const slot = (this.outStart[from] as number) + (fill[from] as number);
      this.outEdges[slot] = e;
      fill[from] = (fill[from] as number) + 1;
    }
    // two-way roads are emitted as one edge per direction over the same geometry; flag
    // them so traffic can be pushed into the lane on its side of the centreline
    this.edgeTwoWay = new Uint8Array(n);
    for (let e = 0; e < n; e++) {
      const from = this.edgeFrom[e] as number;
      const to = this.edgeTo[e] as number;
      const degree = this.outDegree(to);
      for (let k = 0; k < degree; k++) {
        if ((this.edgeTo[this.outEdge(to, k)] as number) === from) {
          this.edgeTwoWay[e] = 1;
          break;
        }
      }
    }
  }

  /** Set node elevations from a height field (absolute, the map drapes at sea-level datum). */
  applyElevation(field: HeightField): void {
    for (let i = 0; i < this.nodeCount; i++) {
      this.nodeY[i] = field.sample(this.nodeX[i] as number, this.nodeZ[i] as number);
    }
  }

  outDegree(node: number): number {
    return (this.outStart[node + 1] as number) - (this.outStart[node] as number);
  }

  /** k-th outgoing edge of a node (0 ≤ k < outDegree). */
  outEdge(node: number, k: number): number {
    return this.outEdges[(this.outStart[node] as number) + k] as number;
  }

  /** Edge containing the network-length position `d` in [0, totalLength), by binary search. */
  edgeAtDistance(d: number): { edge: number; offset: number } {
    let lo = 0;
    let hi = this.edgeCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.cumulativeLength[mid] as number) <= d) lo = mid;
      else hi = mid - 1;
    }
    return { edge: lo, offset: d - (this.cumulativeLength[lo] as number) };
  }
}
