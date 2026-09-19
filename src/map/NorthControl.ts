/**
 * MapLibre control: a north arrow that rotates with the map's bearing. Clicking it eases the bearing back to north while keeping the pitch, centre and
 * zoom. Replaces the small built-in compass of NavigationControl.
 */

import type { IControl, Map as MapLibreMap } from "maplibre-gl";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"/>
  <path d="M12 2.5 15.5 12H8.5Z" fill="#d93025" stroke="#d93025" stroke-width="1"/>
  <path d="M12 21.5 8.5 12h7Z" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <text x="12" y="6.2" text-anchor="middle" font-size="5" font-family="system-ui, sans-serif" font-weight="700" fill="#fff">N</text>
</svg>`;

export class NorthControl implements IControl {
  private map: MapLibreMap | null = null;
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private icon: HTMLSpanElement | null = null;

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "north-ctrl";
    button.title = "Point north (keeps the tilt)";
    button.setAttribute("aria-label", button.title);
    const icon = document.createElement("span");
    icon.className = "north-ctrl-icon";
    icon.innerHTML = ICON;
    button.appendChild(icon);
    button.addEventListener("click", () => {
      this.map?.easeTo({ bearing: 0, duration: 600 });
    });
    container.appendChild(button);
    this.container = container;
    this.button = button;
    this.icon = icon;
    map.on("rotate", this.refresh);
    this.refresh();
    return container;
  }

  onRemove(): void {
    this.map?.off("rotate", this.refresh);
    this.container?.remove();
    this.map = null;
    this.container = null;
    this.button = null;
    this.icon = null;
  }

  private readonly refresh = (): void => {
    if (!this.map || !this.icon || !this.button) return;
    const bearing = this.map.getBearing();
    // the arrow points where north is on screen
    this.icon.style.transform = `rotate(${-bearing}deg)`;
    this.button.classList.toggle("active", Math.abs(bearing) < 0.5);
  };
}
