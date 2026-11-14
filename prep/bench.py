"""Reality check: predicted shadows vs real LRO NAC orthoimages -> web/public/data/bench/.
Run: .venv/bin/python prep/bench.py            (about 40 min; SHACKRDGE02 only: add --quick)

Two groups of images, all polar stereographic orthoimages from LROC NAC DTM products:

A. SHACKRDGE02 (2 images, 3.5 m). Each file is named after its source image, so the capture time is known.
   These give the headline numbers. Weakness: DN 0 means both "no data" and deep shadow. We evaluate inside
   the convex hull of non-zero pixels minus the straight-edged footprint notches on the top and left edges
   (hand rule in footprint()), and count the remaining zeros as shadow. The large dark area on the southern
   edge is therefore assumed to be shadow.

B. ESALL_CR1 (7 images) and ESALL_SR12 (6 images), 2 m. Footprints are unambiguous (shadows are dim but
   non-zero), and the images span three dates with Sun directions ~140 and ~215 deg apart. Weakness: the
   labels do not say which source image each orthoimage came from. Each product lists 7-8 source observations;
   we pick, for every model separately, the candidate time that scores best on a coarse grid. Candidates from
   different dates differ by >100 deg of Sun azimuth, so the date is identified unambiguously; candidates on
   the same date differ by ~1-2 deg, which is where the best-of selection can flatter a score slightly.

Photo shadow = block-mean DN < 5% of full scale (De Rosa et al. 2012). Model shadow = visible Sun fraction < 0.5.
All images are from 22 Sep - 11 Oct 2010 (southern spring), so there is no seasonal spread.
"""
import json
import sys

import numpy as np
import rasterio
import spiceypy as sp
from PIL import Image
from scipy import ndimage
from skimage.morphology import convex_hull_image
from skimage.registration import phase_cross_correlation

import ephem
from geom import DATA, Dem, R, SUN_R, enu, schedule, sp_inv, unit

ROOT = DATA.parent.parent.parent
OUT = DATA / "bench"
TIMES = {  # mid-exposure UTC of the source observations, from each image's LROC record
    "M139797542": "2010-09-22T12:24:53", "M139811097": "2010-09-22T16:10:48", "M139817894": "2010-09-22T18:04:04",
    "M139872173": "2010-09-23T09:08:43", "M139878946": "2010-09-23T11:01:37",
    "M140869717": "2010-10-04T22:14:26", "M140876512": "2010-10-05T00:07:41", "M140890072": "2010-10-05T03:53:41",
    "M140903652": "2010-10-05T07:40:00", "M140917211": "2010-10-05T11:25:59",
    "M141378588": "2010-10-10T19:35:42", "M141385360": "2010-10-10T21:28:34", "M141412504": "2010-10-11T05:00:57",
    "M141432879": "2010-10-11T10:40:31", "M141439653": "2010-10-11T12:33:26"}
SOURCES = {
    "ESALL_CR1": ["M139797542", "M139811097", "M139817894", "M140869717", "M140876512", "M141412504", "M141432879", "M141439653"],
    "ESALL_SR12": ["M139872173", "M139878946", "M140890072", "M140903652", "M140917211", "M141378588", "M141385360"]}
IMAGES = [("SHACKRDGE02_M139797542_350CM", ["M139797542"]), ("SHACKRDGE02_M139811097_350CM", ["M139811097"])] + \
         [(f"ESALL_CR1_NACORT{i:02d}_2M", SOURCES["ESALL_CR1"]) for i in range(1, 8)] + \
         [(f"ESALL_SR12_NACORT{i:02d}_2M", SOURCES["ESALL_SR12"]) for i in range(1, 7)]
MODELS = ("ours", "dem240", "slope_only")


def block(a, k):
    r, c = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:r, :c].reshape(r // k, k, c // k, k).mean((1, 3))


def footprint(raw, k):
    """SHACKRDGE02 only, see module docstring."""
    hull = block(convex_hull_image(raw > 0).astype(float), k) > 0.99
    valid = block((raw > 0).astype(float), k) > 0.5
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


class Scene:
    def __init__(self, raw, region_fn, b, px, k, dems):
        self.region, self.photo = region_fn(raw, k), block(raw.astype(float), k)
        self.truth = self.photo < 0.05 * 255
        ny, nx = self.photo.shape
        x, y = np.meshgrid(b.left + (np.arange(nx) + 0.5) * px * k, b.top - (np.arange(ny) + 0.5) * px * k)
        self.lat, self.lon = sp_inv(x, y)
        self.P = {m: (R + d.sample(self.lat, self.lon))[..., None] * unit(self.lat, self.lon) for m, d in dems.items()}
        self.dems, self.d = dems, schedule()

    def sun(self, iid):
        v = ephem.vectors(sp.str2et(TIMES[iid]))[0, :3] * 1000.0
        return v / np.linalg.norm(v), np.degrees(np.arcsin(SUN_R / np.linalg.norm(v)))

    def frac(self, model, iid):
        s, sun_r = self.sun(iid)
        dem = "dem240" if model == "dem240" else "ours"
        d = self.d[self.d <= 60] if model == "slope_only" else self.d
        return sun_fraction(self.dems[dem], self.P[dem].reshape(-1, 3), s, sun_r, d).reshape(self.photo.shape)

    def iou(self, model, iid):
        return scores(self.frac(model, iid) < 0.5, self.truth, self.region)["iou"]


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    ephem.load()
    tiles = {t["id"]: t for t in Dem().tiles}
    ours, coarse = Dem(), Dem()
    ours.tiles = [tiles[k] for k in ("shackleton_20m", "sp_240m", "global_8ppd")]
    coarse.tiles = [tiles[k] for k in ("sp_240m", "global_8ppd")]
    dems = {"ours": ours, "dem240": coarse}
    index = []
    for name, cands in IMAGES[:2] if "--quick" in sys.argv else IMAGES:
        with rasterio.open(ROOT / f"data/nac/NAC_DTM_{name}.TIF") as src:
            raw, b, px = src.read(1), src.bounds, src.res[0]
        known = len(cands) == 1
        k = int(round(21 / px))
        region_fn = footprint if known else (lambda r, kk: block((r > 0).astype(float), kk) > 0.99)
        sc = Scene(raw, region_fn, b, px, k, dems)
        if sc.region.mean() < 0.02:
            print(name, "skipped: almost no footprint")
            continue
        pick, table = {m: cands[0] for m in MODELS}, None
        if not known:  # best candidate time per model, on a 3x coarser grid
            lo = Scene(raw, region_fn, b, px, k * 3, dems)
            table = {m: {c: lo.iou(m, c) for c in cands} for m in MODELS}
            pick = {m: max(table[m], key=table[m].get) for m in MODELS}
        frac = {m: sc.frac(m, pick[m]) for m in MODELS}
        frac["flat"] = np.ones(sc.photo.shape)
        shift, _, _ = phase_cross_correlation(sc.truth & sc.region, (frac["ours"] < 0.5) & sc.region, upsample_factor=4)
        res = {"raw": {}, "registered": {}}
        for m, f in frac.items():
            pred = f < 0.5
            res["raw"][m] = scores(pred, sc.truth, sc.region)
            res["registered"][m] = scores(ndimage.shift(pred.astype(float), shift, order=0, mode="nearest") > 0.5, sc.truth, sc.region)

        s, _ = sc.sun(pick["ours"])
        c = (sc.photo.shape[0] // 2, sc.photo.shape[1] // 2)
        east, north, up = enu(sc.lat[c], sc.lon[c])
        entry = {"id": name, "group": "known_time" if known else "matched_time", "source_image": pick["ours"],
                 "utc": TIMES[pick["ours"]] + "Z", "sun_az": round(float(np.degrees(np.arctan2(s @ east, s @ north)) % 360), 2),
                 "sun_el": round(float(np.degrees(np.arcsin(s @ up))), 3), "photo": f"{name}_photo.png", "model": f"{name}_model.png",
                 "bounds": [b.left, b.bottom, b.right, b.top], "shadow_fraction_photo": round(float(sc.truth[sc.region].mean()), 3),
                 "registration_shift_m": [round(float(v * px * k), 1) for v in shift],  # (rows/south+, cols/east+)
                 "scores": res["registered"], "scores_unregistered": res["raw"]}
        if table:
            entry["time_matching"] = {"picked": pick, "coarse_iou_ours": table["ours"]}
        index.append(entry)
        print(name, entry["utc"], "sun az", entry["sun_az"], "el", entry["sun_el"], "shift", entry["registration_shift_m"],
              "| " + "  ".join(f"{m} {res['registered'][m]['iou']:.2f}" for m in frac), flush=True)

        n = np.cross(np.gradient(sc.P["ours"], axis=1), np.gradient(sc.P["ours"], axis=0))
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        n *= np.sign((n * sc.P["ours"]).sum(-1, keepdims=True))
        img = frac["ours"] * np.clip(n @ s, 0, None)
        lit = sc.region & (img > 0)
        foot = block((raw > 0).astype(float), k) > 0.5 if not known else block(convex_hull_image(raw > 0).astype(float), k) > 0.5
        if lit.any():
            img = img / np.percentile(img[lit], 99) * np.percentile(sc.photo[sc.region], 99)
        kd = max(1, int(round(7 / px)))  # ~7 m display pixels
        Image.fromarray(block(raw.astype(float), kd).astype(np.uint8)).save(OUT / f"{name}_photo.png", optimize=True)
        Image.fromarray((np.clip(img, 0, 255) * foot).astype(np.uint8)).resize(
            (raw.shape[1] // kd, raw.shape[0] // kd), Image.BILINEAR).save(OUT / f"{name}_model.png", optimize=True)

    def mean(group, m, key="iou"):
        v = [e["scores"][m][key] for e in index if e["group"] == group]
        return round(float(np.mean(v)), 3) if v else None

    (OUT / "index.json").write_text(json.dumps({
        "source": "LROC NAC DTM orthoimages (SHACKRDGE02 3.5 m; ESALL_CR1, ESALL_SR12 2 m), LRO/LROC, NASA/GSFC/ASU",
        "method": __doc__.split("\n\n", 1)[1].strip(),
        "baselines": {"flat": "smooth sphere, no terrain", "slope_only": "local slope within 60 m, no cast shadows",
                      "dem240": "240 m DEM only", "ours": "20 m DEM + 240 m far field out to 300 km"},
        "summary": {g: {"n": sum(e["group"] == g for e in index),
                        **{m: {"iou": mean(g, m), "accuracy": mean(g, m, "accuracy")} for m in ("flat", "dem240", "slope_only", "ours")}}
                    for g in ("known_time", "matched_time")},
        "images": index}, indent=1))
    print(json.dumps(json.loads((OUT / "index.json").read_text())["summary"], indent=1))
