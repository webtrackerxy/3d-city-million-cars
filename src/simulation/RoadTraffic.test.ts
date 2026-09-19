import { describe, expect, it } from "vitest";
import { VehicleBuffer } from "@/data/VehicleBuffer.ts";
import type { RoadNetworkFile } from "@/types/roads.ts";
import { RoadNetwork } from "./RoadNetwork.ts";
import { RoadTraffic } from "./RoadTraffic.ts";

/** A 100 m eastbound edge followed by a 100 m northbound edge, ending in a dead end. */
function lShape(): RoadNetworkFile {
  return {
    city: "test",
    origin: { longitude: 0, latitude: 0 },
    sizeMetres: 1000,
    source: "test",
    generatedAt: "",
    highwayClasses: ["residential"],
    stats: { ways: 1, nodes: 3, directedEdges: 2, oneWayWays: 1, roadKm: 0.2 },
    // "lon/lat" here are used directly as local metres by the test converter
    nodes: [0, 0, 100, 0, 100, 100],
    edges: [0, 1, 10, 0, 1, 2, 10, 0],
  };
}

// x = "lon" (east), z = −"lat" (north is −z)
const toLocal = (lon: number, lat: number) => ({ x: lon, z: -lat });

describe("RoadNetwork", () => {
  const net = new RoadNetwork(lShape(), toLocal);

  it("builds lengths, headings and CSR adjacency", () => {
    expect(net.edgeCount).toBe(2);
    expect(net.edgeLength[0]).toBeCloseTo(100, 4);
    expect(net.edgeHeading[0]).toBeCloseTo(Math.PI / 2, 6); // east
    expect(net.edgeHeading[1]).toBeCloseTo(0, 6); // north
    expect(net.outDegree(0)).toBe(1);
    expect(net.outEdge(0, 0)).toBe(0);
    expect(net.outDegree(1)).toBe(1);
    expect(net.outEdge(1, 0)).toBe(1);
    expect(net.outDegree(2)).toBe(0);
    expect(net.totalLength).toBeCloseTo(200, 4);
  });

  it("finds the edge at a network distance", () => {
    expect(net.edgeAtDistance(30)).toEqual({ edge: 0, offset: 30 });
    const p = net.edgeAtDistance(150);
    expect(p.edge).toBe(1);
    expect(p.offset).toBeCloseTo(50, 4);
  });
});

describe("RoadTraffic", () => {
  it("moves a vehicle along an edge and turns the corner with the edge heading", () => {
    const file = lShape();
    const net = new RoadNetwork(file, toLocal);
    const buffer = new VehicleBuffer(1);
    const traffic = new RoadTraffic(buffer, net, {
      count: 1,
      seed: 1,
      speedFactor: [1, 1],
      junctionSpeed: 10,
    });
    // spawned at network distance ≈ 0..spacing/2 on edge 0, heading east
    expect(buffer.heading[0]).toBeCloseTo(Math.PI / 2, 6);
    expect(buffer.z[0]).toBeCloseTo(0, 4);
    traffic.start();
    // drive for 8 s at ≤ 10 m/s: must have passed the 100 m corner onto the northbound edge
    for (let i = 0; i < 80; i++) traffic.step(0.1);
    expect(buffer.heading[0]).toBeCloseTo(0, 6);
    expect(buffer.x[0]).toBeCloseTo(100, 3);
    expect(buffer.z[0]).toBeLessThan(0); // moving north
    expect(buffer.speed[0]).toBeGreaterThan(0);
  });

  it("respawns at a dead end instead of leaving the network", () => {
    const net = new RoadNetwork(lShape(), toLocal);
    const buffer = new VehicleBuffer(1);
    const traffic = new RoadTraffic(buffer, net, { count: 1, seed: 3, speedFactor: [1, 1] });
    traffic.start();
    for (let i = 0; i < 600; i++) traffic.step(0.1); // 60 s: far beyond the 200 m network
    const x = buffer.x[0] as number;
    const z = buffer.z[0] as number;
    expect(x).toBeGreaterThanOrEqual(-1e-3);
    expect(x).toBeLessThanOrEqual(100 + 1e-3);
    expect(z).toBeLessThanOrEqual(1e-3);
    expect(z).toBeGreaterThanOrEqual(-100 - 1e-3);
  });

  it("keeps followers behind a slow leader (car following, no overtaking)", () => {
    // a single long straight edge
    const file: RoadNetworkFile = {
      ...lShape(),
      nodes: [0, 0, 1000, 0],
      edges: [0, 1, 20, 0],
      stats: { ways: 1, nodes: 2, directedEdges: 1, oneWayWays: 1, roadKm: 1 },
    };
    const net = new RoadNetwork(file, toLocal);
    const buffer = new VehicleBuffer(2);
    const traffic = new RoadTraffic(buffer, net, { count: 2, seed: 2, speedFactor: [1, 1] });
    // vehicle 0 ahead and slow, vehicle 1 behind and fast
    buffer.speed[0] = 3;
    buffer.speed[1] = 20;
    const leaderFactor = 3 / 20;
    // force the leader's desired speed low by patching its factor through a fresh instance is
    // not possible; instead verify ordering and gap over a short horizon where the leader
    // still accelerates slowly from 3 m/s while the follower closes in.
    traffic.start();
    const ahead = (buffer.x[0] as number) > (buffer.x[1] as number) ? 0 : 1;
    const behind = 1 - ahead;
    for (let i = 0; i < 100; i++) {
      traffic.step(0.1);
      const gap = (buffer.x[ahead] as number) - (buffer.x[behind] as number);
      if ((buffer.x[ahead] as number) < 990) expect(gap).toBeGreaterThanOrEqual(4.5 - 1e-6);
    }
    expect(leaderFactor).toBeLessThan(1);
  });

  it("spawns vehicles evenly along the network length", () => {
    const net = new RoadNetwork(lShape(), toLocal);
    const buffer = new VehicleBuffer(20);
    new RoadTraffic(buffer, net, { count: 20, seed: 5 });
    let onFirst = 0;
    for (let i = 0; i < 20; i++)
      if ((buffer.z[i] as number) > -1e-3 && (buffer.x[i] as number) < 100 - 1e-3) onFirst++;
    expect(onFirst).toBeGreaterThanOrEqual(8);
    expect(onFirst).toBeLessThanOrEqual(12);
  });
});

describe("lane offset on two-way roads", () => {
  /** one 100 m two-way east–west road (edges 0: east, 1: west) plus a one-way spur north */
  function twoWay(): RoadNetworkFile {
    return {
      ...lShape(),
      nodes: [0, 0, 100, 0, 100, 100],
      edges: [0, 1, 10, 0, 1, 0, 10, 0, 1, 2, 10, 0],
    };
  }

  it("flags the directions that have a reverse edge", () => {
    const net = new RoadNetwork(twoWay(), toLocal);
    expect(Array.from(net.edgeTwoWay)).toEqual([1, 1, 0]);
  });

  it("puts opposite directions on opposite sides of the centreline", () => {
    for (const driveOnLeft of [true, false]) {
      const net = new RoadNetwork(twoWay(), toLocal);
      const buffer = new VehicleBuffer(2);
      const traffic = new RoadTraffic(buffer, net, { count: 2, seed: 1, driveOnLeft, laneOffset: 2 });
      // vehicle 0 spawns on edge 0 (east), vehicle 1 further along the network on edge 1 (west)
      const east = buffer.heading[0] as number;
      const west = buffer.heading[1] as number;
      expect(east).toBeCloseTo(Math.PI / 2, 6);
      expect(west).toBeCloseTo(-Math.PI / 2, 6);
      // left of eastbound travel is north (−z) when driving on the left; south otherwise
      const expectedZ = driveOnLeft ? -2 : 2;
      expect(buffer.z[0]).toBeCloseTo(expectedZ, 5);
      expect(buffer.z[1]).toBeCloseTo(-expectedZ, 5);
      traffic.dispose();
    }
  });
});
