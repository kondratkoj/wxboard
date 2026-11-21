// Designated mountainous areas, 14 CFR Part 95 Subpart B (§§ 95.13–95.21). Pure functions, shared by the page and tests.
//
// The coordinates marked "reg" are copied from the regulation text (eCFR, retrieved 2026-11-21), in degrees and minutes,
// so they can be checked line by line against the CFR. Where the regulation says "along the Canadian border",
// "along the Mexican border", "from the Pacific coastline" or "the State of Alaska", it gives no coordinates; those
// legs are drawn here with rough points (marked "approx") that only need to keep US airports on the right side and
// foreign airports out. Answers within a few miles of an approx leg can be wrong; answers near a "reg" line are
// flagged with their distance so the pilot can check.
(function (root) {
  // Degrees + minutes north / west → [lat, lon] with west negative.
  const dm = (latD, latM, lonD, lonM) => [latD + latM / 60, -(lonD + lonM / 60)];

  // ---- § 95.13 Eastern United States Mountainous Area ----
  const EAST_REG = [ // (a) from 45°00′N 74°15′W round to the point of beginning (reg)
    dm(45, 0, 74, 15), dm(44, 20, 75, 30), dm(43, 5, 75, 30), dm(42, 57, 77, 30), dm(42, 52, 78, 42), dm(42, 26, 79, 13),
    dm(42, 5, 80, 0), dm(40, 50, 80, 0), dm(40, 26, 79, 54), dm(38, 25, 81, 46), dm(36, 0, 86, 0), dm(33, 37, 86, 45),
    dm(32, 30, 86, 25), dm(33, 22, 85, 0), dm(36, 35, 79, 20), dm(40, 11, 76, 24), dm(41, 24, 74, 30), dm(41, 43, 72, 40),
    dm(42, 13, 72, 44), dm(43, 12, 71, 30), dm(43, 45, 70, 30), dm(45, 0, 69, 30), dm(47, 10, 67, 55),
  ];
  // (a) begins at 47°10′N 67°55′W and runs "west and south along the Canadian Border" to 45°00′N 74°15′W (approx).
  const EAST_BORDER = [[47.36, -68.33], [47.46, -69.22], [46.40, -70.05], [45.30, -71.08], [45.01, -71.50]];
  const EAST_AREA = [dm(47, 10, 67, 55), ...EAST_BORDER, ...EAST_REG.slice(0, -1)];
  const EAST_EXC = [ // (b) Hudson / Champlain / Mohawk valleys (reg)
    dm(45, 0, 73, 26), dm(44, 32, 73, 4), dm(42, 51, 73, 41), dm(41, 38, 73, 46), dm(41, 16, 73, 50), dm(41, 17, 74, 0),
    dm(41, 25, 73, 58), dm(41, 26, 74, 1), dm(41, 37, 73, 58), dm(42, 41, 73, 55), dm(43, 2, 76, 15), dm(43, 17, 75, 21),
    dm(42, 59, 74, 43), dm(42, 52, 73, 53), dm(44, 30, 73, 18), dm(45, 0, 73, 39), dm(45, 0, 73, 26),
  ];

  // ---- § 95.15 Western United States Mountainous Area ----
  // (a) "From the Pacific coastline of the United States, eastward along the Canadian and Mexican borders, to" this line (reg):
  const WEST_REG = [
    dm(49, 0, 108, 0), dm(46, 45, 104, 0), dm(44, 6, 103, 15), dm(43, 0, 103, 15), dm(41, 52, 103, 39), dm(35, 11, 103, 39),
    dm(33, 17, 104, 27), dm(32, 17, 104, 14), dm(29, 48, 102, 0),
  ];
  // US–Canada boundary through Haro Strait / Boundary Pass to the 49th parallel (approx). Shared with exception (b)(2).
  const SAN_JUAN_BORDER = [[48.30, -123.22], [48.50, -123.22], [48.67, -123.26], [48.77, -123.00], [49.0, -123.32]];
  const WEST_AREA = [
    ...WEST_REG,
    // Mexican border, Rio Grande to the Pacific (approx)
    [29.2, -102.9], [28.97, -103.2], [29.56, -104.4], [30.7, -105.0], [31.78, -106.53], [31.78, -108.21], [31.33, -108.21],
    [31.33, -111.07], [32.49, -114.81], [32.72, -114.72], [32.53, -117.12],
    // offshore, keeping the Channel Islands in (approx)
    [32.4, -117.4], [32.4, -119.0], [33.0, -121.5], [40.0, -125.5], [48.4, -125.3], [48.49, -124.73], [48.25, -123.6],
    ...SAN_JUAN_BORDER,
    // then the 49th parallel east, back to 49°00′N 108°00′W
  ];
  const WEST_EXC = [
    { name: 'Central Valley (95.15(b)(1))', poly: [
      dm(35, 25, 119, 9), dm(35, 29, 118, 58), dm(36, 49, 119, 37), dm(38, 30, 121, 24), dm(39, 30, 121, 32), dm(40, 8, 122, 8),
      dm(40, 6, 122, 20), dm(39, 5, 122, 12), dm(38, 1, 121, 51), dm(37, 37, 121, 12), dm(37, 0, 120, 58), dm(36, 14, 120, 11),
    ] },
    { name: 'Puget Sound (95.15(b)(2))', poly: [
      dm(49, 0, 122, 21), dm(48, 34, 122, 21), dm(48, 8, 122, 0), dm(47, 12, 122, 0), dm(46, 59, 122, 13), dm(46, 52, 122, 16),
      dm(46, 50, 122, 40), dm(46, 35, 122, 48), dm(46, 35, 123, 17), dm(47, 15, 123, 17), dm(47, 41, 122, 54), dm(48, 3, 122, 48),
      dm(48, 17, 123, 15), ...SAN_JUAN_BORDER, // "thence North and East along the United States and Canada Boundary" (approx)
    ] },
  ];

  // ---- § 95.17 Alaska Mountainous Area: the whole State except these (reg, except the approx closing legs noted) ----
  const AK_EXC = [
    { name: 'Fairbanks–Nenana (95.17(b)(1))', poly: [
      dm(64, 54, 147, 0), dm(64, 50, 151, 22), dm(63, 50, 152, 50), dm(63, 30, 152, 30), dm(63, 30, 151, 30), dm(64, 5, 150, 30),
      dm(64, 20, 149, 0), dm(64, 7, 146, 30), dm(63, 53, 146, 0), dm(63, 53, 145, 0), dm(64, 9, 145, 16), dm(64, 12, 146, 0),
      dm(64, 25, 146, 37),
    ] },
    { name: 'Anchorage–Homer (95.17(b)(2))', poly: [
      dm(61, 50, 151, 12), dm(61, 24, 150, 28), dm(61, 8, 151, 47), dm(59, 49, 152, 40), dm(59, 25, 153, 10), dm(59, 0, 153, 10),
      dm(59, 33, 151, 28), dm(60, 31, 150, 43), dm(61, 13, 149, 39), dm(61, 37, 149, 15), dm(61, 44, 149, 48), dm(62, 23, 149, 54),
      dm(62, 23, 150, 14),
    ] },
    { name: 'King Salmon–Port Heiden (95.17(b)(3))', poly: [ // closes "along the shoreline": the straight leg runs over Bristol Bay
      dm(58, 49, 159, 30), dm(59, 40, 157, 0), dm(59, 40, 155, 30), dm(59, 50, 154, 50), dm(59, 35, 154, 40), dm(58, 57, 156, 5),
      dm(58, 0, 156, 20), dm(57, 0, 158, 20), dm(56, 43, 158, 39), dm(56, 27, 160, 0),
    ] },
    { name: 'Bethel–Aniak and Nunivak Island (95.17(b)(4))', poly: [
      dm(63, 28, 161, 30), dm(62, 40, 163, 3), dm(62, 5, 162, 38), dm(61, 51, 160, 43), dm(62, 55, 160, 30), dm(63, 0, 158, 0),
      dm(61, 45, 159, 30), dm(61, 34, 159, 15), dm(61, 7, 160, 20), dm(60, 25, 160, 40), dm(59, 36, 161, 49),
      // "along the shoreline" round the Yukon–Kuskokwim delta, offshore of Nunivak Island (approx)
      [59.3, -162.5], [59.4, -167.6], [61.5, -166.9], [63.3, -165.6], [63.7, -162.5],
    ] },
    { name: 'North Slope (95.17(b)(5))', poly: [
      [69.5, -170.0], dm(69, 30, 156, 0), dm(69, 10, 153, 0), dm(69, 10, 149, 0), dm(69, 50, 146, 0), dm(69, 50, 145, 0),
      dm(69, 35, 141, 0), [72.5, -141.0], [72.5, -170.0], // coastline legs closed offshore (approx)
    ] },
    { name: 'Fort Yukon (95.17(b)(6))', poly: [
      dm(67, 20, 144, 0), dm(66, 0, 143, 0), dm(66, 5, 149, 0), dm(66, 45, 148, 0), dm(67, 0, 147, 0),
    ] },
    { name: 'Pribilof Islands (95.17(b)(7))', poly: [[56.4, -170.9], [57.4, -170.9], [57.4, -169.2], [56.4, -169.2]] }, // approx box
  ];
  // Southeast Alaska (the panhandle), east of 141°W (approx; Hyder AK and Stewart BC can't be told apart)
  const AK_PANHANDLE = [
    [60.33, -141.0], [60.0, -139.1], [59.3, -137.5], [59.8, -136.5], [59.65, -135.2], [58.9, -133.8], [58.4, -133.4],
    [57.5, -132.3], [56.75, -131.9], [56.1, -130.1], [55.75, -130.0], [54.7, -130.6], [54.5, -133.5], [54.5, -134.5],
    [58.0, -137.5], [59.5, -141.0],
  ];
  function inAlaska(lat, lon) {
    if (lat >= 51.2 && lon >= 172) return lat < 56;            // western Aleutians (approx)
    if (lat >= 51.2 && lon <= -141) return !(lon < -169 && lat > 64.0); // mainland west of 141°W, minus Chukotka (approx)
    return inPoly(lat, lon, AK_PANHANDLE);
  }

  // ---- § 95.19 Hawaii: Kauai, Oahu, Molokai, Lanai, Kahoolawe, Maui and Hawaii (not Niihau, not the NW islands) ----
  const inHawaiiListed = (lat, lon) => lat > 18.8 && lat < 22.35 && lon > -160.0 && lon < -154.7; // approx box

  // ---- § 95.21 Puerto Rico Mountainous Area (reg) ----
  const PR = [
    dm(18, 22, 66, 58), dm(18, 19, 66, 6), dm(18, 20, 65, 50), dm(18, 20, 65, 42), dm(18, 3, 65, 52), dm(18, 2, 65, 51),
    dm(17, 59, 65, 55), dm(18, 5, 66, 57), dm(18, 11, 67, 7),
  ];

  // Even–odd ray cast; polygons are [lat, lon] and close on themselves.
  function inPoly(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Regulation-defined lines only (not the approx border/coast legs), for "how close is the edge" warnings.
  const closed = (p) => [...p, p[0]];
  const REG_LINES = [
    EAST_REG, closed(EAST_EXC), WEST_REG, closed(WEST_EXC[0].poly), WEST_EXC[1].poly.slice(0, 13), closed(PR),
    closed(AK_EXC[0].poly), closed(AK_EXC[1].poly), AK_EXC[2].poly, AK_EXC[3].poly.slice(0, 11), AK_EXC[4].poly.slice(1, 7),
    closed(AK_EXC[5].poly),
  ];
  // Nautical miles from a point to the nearest regulation line (flat-earth approximation, fine at these distances).
  function edgeNm(lat, lon) {
    const k = Math.cos((lat * Math.PI) / 180) * 60;
    let best = Infinity;
    for (const line of REG_LINES) {
      for (let i = 1; i < line.length; i++) {
        const ax = (line[i - 1][1] - lon) * k, ay = (line[i - 1][0] - lat) * 60;
        const bx = (line[i][1] - lon) * k, by = (line[i][0] - lat) * 60;
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best) best = d;
      }
    }
    return best;
  }

  // → { mtn: true|false|null, area, section, exception, edgeNm }. mtn null = no position.
  function classify(lat, lon) {
    if (lat == null || lon == null || !Number.isFinite(+lat) || !Number.isFinite(+lon)) return { mtn: null, area: null, section: null, exception: null, edgeNm: null };
    lat = +lat; lon = ((+lon + 540) % 360) - 180;
    const out = (mtn, area, section, exception = null) => ({ mtn, area, section, exception, edgeNm: Math.round(edgeNm(lat, lon) * 10) / 10 });
    if (inPoly(lat, lon, EAST_AREA)) {
      return inPoly(lat, lon, EAST_EXC) ? out(false, 'Eastern US', '95.13', 'Hudson–Mohawk–Champlain valleys (95.13(b))') : out(true, 'Eastern US', '95.13');
    }
    if (inPoly(lat, lon, WEST_AREA)) {
      const x = WEST_EXC.find((e) => inPoly(lat, lon, e.poly));
      return x ? out(false, 'Western US', '95.15', x.name) : out(true, 'Western US', '95.15');
    }
    if (inAlaska(lat, lon)) {
      const x = AK_EXC.find((e) => inPoly(lat, lon, e.poly));
      return x ? out(false, 'Alaska', '95.17', x.name) : out(true, 'Alaska', '95.17');
    }
    if (inHawaiiListed(lat, lon)) return out(true, 'Hawaii', '95.19');
    if (inPoly(lat, lon, PR)) return out(true, 'Puerto Rico', '95.21');
    return out(false, null, null);
  }

  // Plain-English one-liner for tooltips.
  function describe(c) {
    if (!c || c.mtn == null) return 'No airport position, so terrain could not be worked out.';
    const edge = c.edgeNm != null && c.edgeNm < 10 ? ` About ${Math.round(c.edgeNm)} nm from a Part 95 boundary, so nearby terrain may be the other kind.` : '';
    if (c.mtn) return `Inside the ${c.area} Mountainous Area (14 CFR ${c.section}).${edge}`;
    if (c.exception) return `Non-mountainous: inside the ${c.area} area's exception for ${c.exception}.${edge}`;
    return `Non-mountainous: outside every 14 CFR Part 95 designated mountainous area.${edge}`;
  }

  // The regulation's own points, paragraph by paragraph, in the CFR's order (tests compare these with the eCFR text).
  const regParagraphs = () => [
    [dm(47, 10, 67, 55), ...EAST_REG], EAST_EXC, WEST_REG, WEST_EXC[0].poly, [...WEST_EXC[1].poly.slice(0, 13), WEST_EXC[1].poly[0]],
    closed(AK_EXC[0].poly), closed(AK_EXC[1].poly), closed(AK_EXC[2].poly), [...AK_EXC[3].poly.slice(0, 11), AK_EXC[3].poly[0]],
    AK_EXC[4].poly.slice(1, 7), closed(AK_EXC[5].poly), closed(PR),
  ];

  const api = { classify, describe, inPoly, edgeNm, regParagraphs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Terrain = api;
})(typeof window !== 'undefined' ? window : globalThis);
