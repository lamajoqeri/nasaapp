// The paper's reference list. Numbers follow this order. cite('key') -> "[n]" link. Owner: text.ts agent (fills in
// full, verified citations); everyone may cite these keys. Unknown keys render "[?]" and warn in the console.
export interface Ref { key: string; text: string; url?: string }

export const REFS: Ref[] = [
  { key: 'mazarico2011', text: 'Mazarico et al. 2011. Illumination conditions of the lunar polar regions using LOLA topography.', url: 'https://pgda.gsfc.nasa.gov/products/69' },
  { key: 'barker2023', text: 'Barker et al. 2023. LOLA south pole 20 m and 80 m elevation models with error maps (PGDA product 90).', url: 'https://pgda.gsfc.nasa.gov/products/90' },
  { key: 'barker2021', text: 'Barker et al. 2021. LOLA 5 m site models and Monte Carlo realisations (PGDA product 78).', url: 'https://pgda.gsfc.nasa.gov/products/78' },
  { key: 'ldem16', text: 'LOLA global elevation model LDEM_16. NASA PDS Geosciences Node.', url: 'https://pds-geosciences.wustl.edu/missions/lro/lola.htm' },
  { key: 'de440', text: 'Park et al. 2021. The JPL planetary and lunar ephemerides DE440 and DE441.', url: 'https://naif.jpl.nasa.gov/naif/data.html' },
  { key: 'spice', text: 'Acton 1996. Ancillary data services of NASA\'s Navigation and Ancillary Information Facility (SPICE).', url: 'https://naif.jpl.nasa.gov/' },
  { key: 'horizons', text: 'JPL Horizons on-line solar system data and ephemeris computation service. NASA JPL SSD.', url: 'https://ssd.jpl.nasa.gov/horizons/' },
  { key: 'lroc', text: 'LROC Narrow Angle Camera DTM orthoimages. NASA/GSFC/Arizona State University, LROC PDS archive.', url: 'https://data.lroc.im-ldi.com/' },
  { key: 'derosa2012', text: 'De Rosa et al. 2012. Characterisation of potential landing sites for the European Space Agency\'s Lunar Lander project.' },
  { key: 'glaser2014', text: 'Gläser et al. 2014. Illumination conditions at the lunar south pole using high resolution Digital Terrain Models from LOLA.' },
  { key: 'dsn', text: 'NASA Deep Space Network station locations (Goldstone, Madrid, Canberra).', url: 'https://www.nasa.gov/communicating-with-missions/dsn/' },
];

export function cite(...keys: string[]): string {
  const parts = keys.map((k) => {
    const i = REFS.findIndex((r) => r.key === k);
    if (i < 0) { console.warn(`report: unknown reference "${k}"`); return '?'; }
    return `<a href="#ref-${k}">${i + 1}</a>`;
  });
  return `<span class="cite">[${parts.join(', ')}]</span>`;
}
