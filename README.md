# Palette Pick 🖍️

Trains colour reading: each scene is painted from a known weighted
palette, and you pick the 3 chips that carry it — dominant, secondary,
accent. Three scenes per round, from bold flats to subtle low-chroma.

Scoring: picks are greedy-matched to the true clusters and scored by
ΔE in Lab (100 at ΔE 0, 0 at ΔE 38+), weighted 45/33/22 by cluster
importance. Three near-identical picks are docked ×0.72; matching the
accent within ΔE 20 earns +6. Round score = mean of the three scenes.

Run: any static server — `python3 -m http.server 8080` — zero build, zero deps.

Part of [Art Daily](https://artdaily.sadeali.com/) · more at [sadeali.com](https://sadeali.com/).
