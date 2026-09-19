/**
 * Core vehicle domain types (spec §41). These are leaf types: nothing here imports
 * from the rest of `src/`.
 *
 * Coordinates follow docs/coordinates.md: the renderer works in a local east-north-up
 * frame with Three.js axes (x east, y up, z south), in metres from a per-city origin.
 */

/** Vehicle category; index into the asset library. Stored per vehicle as a Uint8. */
export enum VehicleType {
  Sedan = 0,
  Suv = 1,
  Van = 2,
  Bus = 3,
  Truck = 4,
}

/** Level of detail buckets. LOD4 is a generated box/point, never a GLB. */
export enum VehicleLod {
  Lod0 = 0,
  Lod1 = 1,
  Lod2 = 2,
  Lod3 = 3,
  Point = 4,
  Culled = 5,
}

export const VEHICLE_LOD_COUNT = 4;

/**
 * A single vehicle's state as a value object. Used at API boundaries (selection,
 * network decoding, tests); never allocated per vehicle per frame. Bulk state lives in
 * `VehicleBuffer` (Structure of Arrays).
 */
export interface VehicleState {
  id: number;
  /** metres east of the city origin */
  x: number;
  /** metres above the origin's ground plane */
  y: number;
  /** metres south of the city origin (Three.js +z) */
  z: number;
  /** compass heading in radians, clockwise from north */
  heading: number;
  /** metres per second */
  speed: number;
  vehicleType: VehicleType;
  /** palette index for the body paint */
  colorIndex: number;
}

/** Geographic position, used only at the data boundary (before conversion to metres). */
export interface GeoPosition {
  longitude: number;
  latitude: number;
  altitude: number;
}

/**
 * Anything that can fill a vehicle buffer over time: the synthetic simulator, a
 * worker-backed simulator, a WebSocket feed, a SUMO bridge.
 */
export interface TrafficDataSource {
  readonly id: string;
  /** Number of vehicles this source will populate (≤ buffer capacity). */
  readonly vehicleCount: number;
  /** Update interval the source produces, in seconds (e.g. 0.1 for 10 Hz). */
  readonly tickInterval: number;
  /** Advance the source by dt; returns the number of fixed ticks performed (0 when paused). */
  tick(dtSeconds: number): number;
  dispose(): void;
}

/** A simulator is a data source that owns its own clock and can be paused. */
export interface SimulationSource extends TrafficDataSource {
  readonly running: boolean;
  start(): void;
  stop(): void;
}
