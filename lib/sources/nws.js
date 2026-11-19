// National Weather Service public API (api.weather.gov): plain-language area forecast.
// Two steps: /points/{lat},{lon} gives the forecast URL for that grid, then fetch it.
const { getJson } = require('../http');

async function forecastFor(lat, lon) {
  const la = lat.toFixed(4), lo = lon.toFixed(4);
  const pt = await getJson(`https://api.weather.gov/points/${la},${lo}`, 24 * 3600);
  const props = (pt && pt.properties) || {};
  if (!props.forecast) throw new Error('NWS has no forecast for this point');
  const fc = await getJson(props.forecast, 900);
  const periods = ((fc && fc.properties && fc.properties.periods) || []).slice(0, 6).map((p) => ({
    name: p.name,
    temperature: p.temperature,
    unit: p.temperatureUnit,
    wind: [p.windDirection, p.windSpeed].filter(Boolean).join(' '),
    short: p.shortForecast,
    detail: p.detailedForecast,
    precipChance: p.probabilityOfPrecipitation ? p.probabilityOfPrecipitation.value : null,
  }));
  // Hourly forecast (precip chance, wind, temp) for the shift outlook. Optional: failure doesn't hide the rest.
  let hourly = [];
  let hourlyError = null;
  if (props.forecastHourly) {
    try {
      const fh = await getJson(props.forecastHourly, 900);
      hourly = ((fh && fh.properties && fh.properties.periods) || []).slice(0, 36).map((p) => ({
        t: Date.parse(p.startTime),
        temp: p.temperature, unit: p.temperatureUnit,
        wind: [p.windDirection, p.windSpeed].filter(Boolean).join(' '),
        short: p.shortForecast,
        pop: p.probabilityOfPrecipitation ? p.probabilityOfPrecipitation.value : null,
      }));
    } catch (e) { hourlyError = e.message; /* hourly is optional; the outlook falls back to LAMP */ }
  }
  const rel = props.relativeLocation && props.relativeLocation.properties;
  return {
    place: rel ? `${rel.city}, ${rel.state}` : null,
    office: props.gridId || props.cwa || null,
    updated: fc && fc.properties ? fc.properties.updated || fc.properties.generatedAt : null,
    periods,
    hourly,
    hourlyError,
  };
}

module.exports = { forecastFor };
