/* --- FREE AQI SERVICE (NO API KEY REQUIRED) ---
   Uses OpenStreetMap Nominatim for geocoding and Open-Meteo for weather/AQI data.
   Both services are completely free and require no API keys!
*/
class AQIService {
    constructor() {
        // No API keys needed! These are free public APIs
        this.nominatimUrl = 'https://nominatim.openstreetmap.org';
        this.openMeteoUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality';
        this.weatherUrl = 'https://api.open-meteo.com/v1/forecast';
    }

    async validateCity(city) {
        try {
            // Use OpenStreetMap Nominatim (free, no API key required)
            const response = await fetch(
                `${this.nominatimUrl}/search?q=${encodeURIComponent(city)}&format=json&limit=1&addressdetails=1`,
                {
                    headers: {
                        'User-Agent': 'AirAware-AQI-App' // Required by Nominatim
                    }
                }
            );

            if (!response.ok) {
                throw new Error('Unable to connect to geocoding service.');
            }

            const data = await response.json();

            if (!data || data.length === 0) {
                throw new Error('City not found. Please check the spelling and try again.');
            }

            const location = data[0];
            const address = location.address || {};

            return {
                lat: parseFloat(location.lat),
                lon: parseFloat(location.lon),
                cityName: address.city || address.town || address.village || address.municipality || city,
                country: address.country_code ? address.country_code.toUpperCase() : '',
                displayName: location.display_name
            };
        } catch (error) {
            if (error.message.includes('not found')) {
                throw new Error('City not found. Please check the spelling and try again.');
            }
            throw new Error('Unable to validate city. Please try again later.');
        }
    }

    async getCityByCoords(lat, lon) {
        try {
            const response = await fetch(
                `${this.nominatimUrl}/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`,
                {
                    headers: { 'User-Agent': 'AirAware-AQI-App' }
                }
            );

            if (!response.ok) throw new Error('Unable to fetch location name.');

            const data = await response.json();
            const address = data.address || {};

            return {
                lat: lat,
                lon: lon,
                cityName: address.city || address.town || address.village || address.municipality || "Unknown Location",
                country: address.country_code ? address.country_code.toUpperCase() : '',
                displayName: data.display_name
            };
        } catch (error) {
            console.error("Reverse geocoding error:", error);
            // Fallback if reverse geocoding fails, still allows usage of coords
            return { lat, lon, cityName: "Current Location", country: "" };
        }
    }

    async getCityData(cityData) {
        try {
            // Step 2: Get weather data from Open-Meteo (free, no API key)
            const weatherResponse = await fetch(
                `${this.weatherUrl}?latitude=${cityData.lat}&longitude=${cityData.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`
            );

            if (!weatherResponse.ok) {
                throw new Error('Unable to fetch weather data for this location.');
            }

            const weatherData = await weatherResponse.json();
            const current = weatherData.current;

            // Step 3: Get air quality data + HOURLY FORECAST
            const aqiResponse = await fetch(
                `${this.openMeteoUrl}?latitude=${cityData.lat}&longitude=${cityData.lon}&current=us_aqi,pm2_5,pm10,ozone&hourly=us_aqi&timezone=auto&past_days=1&forecast_days=2`
            );

            if (!aqiResponse.ok) {
                throw new Error('Unable to fetch air quality data for this location.');
            }

            const aqiData = await aqiResponse.json();
            const aqiCurrent = aqiData.current;

            // Check if air quality data is available
            if (!aqiCurrent || aqiCurrent.us_aqi === null || aqiCurrent.us_aqi === undefined) {
                throw new Error('Air quality data is not available for this location. Please try a different city.');
            }

            // Step 4: Process real forecast (extract next 24 hours logic or specific points)
            // We want a trend: some past data + future forecast
            const forecast = this.processForecast(aqiData.hourly);

            // Convert weather code to description
            const weatherDescription = this.getWeatherDescription(current.weather_code);

            return {
                city: cityData.cityName,
                country: cityData.country,
                aqi: Math.round(aqiCurrent.us_aqi),
                temp: Math.round(current.temperature_2m),
                humidity: Math.round(current.relative_humidity_2m),
                wind: Math.round(current.wind_speed_10m * 3.6), // Convert m/s to km/h
                pm25: aqiCurrent.pm2_5 || 0,
                pm10: aqiCurrent.pm10 || 0,
                o3: aqiCurrent.ozone || 0,
                weather: weatherDescription,
                forecast: forecast
            };
        } catch (error) {
            throw error;
        }
    }

    getWeatherDescription(code) {
        // WMO Weather interpretation codes
        const weatherCodes = {
            0: 'Clear', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
            45: 'Foggy', 48: 'Depositing Rime Fog', 51: 'Light Drizzle',
            53: 'Moderate Drizzle', 55: 'Dense Drizzle', 56: 'Light Freezing Drizzle',
            57: 'Dense Freezing Drizzle', 61: 'Slight Rain', 63: 'Moderate Rain',
            65: 'Heavy Rain', 66: 'Light Freezing Rain', 67: 'Heavy Freezing Rain',
            71: 'Slight Snow', 73: 'Moderate Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
            80: 'Slight Rain Showers', 81: 'Moderate Rain Showers', 82: 'Violent Rain Showers',
            85: 'Slight Snow Showers', 86: 'Heavy Snow Showers', 95: 'Thunderstorm',
            96: 'Thunderstorm/Hail', 99: 'Heavy Thunderstorm'
        };
        return weatherCodes[code] || 'Clear';
    }

    processForecast(hourlyData) {
        // We want a visualization that shows a bit of history and future
        // Let's grab specific time points relative to "now"
        // The API returns arrays of times and values

        const now = new Date();
        const currentHourIndex = hourlyData.time.findIndex(t => new Date(t) >= now);

        if (currentHourIndex === -1) return [50, 50, 50, 50, 50, 50]; // Fallback

        // Get indices for -4h, -3h, -2h, -1h, Now, +1h (Forecast)
        // Note: Graph labels are fixed in updateChart currently, we should match them roughly
        // Labels: ['4h ago', '3h ago', '2h ago', '1h ago', 'Now', 'Forecast']

        const dataPoints = [];
        for (let i = 4; i >= 0; i--) {
            const index = currentHourIndex - i;
            if (index >= 0 && index < hourlyData.us_aqi.length) {
                dataPoints.push(hourlyData.us_aqi[index]);
            } else {
                dataPoints.push(hourlyData.us_aqi[currentHourIndex] || 50);
            }
        }

        // Final point: approximate forecast (avg of next 3 hours?)
        // Or just the next hour
        const nextIndex = currentHourIndex + 1;
        if (nextIndex < hourlyData.us_aqi.length) {
            dataPoints.push(hourlyData.us_aqi[nextIndex]);
        } else {
            dataPoints.push(dataPoints[dataPoints.length - 1]);
        }

        return dataPoints;
    }
}

/* --- AI ANALYST ENGINE --- */
class AIAnalyst {
    analyze(data) {
        const { aqi, temp, weather } = data;
        let advice = "";

        if (aqi <= 50) {
            advice = `Currently, the air is pristine. It's a great time to open windows or go for a run. The temperature is ${temp}°C, making it comfortable. Enjoy the fresh air!`;
        } else if (aqi <= 100) {
            advice = `Air quality is acceptable. However, if you are unusually sensitive to pollution, consider limiting prolonged outdoor exertion. It's ${weather} outside.`;
        } else if (aqi <= 200) {
            advice = `Alert: Unhealthy air quality detected. Everyone may begin to experience health effects. Active children and adults should avoid prolonged outdoor exertion. Wear a mask if necessary.`;
        } else {
            advice = `CRITICAL WARNING: Hazardous conditions! Avoid all physical activity outdoors. Keep windows closed. Run an air purifier if available. Visibility is low due to ${weather}.`;
        }
        return { advice };
    }
}

/* --- FRONTEND CONTROLLER --- */
const api = new AQIService();
const ai = new AIAnalyst();
let myChart = null;

// On Load
window.addEventListener('load', () => {
    document.getElementById('date-display').innerText = new Date().toDateString();
    // Don't auto-fetch on load - let user search first
});

// Enter key support
document.getElementById('city-input').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') fetchData();
});

function showError(message) {
    const errorDiv = document.getElementById('error-message');
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
    errorDiv.classList.add('animate-pulse');

    // Hide error after 5 seconds
    setTimeout(() => {
        errorDiv.classList.add('hidden');
        errorDiv.classList.remove('animate-pulse');
    }, 5000);
}

function hideError() {
    const errorDiv = document.getElementById('error-message');
    errorDiv.classList.add('hidden');
}

// Button Handler for Geolocation
async function getUserLocation() {
    if (!navigator.geolocation) {
        showError("Geolocation is not supported by your browser.");
        return;
    }

    // UI Loading State
    hideError();
    document.getElementById('loading-spinner').classList.remove('hidden');

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            try {
                const { latitude, longitude } = position.coords;

                // Get City Details from Coords
                const cityData = await api.getCityByCoords(latitude, longitude);

                // Continue with regular fetch but pass the full cityData object
                fetchData(null, cityData);

                // Update input box
                document.getElementById('city-input').value = cityData.cityName;

            } catch (error) {
                document.getElementById('loading-spinner').classList.add('hidden');
                showError("Could not retrieve your location.");
            }
        },
        (error) => {
            document.getElementById('loading-spinner').classList.add('hidden');
            let msg = "Error getting location.";
            if (error.code === 1) msg = "Location permission denied.";
            if (error.code === 2) msg = "Location unavailable.";
            if (error.code === 3) msg = "Location request timed out.";
            showError(msg);
        }
    );
}

async function fetchData(defaultCity = null, directCityData = null) {
    const cityInput = document.getElementById('city-input');
    const city = defaultCity || cityInput.value.trim();

    if (!city && !directCityData) {
        showError('Please enter a city name.');
        return;
    }

    // UI Loading State
    hideError();
    document.getElementById('loading-spinner').classList.remove('hidden');
    document.getElementById('city-name').classList.add('opacity-50');
    cityInput.disabled = true;

    try {
        let cityData;

        if (directCityData) {
            cityData = directCityData;
        } else {
            // Resolve city name to coords first
            cityData = await api.validateCity(city);
        }

        // 1. Get AQI/Weather Data (with real forecast)
        const data = await api.getCityData(cityData);

        // 2. Get AI Analysis
        const analysis = ai.analyze(data);

        // 3. Update UI
        updateDashboard(data, analysis);
    } catch (error) {
        console.error("Error:", error);
        showError(error.message || 'Could not fetch data. Please check your internet connection and try again.');
    } finally {
        document.getElementById('loading-spinner').classList.add('hidden');
        document.getElementById('city-name').classList.remove('opacity-50');
        cityInput.disabled = false;
    }
}

function updateDashboard(data, analysis) {
    // Text Updates
    const cityDisplay = data.country ? `${data.city}, ${data.country}` : data.city;
    document.getElementById('city-name').innerText = cityDisplay;
    document.getElementById('aqi-value').innerText = data.aqi;
    document.getElementById('temp-val').innerText = `${data.temp}°C`;
    document.getElementById('humid-val').innerText = `${data.humidity}%`;
    document.getElementById('wind-val').innerText = `${data.wind} km/h`;

    // Pollutants
    document.getElementById('pm25-val').innerText = `${data.pm25.toFixed(1)} µg/m³`;
    document.getElementById('pm10-val').innerText = `${data.pm10.toFixed(1)} µg/m³`;
    document.getElementById('o3-val').innerText = `${data.o3.toFixed(1)} ppb`;

    // Update progress bars (normalize to 0-100% for display)
    const pm25Percent = Math.min((data.pm25 / 50) * 100, 100); // 50 µg/m³ = 100%
    const pm10Percent = Math.min((data.pm10 / 100) * 100, 100); // 100 µg/m³ = 100%
    const o3Percent = Math.min((data.o3 / 100) * 100, 100); // 100 ppb = 100%

    document.getElementById('pm25-bar').style.width = `${pm25Percent}%`;
    document.getElementById('pm10-bar').style.width = `${pm10Percent}%`;
    document.getElementById('o3-bar').style.width = `${o3Percent}%`;

    // AI Text Typing Effect
    const aiTextEl = document.getElementById('ai-text');
    aiTextEl.innerText = analysis.advice;

    // Visual Styling based on AQI
    const body = document.getElementById('main-body');
    const badge = document.getElementById('status-badge');
    const circle = document.getElementById('aqi-circle');
    const icon = document.getElementById('weather-icon');
    const smog = document.getElementById('smog-layer');

    // Reset classes
    body.className = "text-white min-h-screen flex flex-col items-center justify-center p-4 transition-colors duration-1000";

    // Calculate Circle Dash Offset (440 is full circumference)
    // Offset = 440 - (440 * percent / 100)
    const percent = Math.min(data.aqi / 300, 1); // Cap at 300 for calculation
    const offset = 440 - (440 * percent);
    circle.style.strokeDashoffset = offset;

    if (data.aqi <= 50) {
        body.classList.add('bg-good');
        badge.innerText = "Good";
        badge.className = "bg-green-500 px-4 py-1 rounded-full text-sm font-semibold shadow-lg";
        circle.classList.add('text-green-400');
        icon.className = "fa-solid fa-sun text-4xl text-yellow-300 animate-spin-slow";
        smog.style.display = 'none';
    } else if (data.aqi <= 100) {
        body.classList.add('bg-moderate');
        badge.innerText = "Moderate";
        badge.className = "bg-yellow-500 px-4 py-1 rounded-full text-sm font-semibold shadow-lg";
        circle.classList.add('text-yellow-300');
        icon.className = "fa-solid fa-cloud-sun text-4xl text-white animate-pulse";
        smog.style.display = 'none';
    } else if (data.aqi <= 200) {
        body.classList.add('bg-unhealthy');
        badge.innerText = "Unhealthy";
        badge.className = "bg-red-500 px-4 py-1 rounded-full text-sm font-semibold shadow-lg";
        circle.classList.add('text-red-400');
        icon.className = "fa-solid fa-smog text-4xl text-gray-200";
        smog.style.display = 'block';
    } else {
        body.classList.add('bg-hazardous');
        badge.innerText = "Hazardous";
        badge.className = "bg-purple-600 px-4 py-1 rounded-full text-sm font-semibold shadow-lg";
        circle.classList.add('text-purple-400');
        icon.className = "fa-solid fa-mask-face text-4xl text-gray-400";
        smog.style.display = 'block';
        smog.style.background = "rgba(100, 50, 50, 0.6)"; // Reddish smog
    }

    // Update Chart
    updateChart(data.forecast);
}

function updateChart(forecastData) {
    const ctx = document.getElementById('aqiChart').getContext('2d');

    if (myChart) myChart.destroy();

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['4h ago', '3h ago', '2h ago', '1h ago', 'Now', 'Forecast'],
            datasets: [{
                label: 'AQI Level',
                data: forecastData,
                borderColor: 'rgba(255, 255, 255, 0.8)',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    ticks: { color: 'rgba(255,255,255,0.7)' },
                    grid: { display: false }
                },
                y: {
                    ticks: { color: 'rgba(255,255,255,0.7)' },
                    grid: { color: 'rgba(255,255,255,0.1)' }
                }
            }
        }
    });
}

