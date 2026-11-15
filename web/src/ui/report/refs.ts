// The paper's reference list. Numbers follow this order (order of first citation: introduction, data, methods).
// cite('key') -> "[n]" link. Everyone may cite these keys. Unknown keys render "[?]" and warn in the console.
export interface Ref { key: string; text: string; url?: string }

export const REFS: Ref[] = [
  { key: 'artemis2024', text: 'NASA (2024). NASA provides update on Artemis III Moon landing regions. News release, 28 October 2024.', url: 'https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/' },
  { key: 'smith2010', text: 'Smith, D. E., et al. (2010). The Lunar Orbiter Laser Altimeter investigation on the Lunar Reconnaissance Orbiter mission. Space Science Reviews 150, 209–241. doi:10.1007/s11214-009-9512-y', url: 'https://doi.org/10.1007/s11214-009-9512-y' },
  { key: 'mazarico2011', text: 'Mazarico, E., Neumann, G. A., Smith, D. E., Zuber, M. T., Torrence, M. H. (2011). Illumination conditions of the lunar polar regions using LOLA topography. Icarus 211, 1066–1081. doi:10.1016/j.icarus.2010.10.030. Data: NASA GSFC Planetary Geodesy Data Archive (PGDA), product 69, Lunar Polar Illumination.', url: 'https://pgda.gsfc.nasa.gov/products/69' },
  { key: 'derosa2012', text: 'De Rosa, D., et al. (2012). Characterisation of potential landing sites for the European Space Agency\'s Lunar Lander project. Planetary and Space Science 74, 224–246. doi:10.1016/j.pss.2012.08.002', url: 'https://doi.org/10.1016/j.pss.2012.08.002' },
  { key: 'glaser2014', text: 'Gläser, P., Scholten, F., De Rosa, D., Marco Figuera, R., Oberst, J., Mazarico, E., Neumann, G. A., Robinson, M. S. (2014). Illumination conditions at the lunar south pole using high resolution Digital Terrain Models from LOLA. Icarus 243, 78–90. doi:10.1016/j.icarus.2014.08.013', url: 'https://doi.org/10.1016/j.icarus.2014.08.013' },
  { key: 'barker2023', text: 'Barker, M. K., et al. (2023). A new view of the lunar south pole from the Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. Data: NASA GSFC PGDA, product 90 (doi:10.60903/gsfcpgda-lola-spole).', url: 'https://pgda.gsfc.nasa.gov/products/90' },
  { key: 'ldem16', text: 'LRO Lunar Orbiter Laser Altimeter Gridded Data Record, product LDEM_16 (data set LRO-L-LOLA-4-GDR-V1.0). NASA Planetary Data System, Geosciences Node.', url: 'https://pds-geosciences.wustl.edu/missions/lro/lola.htm' },
  { key: 'de440', text: 'Park, R. S., Folkner, W. M., Williams, J. G., Boggs, D. H. (2021). The JPL planetary and lunar ephemerides DE440 and DE441. The Astronomical Journal 161, 105. doi:10.3847/1538-3881/abd414', url: 'https://doi.org/10.3847/1538-3881/abd414' },
  { key: 'spice', text: 'Acton, C. H. (1996). Ancillary data services of NASA\'s Navigation and Ancillary Information Facility. Planetary and Space Science 44, 65–70. doi:10.1016/0032-0633(95)00107-7. Kernels: NASA JPL NAIF generic kernels.', url: 'https://naif.jpl.nasa.gov/naif/data.html' },
  { key: 'dsn', text: 'NASA Deep Space Network. Antenna complexes at Goldstone (California, USA), Madrid (Spain) and Canberra (Australia).', url: 'https://www.nasa.gov/communicating-with-missions/dsn/' },
  { key: 'barker2021', text: 'Barker, M. K., Mazarico, E., Neumann, G. A., Smith, D. E., Zuber, M. T., Head, J. W. (2021). Improved LOLA elevation maps for south pole landing sites: error estimates and their impact on illumination conditions. Planetary and Space Science 203, 105119. doi:10.1016/j.pss.2020.105119. Data: NASA GSFC PGDA, product 78.', url: 'https://pgda.gsfc.nasa.gov/products/78' },
  { key: 'lroc', text: 'Robinson, M. S., et al. (2010). Lunar Reconnaissance Orbiter Camera (LROC) instrument overview. Space Science Reviews 150, 81–124. doi:10.1007/s11214-010-9634-2. Data: LROC NAC DTM orthoimages, NASA/GSFC/Arizona State University, LROC PDS archive.', url: 'https://data.lroc.im-ldi.com/' },
  { key: 'horizons', text: 'Giorgini, J. D., et al. (1996). JPL\'s on-line solar system data service. Bulletin of the American Astronomical Society 28, 1158. Service: JPL Horizons, NASA JPL Solar System Dynamics.', url: 'https://ssd.jpl.nasa.gov/horizons/' },
];

export function cite(...keys: string[]): string {
  const parts = keys.map((k) => {
    const i = REFS.findIndex((r) => r.key === k);
    if (i < 0) { console.warn(`report: unknown reference "${k}"`); return '?'; }
    return `<a href="#ref-${k}" data-ref="ref-${k}">${i + 1}</a>`;
  });
  return `<span class="cite">[${parts.join(', ')}]</span>`;
}

// The app reloads on hashchange (pasted share links), so following a plain "#ref-x" link would throw the report
// away. Scroll instead; the href stays for printed PDFs.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[data-ref]');
    if (!a) return;
    e.preventDefault();
    document.getElementById(a.getAttribute('data-ref')!)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
