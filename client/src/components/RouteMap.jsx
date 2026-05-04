// Embedded movement-trail map. Pure Leaflet (no react-leaflet) so it
// stays compatible with React 19 without dragging in extra peer-dep
// pinning. Used on Location Tracking → Timeline to draw the day's GPS
// pings as a red polyline with start (green) and end (red) markers.
//
// Tiles come from OpenStreetMap (free, no API key). Office geofences are
// drawn as faint blue circles when passed via props.

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Leaflet's default marker icons reference assets under /node_modules
// which Vite doesn't bundle by default — point them at the unpkg CDN
// so the markers actually show up. One-shot fix per app load.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const colored = (color) =>
  L.divIcon({
    className: '',
    html: `<div style="background:${color};width:14px;height:14px;border:2px solid white;border-radius:50%;box-shadow:0 0 0 2px ${color};"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

export default function RouteMap({ pings = [], geofences = [], height = 360 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
    if (pings.length === 0) return;

    // Initialise map centred on the first ping
    const map = L.map(containerRef.current, { zoomControl: true });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);

    // Office geofences (faint blue circles)
    for (const g of geofences) {
      if (g.latitude == null || g.longitude == null) continue;
      L.circle([g.latitude, g.longitude], {
        radius: g.radius_meters || 200,
        color: '#3b82f6',
        fillColor: '#3b82f6',
        fillOpacity: 0.08,
        weight: 1,
      })
        .bindTooltip(g.site_name || 'Office', { permanent: false, direction: 'top' })
        .addTo(map);
    }

    // Day's route as red polyline
    const latlngs = pings.map((p) => [p.latitude, p.longitude]);
    const route = L.polyline(latlngs, {
      color: '#dc2626',
      weight: 4,
      opacity: 0.85,
      smoothFactor: 1.2,
    }).addTo(map);

    // Direction arrows along the line — manual midpoint markers every Nth ping
    const arrowEvery = Math.max(1, Math.floor(pings.length / 10));
    pings.forEach((p, i) => {
      if (i === 0 || i === pings.length - 1) return;
      if (i % arrowEvery !== 0) return;
      L.circleMarker([p.latitude, p.longitude], {
        radius: 3,
        color: '#dc2626',
        fillColor: '#dc2626',
        fillOpacity: 1,
        weight: 0,
      })
        .bindTooltip(
          `${p.time_str || p.time || ''}<br>${p.address || `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`}`,
          { direction: 'top' }
        )
        .addTo(map);
    });

    // Start (green) and End (red) markers
    const start = pings[0];
    const end = pings[pings.length - 1];
    L.marker([start.latitude, start.longitude], { icon: colored('#10b981') })
      .bindPopup(`<b>Start</b><br>${start.time_str || start.time || ''}<br>${start.address || ''}`)
      .addTo(map);
    if (pings.length > 1) {
      L.marker([end.latitude, end.longitude], { icon: colored('#dc2626') })
        .bindPopup(`<b>Last seen</b><br>${end.time_str || end.time || ''}<br>${end.address || ''}`)
        .addTo(map);
    }

    // Fit map to the polyline + geofences
    try {
      const group = L.featureGroup([route, ...geofences.filter(g => g.latitude != null).map(g =>
        L.circle([g.latitude, g.longitude], { radius: g.radius_meters || 200 })
      )]);
      map.fitBounds(group.getBounds(), { padding: [24, 24] });
    } catch {
      map.setView([start.latitude, start.longitude], 14);
    }

    // Cleanup when component unmounts or pings change
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [pings, geofences]);

  if (!pings || pings.length === 0) {
    return (
      <div className="card p-6 text-center text-gray-400 text-sm">
        No GPS pings to plot on the map yet.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-gray-200 overflow-hidden"
      style={{ height: `${height}px`, width: '100%' }}
    />
  );
}
