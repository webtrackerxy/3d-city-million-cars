import type { VehicleAssetManifest } from "@/types/manifest.ts";

/** Base URL under which assets/generated/ is served (see vite.config.ts). */
export const VEHICLE_ASSET_BASE = "/vehicles";

export function vehicleAssetUrl(vehicle: string, file: string): string {
  return `${VEHICLE_ASSET_BASE}/${vehicle}/${file}`;
}

function isManifest(value: unknown): value is VehicleAssetManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<VehicleAssetManifest>;
  return (
    typeof m.vehicle === "string" && Array.isArray(m.lods) && m.lods.every((l) => typeof l.file === "string")
  );
}

export async function loadManifest(vehicle: string): Promise<VehicleAssetManifest> {
  const url = vehicleAssetUrl(vehicle, "manifest.json");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manifest ${url}: HTTP ${res.status}`);
  const json: unknown = await res.json();
  if (!isManifest(json)) throw new Error(`manifest ${url}: unexpected shape`);
  return json;
}
