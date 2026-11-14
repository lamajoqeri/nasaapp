"""Reality check: predicted shadows vs real LRO NAC orthoimages -> web/public/data/bench/.
Run: .venv/bin/python prep/bench.py

Images: NAC_DTM_SHACKRDGE02 orthoimages (3.5 m, polar stereographic, single observation each).
Capture times are from each source image's LROC record, not the DTM label.

Caveats (also written to index.json):
- The orthoimage uses DN 0 for both "no data" and deep shadow. We evaluate inside the convex hull of
  non-zero pixels, minus the straight-edged footprint notches on the top and left edges (hand rule in
  footprint()), and treat remaining zeros as shadow. The large dark area along the southern edge is
  therefore assumed to be shadow: consistent with the ridge's shadow line, but an assumption.
- Photo shadow = block-mean DN < 5% of full scale (De Rosa et al. 2012 rule). Model shadow = visible Sun fraction < 0.5.
- Both images are from 22 Sep 2010, 3.8 h apart: one season, one Sun direction (2 deg apart).
"""
import json

import numpy as np
import rasterio
import spiceypy as sp
from PIL import Image
from scipy import ndimage
from skimage.morphology import convex_hull_image
from skimage.registration import phase_cross_correlation

import ephem
from geom import DATA, Dem, R, SUN_R, schedule, sp_inv, unit

ROOT = DATA.parent.parent.parent
OUT = DATA / "bench"
IMAGES = {"M139797542": "2010-09-22T12:24:53", "M139811097": "2010-09-22T16:10:48"}  # mid-exposure UTC
K = 6  # 3.5 m -> 21 m model grid


def block(a, k):
    r, c = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:r, :c].reshape(r // k, k, c // k, k).mean((1, 3))


def footprint(raw):
    """Evaluation region on the model grid. DN 0 means both 'no data' and deep shadow, so: start from the
    convex hull of non-zero pixels, then drop zero-valued areas wider than ~150 m that sit on the top or
    left edge (the stereo-pair footprint has notches there; they are straight-edged, not shadows).
    What remains of the zeros (small crater shadows, the big shadow along the south edge) counts as shadow."""
    hull = block(convex_hull_image(raw > 0).astype(float), K) > 0.99
    valid = block((raw > 0).astype(float), K) > 0.5
    gaps, n = ndimage.label(hull & ~ndimage.binary_closing(valid, iterations=7, border_value=1))
    ny, nx = hull.shape
    for i, (r, c) in enumerate(ndimage.center_of_mass(gaps > 0, gaps, range(1, n + 1)), 1):
        if r < 0.5 * ny or c < 0.12 * nx:
            hull[gaps == i] = False
    return hull


def sun_fraction(dem, P, s, sun_r, d):
    """Visible Sun fraction at surface points P (n,3) for Moon-fixed Sun unit vector s."""
    out = np.empty(len(P))
    for i in range(0, len(P), 4000):
        Q = P[i:i + 4000, None, :] + d[None, :, None] * s
        r = np.linalg.norm(Q, axis=-1)
        h = dem.sample(np.degrees(np.arcsin(Q[..., 2] / r)), np.degrees(np.arctan2(Q[..., 1], Q[..., 0])))
        x = np.clip(-np.degrees(np.arctan2(h - (r - R), d[None, :])).max(1) / sun_r, -1, 1)
        out[i:i + 4000] = 1 - (np.arccos(x) - x * np.sqrt(1 - x * x)) / np.pi
    return out


def scores(pred, truth, region):
    p, t = pred[region], truth[region]
    tp, fp, fn = (p & t).sum(), (p & ~t).sum(), (~p & t).sum()
    return {"iou": round(float(tp / max(tp + fp + fn, 1)), 3), "f1": round(float(2 * tp / max(2 * tp + fp + fn, 1)), 3),
            "accuracy": round(float((p == t).mean()), 3)}


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    ephem.load()
    full = Dem()
    tiles = {t["id"]: t for t in full.tiles}
    ours, coarse = Dem(), Dem()
    ours.tiles = [tiles[k] for k in ("shackleton_20m", "sp_240m", "global_8ppd")]
    coarse.tiles = [tiles[k] for k in ("sp_240m", "global_8ppd")]
    d = schedule()
    index = []
    for iid, utc in IMAGES.items():
        with rasterio.open(ROOT / f"data/nac/NAC_DTM_SHACKRDGE02_{iid}_350CM.TIF") as src:
            raw, b, px = src.read(1), src.bounds, src.res[0]
        region = footprint(raw)
        photo = block(raw.astype(float), K)
        truth = photo < 0.05 * 255
        ny, nx = photo.shape
        x, y = np.meshgrid(b.left + (np.arange(nx) + 0.5) * px * K, b.top - (np.arange(ny) + 0.5) * px * K)
        lat, lon = sp_inv(x, y)
        P = ((R + ours.sample(lat, lon))[..., None] * unit(lat, lon))
        v = ephem.vectors(sp.str2et(utc))[0, :3] * 1000.0
        s, sun_r = v / np.linalg.norm(v), np.degrees(np.arcsin(SUN_R / np.linalg.norm(v)))
        n = np.cross(np.gradient(P, axis=1), np.gradient(P, axis=0))
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        n *= np.sign((n * P).sum(-1, keepdims=True))
        cos_i = np.clip(n @ s, 0, None)

        flat = P.reshape(-1, 3)
        frac = {"ours": sun_fraction(ours, flat, s, sun_r, d).reshape(ny, nx),
                "dem240": sun_fraction(coarse, ((R + coarse.sample(lat, lon))[..., None] * unit(lat, lon)).reshape(-1, 3),
                                       s, sun_r, d).reshape(ny, nx),
                "slope_only": sun_fraction(ours, flat, s, sun_r, d[d <= 60]).reshape(ny, nx),
                "flat": np.ones((ny, nx))}
        shift, _, _ = phase_cross_correlation(truth & region, (frac["ours"] < 0.5) & region, upsample_factor=4)
        res = {"raw": {}, "registered": {}}
        for name, f in frac.items():
            pred = f < 0.5
            res["raw"][name] = scores(pred, truth, region)
            res["registered"][name] = scores(ndimage.shift(pred.astype(float), shift, order=0, mode="nearest") > 0.5, truth, region)
        c = (ny // 2, nx // 2)
        e_n = np.array([-np.sin(np.radians(lon[c])), np.cos(np.radians(lon[c])), 0.0]), None
        east = e_n[0]
        up = unit(lat[c], lon[c])
        north = np.cross(up, east)
        entry = {"id": iid, "utc": utc + "Z", "sun_az": round(float(np.degrees(np.arctan2(s @ east, s @ north)) % 360), 2),
                 "sun_el": round(float(np.degrees(np.arcsin(s @ up))), 3), "photo": f"{iid}_photo.png", "model": f"{iid}_model.png",
                 "bounds": [b.left, b.bottom, b.right, b.top], "shadow_fraction_photo": round(float(truth[region].mean()), 3),
                 "registration_shift_m": [round(float(v * px * K), 1) for v in shift],  # (rows/south+, cols/east+)
                 "scores": res["registered"], "scores_unregistered": res["raw"]}
        index.append(entry)
        print(iid, entry["sun_az"], entry["sun_el"], "shift m", entry["registration_shift_m"], "photo shadow", entry["shadow_fraction_photo"])
        for name in frac:
            print(f"  {name:10s} raw {res['raw'][name]}  registered {res['registered'][name]}")

        Image.fromarray(np.where(block(convex_hull_image(raw > 0).astype(float), 3) > 0.5, block(raw.astype(float), 3), 0)
                        .astype(np.uint8)).save(OUT / f"{iid}_photo.png")
        img = frac["ours"] * cos_i
        img = np.clip(img / np.percentile(img[region], 99) * np.percentile(photo[region], 99), 0, 255) * (block(convex_hull_image(raw > 0).astype(float), K) > 0.5)
        Image.fromarray(img.astype(np.uint8)).resize((raw.shape[1] // 3, raw.shape[0] // 3), Image.BILINEAR).save(OUT / f"{iid}_model.png")

    (OUT / "index.json").write_text(json.dumps({
        "source": "LROC NAC_DTM_SHACKRDGE02 orthoimages (3.5 m), LRO/LROC, NASA/GSFC/ASU",
        "method": "photo shadow = DN < 5% full scale; model shadow = visible Sun fraction < 0.5; 21 m grid; "
                  "evaluated inside the convex hull of non-zero pixels minus footprint notches on the top/left edges; remaining zeros count as shadow (assumption for the large southern shadow); "
                  "scores after one rigid shift from phase correlation with our model, applied to every model",
        "baselines": {"flat": "smooth sphere, no terrain", "slope_only": "local slope within 60 m, no cast shadows",
                      "dem240": "240 m DEM only", "ours": "20 m DEM + 240 m far field out to 300 km"},
        "images": index}, indent=1))
