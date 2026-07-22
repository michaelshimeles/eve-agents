import { defineTool } from "eve/tools";
import { z } from "zod";

// Open-Meteo WMO weather interpretation codes, condensed.
const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

export default defineTool({
  description:
    "Get live current weather for a city, using Open-Meteo (no API key). Pass the city name; it is geocoded automatically.",
  inputSchema: z.object({
    city: z.string().min(1).describe("City name, e.g. 'Toronto' or 'Paris, France'"),
  }),
  async execute({ city }, ctx) {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      { signal: ctx.abortSignal },
    );
    if (!geoRes.ok) throw new Error(`Geocoding failed (${geoRes.status})`);
    const geo = (await geoRes.json()) as {
      results?: Array<{
        name: string;
        country: string;
        latitude: number;
        longitude: number;
      }>;
    };
    const place = geo.results?.[0];
    if (!place) return { found: false as const, city };

    const wxRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`,
      { signal: ctx.abortSignal },
    );
    if (!wxRes.ok) throw new Error(`Weather lookup failed (${wxRes.status})`);
    const wx = (await wxRes.json()) as {
      current: {
        temperature_2m: number;
        apparent_temperature: number;
        relative_humidity_2m: number;
        weather_code: number;
        wind_speed_10m: number;
      };
    };

    return {
      found: true as const,
      location: `${place.name}, ${place.country}`,
      condition: WEATHER_CODES[wx.current.weather_code] ?? "Unknown",
      temperatureC: wx.current.temperature_2m,
      feelsLikeC: wx.current.apparent_temperature,
      humidityPercent: wx.current.relative_humidity_2m,
      windKmh: wx.current.wind_speed_10m,
    };
  },
});
