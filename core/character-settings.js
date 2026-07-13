// character-settings.js
function loadSettings() {
    try {
        var saved = localStorage.getItem('joystickAnimSettings');
        if (saved) {
            var parsed = JSON.parse(saved);
            for (var key in parsed.map) { animSettings.map[key] = parsed.map[key]; }
            for (var clipKey in parsed.clip) { animSettings.clip[clipKey] = parsed.clip[clipKey]; }
            if (!isNaN(parsed.cooldown)) animSettings.cooldown = parsed.cooldown;
            if (!isNaN(parsed.speed)) animSettings.speed = parsed.speed;
            if (!isNaN(parsed.runForceThreshold)) animSettings.runForceThreshold = parsed.runForceThreshold;
        }
    } catch (e) {}
}

function saveSettings() {
    localStorage.setItem('joystickAnimSettings', JSON.stringify(animSettings));
}

function resetToDefaults() {
    animSettings.map = JSON.parse(JSON.stringify(defaultSettings.map));
    animSettings.clip = JSON.parse(JSON.stringify(defaultSettings.clip));
    animSettings.cooldown = defaultSettings.cooldown;
    animSettings.speed = defaultSettings.speed;
    animSettings.runForceThreshold = defaultSettings.runForceThreshold;
    saveSettings();
}