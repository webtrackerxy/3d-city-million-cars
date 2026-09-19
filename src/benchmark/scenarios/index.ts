import type { Scenario } from "../types.ts";
import { carsLod, carsLod3 } from "./cars.ts";
import { cubesMovingCpu, cubesMovingGpu, cubesStatic } from "./cubes.ts";
import { triangleThroughput } from "./triangleThroughput.ts";

export const scenarios: readonly Scenario[] = [
  cubesStatic,
  cubesMovingCpu,
  cubesMovingGpu,
  triangleThroughput,
  carsLod3,
  carsLod,
];

export function findScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}
