#!/bin/sh
# Fetch raw inputs into data/ (gitignored). Resumable: rerun if a server stalls.
set -u
cd "$(dirname "$0")/.." && mkdir -p data/kernels && cd data

get() { # get <dir> <url>
  curl -fL -C - --retry 5 --retry-delay 5 -o "$1/$(basename "$2")" "$2" || echo "FAILED: $2" >&2
}

NAIF=https://naif.jpl.nasa.gov/pub/naif/generic_kernels
get kernels $NAIF/lsk/naif0012.tls
get kernels $NAIF/pck/pck00011.tpc
get kernels $NAIF/fk/satellites/moon_de440_250416.tf
get kernels $NAIF/pck/moon_pa_de440_200625.bpc
get kernels $NAIF/spk/planets/de440s.bsp

# Global DEM, float32 5760x2880, km above 1737.4 km sphere
get . https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/float_img/ldem_16_float.img
# South pole 80S-90S at 80 m (Barker 2023) -> sp_240m tier
get . https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF
# Validation targets (Mazarico 2011): DN * 0.00004 = fraction of time visible
get . https://pgda.gsfc.nasa.gov/data/MoonIllumination/AVGVISIB_85S_060M_201608.TIF
get . https://pgda.gsfc.nasa.gov/data/MoonIllumination/AVGVISIB_85S_060M_201608_EARTH.TIF
# 20 m tiles are read by window from LDEM_80S_20MPP_ADJ.TIF over /vsicurl/ in prep/dem.py (no 2.7 GB download)
ls -lh . kernels
