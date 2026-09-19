/**
 * MapLibre control: one button that eases the camera to a vertical, north-up view
 * (pitch 0, bearing 0) while keeping the centre and zoom. Clicking it again when the
 * view is already straight down restores the previous pitch and bearing.
 */

import type { IControl, Map as MapLibreMap } from "maplibre-gl";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="4" y="4" width="12" height="12" rx="1.5"/>
  <path d="M10 1.5v5M7.8 4.3 10 6.5l2.2-2.2"/>
  <circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none"/>
</svg>`;

export class TopDownControl implements IControl {
  private map: MapLibreMap | null = null;
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private previous: { pitch: number; bearing: number } | null = null;

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topdown-ctrl";
    button.title = "Look straight down (click again to restore the tilt)";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = ICON;
    button.addEventListener("click", () => {
      this.toggle();
    });
    container.appendChild(button);
    this.container = container;
    this.button = button;
    map.on("pitch", this.refresh);
    this.refresh();
    return container;
  }

  onRemove(): void {
    this.map?.off("pitch", this.refresh);
    this.container?.remove();
    this.map = null;
    this.container = null;
    this.button = null;
  }

  private readonly refresh = (): void => {
    if (!this.map || !this.button) return;
    this.button.classList.toggle("active", this.map.getPitch() < 0.5);
  };

  private toggle(): void {
    const map = this.map;
    if (!map) return;
    if (map.getPitch() < 0.5 && this.previous) {
      map.easeTo({ pitch: this.previous.pitch, bearing: this.previous.bearing, duration: 600 });
      this.previous = null;
      return;
    }
    this.previous = { pitch: map.getPitch(), bearing: map.getBearing() };
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  }
}
