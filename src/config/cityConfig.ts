/**
 * City / dataset configuration. The origin anchors the local metre frame that vehicles,
 * tiles and the MapLibre custom layer share (docs/coordinates.md §4). Everything
 * dataset-specific lives here, not in rendering code.
 */

export interface CityTilesetConfig {
  /** tileset.json URL (open datasets); omit when `ion` is set */
  url?: string;
  /** Cesium ion asset (e.g. 96188 = Cesium OSM Buildings); needs an ion access token
   *  via VITE_CESIUM_ION_TOKEN or ?ionToken= */
  ion?: { assetId: number };
  /** ellipsoid height of the ground at the origin (metres); tiles are shifted so this is y = 0 */
  groundHeight: number;
  hideBasemapBuildings?: boolean;
  attribution?: string;
  errorTarget?: number;
}

export interface CityConfig {
  id: string;
  name: string;
  /** WGS84 origin of the local east-north-up frame */
  origin: { longitude: number; latitude: number };
  /** MapLibre style URL (must be served with CORS headers; the app is cross-origin isolated) */
  styleUrl: string;
  /** initial camera; `center` defaults to the origin (which may sit inside a building) */
  view: { zoom: number; pitch: number; bearing: number; center?: { longitude: number; latitude: number } };
  /**
   * side length in metres of the square road network around the origin (also the
   * synthetic-traffic and height-field extent); rebuild roads after changing it
   */
  trafficAreaMetres: number;
  /**
   * largest vehicle count offered in the UI: the road network jams (4.5 m car + 2 m gap)
   * at about directed lane length / 6.5 m, so this stays well below that
   */
  maxVehicles: number;
  /** vehicle count shown when the user has not chosen one (`?vehicles=` or the dropdown) */
  defaultVehicles: number;
  /** OGC 3D Tiles buildings; omitted where no open dataset is configured */
  tileset?: CityTilesetConfig;
  /** drape the basemap over a DEM and elevate the roads by default (`?terrain=0` overrides) */
  terrain: boolean;
  /** traffic keeps to the left of two-way roads */
  driveOnLeft: boolean;
}

export const CITIES: Record<string, CityConfig> = {
  tokyo: {
    id: "tokyo",
    terrain: true,
    driveOnLeft: true,
    name: "Tokyo (Marunouchi)",
    origin: { longitude: 139.7671, latitude: 35.6812 },
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    view: {
      zoom: 14.5,
      pitch: 60,
      bearing: 0,
      // Hibiya-dori (primary road) rather than the origin, which sits inside Tokyo Station
      center: { longitude: 139.7598, latitude: 35.6793 },
    },
    trafficAreaMetres: 8000,
    maxVehicles: 100_000,
    defaultVehicles: 100_000,
    tileset: {
      // PLATEAU (MLIT Japan) Chiyoda-ku 2023 building LOD1, textured; experimental streaming service
      url: "https://assets.cms.plateau.reearth.io/assets/0e/e5948a-e95c-4e31-be85-1f8c066ed996/13101_chiyoda-ku_pref_2023_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod1/tileset.json",
      groundHeight: 36,
      hideBasemapBuildings: true,
      attribution: "Buildings: PLATEAU (MLIT Japan), CC BY 4.0",
      errorTarget: 12,
    },
  },
  london: {
    id: "london",
    terrain: true,
    driveOnLeft: true,
    name: "London (Westminster)",
    origin: { longitude: -0.1281, latitude: 51.508 },
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    view: { zoom: 14.5, pitch: 60, bearing: 15 },
    trafficAreaMetres: 20000, // 10,100 km of directed lanes: 10 m per car at 1,000,000
    maxVehicles: 1_000_000,
    defaultVehicles: 1_000_000,
    tileset: {
      ion: { assetId: 96188 }, // Cesium OSM Buildings
      groundHeight: 52, // ≈ EGM96 geoid 45.5 m + ~7 m terrain at Westminster; tune with ?ground=
      hideBasemapBuildings: true,
      attribution: "Buildings: Cesium OSM Buildings, © OpenStreetMap contributors",
      errorTarget: 12,
    },
  },
  hongkong: {
    id: "hongkong",
    driveOnLeft: true,
    terrain: true, // Central → Mid-Levels → the Peak: 0–523 m on the road network
    name: "Hong Kong (Central)",
    origin: { longitude: 114.1594, latitude: 22.2816 }, // Statue Square
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    view: {
      zoom: 14.5,
      pitch: 60,
      bearing: -35,
      // Connaught Road Central (trunk road) rather than the square itself
      center: { longitude: 114.1583, latitude: 22.2838 },
    },
    trafficAreaMetres: 8000,
    maxVehicles: 100_000,
    defaultVehicles: 100_000,
    tileset: {
      ion: { assetId: 96188 }, // Cesium OSM Buildings
      groundHeight: 8, // ≈ EGM96 geoid −2 m + terrain at Central; sampled tile bases sat 5 m high at 3
      hideBasemapBuildings: true,
      attribution: "Buildings: Cesium OSM Buildings, © OpenStreetMap contributors",
      errorTarget: 12,
    },
  },
  newyork: {
    id: "newyork",
    terrain: true,
    driveOnLeft: false,
    name: "New York (Midtown Manhattan)",
    origin: { longitude: -73.9855, latitude: 40.758 },
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    view: { zoom: 14.5, pitch: 60, bearing: 29 },
    trafficAreaMetres: 8000,
    maxVehicles: 100_000,
    defaultVehicles: 100_000,
    tileset: {
      ion: { assetId: 96188 }, // Cesium OSM Buildings
      groundHeight: -18, // ≈ EGM96 geoid −32.5 m + ~15 m terrain in Midtown; tune with ?ground=
      hideBasemapBuildings: true,
      attribution: "Buildings: Cesium OSM Buildings, © OpenStreetMap contributors",
      errorTarget: 12,
    },
  },
};

export const DEFAULT_CITY_ID = "london";
export const DEFAULT_CITY = CITIES[DEFAULT_CITY_ID] as CityConfig;

export function cityById(id: string | null | undefined): CityConfig {
  return (id ? CITIES[id] : undefined) ?? DEFAULT_CITY;
}
