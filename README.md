# Palette Pick 🖍️

Trains colour reading: each scene is painted from a known weighted
palette, and you pick the 3 chips that carry it — dominant, secondary,
accent, in any order (retap a chip or its slot to clear it). Three
scenes per round, from bold flats to subtle low-chroma. After you lock
in, the chip grid stays on screen with the three true chips ringed, and
the reveal butts each true colour against your pick, edge to edge; the
palette strip over the scene is lettered D / S / A / m by role.

Scoring: your three picks are assigned to the true clusters by the best
of all six assignments (never greedy, so a good trio is never
under-credited) and scored by ΔE in Lab (100 at ΔE 0, 0 at ΔE 38+),
weighted 45/33/22 by cluster importance. Three near-identical picks are
docked ×0.72; matching the accent within ΔE 20 earns +6. Round score =
mean of the three scenes. The exact cluster colours are always planted
in the grid (plus decoy off-tone chips, so irregularity hunting doesn't
pay), and cluster separation is enforced — 100 stays reachable.

Run: any static server — `python3 -m http.server 8080` — zero build, zero deps.

Part of [Art Daily](https://artdaily.sadeali.com/) · more at [sadeali.com](https://sadeali.com/).
