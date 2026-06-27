import { useMemo } from "react";
import { geoMercator, geoPath, geoCircle } from "d3-geo";
import { feature } from "topojson-client";
import worldTopoRaw from "world-atlas/countries-110m.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const worldTopo = worldTopoRaw as any;

// Computed once at module load - the JSON is bundled at build time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const land = feature(worldTopo, worldTopo.objects.land) as any;

const W = 800;
const H = 400;

function getSubsolarPoint(): [number, number] {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  let lon = (12 - utcH) * 15;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  const doy = Math.floor((+now - +new Date(now.getFullYear(), 0, 0)) / 86400000);
  const lat = -23.45 * Math.cos((2 * Math.PI / 365) * (doy + 10));
  return [lon, lat];
}

interface TimezoneMapProps {
  lon: number;
  lat: number;
}

export function TimezoneMap({ lon, lat }: TimezoneMapProps) {
  const { landPath, nightPath, mx, my } = useMemo(() => {
    // Center the projection on the timezone location, biased slightly north
    // so southern-hemisphere cities don't push land out of frame.
    const centerLat = Math.max(-20, Math.min(30, lat));
    const proj = geoMercator()
      .center([lon, centerLat])
      .translate([W * 0.78, H * 0.65])
      .scale(135);
    const pg = geoPath(proj);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pg_ = pg as (d: any) => string | null;

    const landPath = pg_(land) ?? "";

    const [sunLon, sunLat] = getSubsolarPoint();
    const antiLon = sunLon >= 0 ? sunLon - 180 : sunLon + 180;
    const antiLat = -sunLat;
    const nightPath = pg_(geoCircle().center([antiLon, antiLat]).radius(90)()) ?? "";

    const mp = proj([lon, lat]);
    const [mx, my] = mp ?? [W / 2, H / 2];

    return { landPath, nightPath, mx, my };
  }, [lon, lat]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {/* Ocean - dark base */}
      <rect width={W} height={H} fill="#171717" />

      {/* Land - bright in daylight */}
      <path d={landPath} fill="#737373" />

      {/* Night overlay - darkens everything on the night side */}
      <path d={nightPath} fill="rgba(8,8,8,0.82)" />


      {/* Timezone marker */}
      <style>{`@keyframes tz-pulse{0%{r:4;opacity:0;stroke-width:1}40%{opacity:1;stroke-width:2}100%{r:32;opacity:0;stroke-width:.5}}@keyframes tz-core{0%,100%{r:3.5}50%{r:5}}`}</style>
      <circle cx={mx} cy={my} r={4} fill="none" stroke="white" style={{ animation: "tz-pulse 2.6s ease-out infinite" }} />
      <circle cx={mx} cy={my} r={4} fill="none" stroke="white" style={{ animation: "tz-pulse 2.6s ease-out infinite", animationDelay: "1.3s" }} />
      <circle cx={mx} cy={my} r={3.5} fill="white" style={{ animation: "tz-core 2.6s ease-in-out infinite" }} />
    </svg>
  );
}
