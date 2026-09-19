/** Shape of `assets/generated/roads/<city>.json` produced by scripts/build-roads.ts. */
export interface RoadNetworkFile {
  city: string;
  origin: { longitude: number; latitude: number };
  sizeMetres: number;
  source: string;
  generatedAt: string;
  /** highway class names; edges reference them by index */
  highwayClasses: string[];
  stats: { ways: number; nodes: number; directedEdges: number; oneWayWays: number; roadKm: number };
  /** flat [lon, lat, lon, lat, ...] */
  nodes: number[];
  /** flat [fromNode, toNode, speedMps, classIndex, ...] directed edges */
  edges: number[];
}
