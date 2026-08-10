// Satellite basemap tiles — shared by the 2D planner (Leaflet) and the 3D view
// (stitched into a ground texture).
//
// Esri World Imagery is the default: no key, CORS-enabled (so we can stitch it
// into a canvas without tainting it), and its sub-metre coverage of Indian
// industrial belts is good. Google's own imagery needs a paid Maps key, which
// most SEPL installs won't have configured.

export const BASEMAPS = {
  esri: {
    label: 'Esri satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxZoom: 21,
  },
  esriLabels: {
    label: 'Esri satellite + labels',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri',
    maxZoom: 21,
  },
  osm: {
    label: 'Street map',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
};

const TILE = 256;
const tileUrl = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// ── Web Mercator ──
export const lngToTileX = (lng, z) => ((lng + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
/** Ground resolution in metres per pixel at a given latitude and zoom. */
export const metresPerPixel = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/**
 * Stitch satellite tiles into a square canvas centred on (lat,lng) covering
 * ±halfSpan metres — the ground texture under the 3D model.
 *
 * Resolves to null (never throws) if the tiles can't be fetched or the browser
 * blocks the cross-origin read: the scene then falls back to a plain ground
 * colour, which costs looks but nothing functional.
 */
export async function fetchGroundTexture(lat, lng, halfSpan = 120, { maxPx = 2048, template = BASEMAPS.esri.url, maxNativeZoom = 19 } = {}) {
  try {
    // Pick the deepest zoom that still fits the span inside maxPx. Never go
    // past the layer's max *native* zoom: Leaflet upscales beyond it, but a
    // direct tile fetch just gets back a "Map data not yet available" placard,
    // which would end up painted across the 3D ground.
    let z = maxNativeZoom;
    while (z > 14 && (halfSpan * 2) / metresPerPixel(lat, z) > maxPx) z--;

    const mpp = metresPerPixel(lat, z);
    const cx = lngToTileX(lng, z), cy = latToTileY(lat, z);
    const halfPx = halfSpan / mpp;
    const x0 = Math.floor(cx - halfPx / TILE), x1 = Math.floor(cx + halfPx / TILE);
    const y0 = Math.floor(cy - halfPx / TILE), y1 = Math.floor(cy + halfPx / TILE);

    const size = Math.ceil(halfPx * 2);
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#243040';
    ctx.fillRect(0, 0, size, size);

    // Where the canvas origin sits in tile-pixel space.
    const originPx = { x: (cx - halfPx / TILE) * TILE, y: (cy - halfPx / TILE) * TILE };

    const loads = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        loads.push(new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            ctx.drawImage(img, tx * TILE - originPx.x, ty * TILE - originPx.y, TILE, TILE);
            resolve(true);
          };
          img.onerror = () => resolve(false);
          img.src = tileUrl(template, z, tx, ty);
        }));
      }
    }
    const ok = await Promise.all(loads);
    if (!ok.some(Boolean)) return null;

    // Touch the pixels once: if the canvas is tainted this throws here, where we
    // can still fall back, rather than deep inside the WebGL texture upload.
    ctx.getImageData(0, 0, 1, 1);

    return { canvas, halfSpan, zoom: z, metresPerPixel: mpp, tilesLoaded: ok.filter(Boolean).length };
  } catch {
    return null;
  }
}
