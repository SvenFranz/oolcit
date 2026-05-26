"use strict";

const NOISE_PRE_ROLL_SECONDS = 1.0;
const NOISE_POST_ROLL_SECONDS = 1.0;
const NO_NOISE_PAUSE_FACTOR = 0.5;
const MIN_SPEECH_VOLUME_PERCENT = 1;
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const DEFAULT_SPEECH_VOLUME_PERCENT = 50;
const DEFAULT_DIFFICULTY_DB = -6;
const NOISE_FADE_WINDOW_MS = 50;

/* ==========================================================================
   Zustand
   ========================================================================== */

const state = {
    audioContext: null,
    activeSources: [],

    currentSample: null,
    hasStarted: false,
    solutionVisible: false,

    availableLists: [],
    availableNoises: [],
    noiseUrls: {},
};

const PREF_COOKIE_NAMES = {
    voice: "olcit_voice",
    volume: "olcit_volume",
    list: "olcit_list",
    noise: "olcit_noise",
    difficulty: "olcit_difficulty",
};

/* ==========================================================================
   DOM
   ========================================================================== */

const dom = {
    listSelect: document.getElementById("listSelect"),
    infoText: document.getElementById("infoText"),

    startButton: document.getElementById("startButton"),
    nextButton: document.getElementById("nextButton"),
    solutionButton: document.getElementById("solutionButton"),

    solutionText: document.getElementById("solutionText"),
    startLogo: document.getElementById("startLogo"),

    noiseTypeList: document.getElementById("noiseTypeList"),
    difficultyBox: document.getElementById("difficultyBox"),

    volumeSlider: document.getElementById("volumeSlider"),
    volumeValue: document.getElementById("volumeValue"),

    difficultySlider: document.getElementById("difficultySlider"),
    difficultyValue: document.getElementById("difficultyValue"),

    fontSizeSlider: document.getElementById("fontSizeSlider"),
};


/* ==========================================================================
   Allgemeine Hilfsfunktionen
   ========================================================================== */

function setInfo(message = "") {
    const text = String(message);

    /*
     * Leerer String bleibt wirklich leer.
     * Whitespace-only, z. B. " ", wird als sichtbarer Platzhalter angezeigt.
     */
    if (text.length > 0 && text.trim() === "") {
        dom.infoText.textContent = "\u00A0".repeat(text.length);
        return;
    }

    dom.infoText.textContent = text;
}


function getVoice() {
    const selected = document.querySelector("input[name='voice']:checked");
    return selected ? selected.value : "female";
}


function getNoiseType() {
    const selected = document.querySelector("input[name='noiseType']:checked");
    return selected ? selected.value : "none";
}


function dbToLinear(db) {
    return Math.pow(10, db / 20);
}


function volumePercent() {
    const value = Number(dom.volumeSlider.value);

    if (!Number.isFinite(value)) {
        return MIN_SPEECH_VOLUME_PERCENT;
    }

    return Math.max(value, MIN_SPEECH_VOLUME_PERCENT);
}


function volumeLinear() {
    return volumePercent() / 100;
}


function showLogoOnly() {
    dom.startLogo.hidden = false;

    dom.solutionText.hidden = true;
    dom.solutionText.textContent = "";

    state.solutionVisible = false;
}


function showSolutionText(text) {
    dom.startLogo.hidden = true;

    dom.solutionText.hidden = false;
    dom.solutionText.textContent = text;

    state.solutionVisible = true;
}


function clearSolution() {
    showLogoOnly();
}

function randomNoiseOffset(bufferDuration, requiredDuration) {
    if (bufferDuration <= 0) {
        return 0;
    }

    /*
     * Wenn die Störgeräuschdatei länger ist als die benötigte Dauer,
     * wählen wir einen zufälligen Ausschnitt, der vollständig hineinpasst.
     */
    if (bufferDuration > requiredDuration) {
        const maxOffset = bufferDuration - requiredDuration;
        return Math.random() * maxOffset;
    }

    /*
     * Wenn die Störgeräuschdatei kürzer ist als benötigt,
     * starten wir trotzdem zufällig und lassen später loopen.
     */
    return Math.random() * bufferDuration;
}

function setCookie(name, value) {
    document.cookie =
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}; ` +
        `Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
}


function getCookie(name) {
    const encodedName = encodeURIComponent(name);
    const cookies = document.cookie ? document.cookie.split("; ") : [];

    for (const cookie of cookies) {
        const [rawName, ...rawValueParts] = cookie.split("=");

        if (rawName === encodedName) {
            return decodeURIComponent(rawValueParts.join("="));
        }
    }

    return null;
}


function clampNumber(value, min, max, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.min(Math.max(number, min), max);
}


function setRadioValue(name, value) {
    const radios = document.querySelectorAll(`input[name="${name}"]`);

    for (const radio of radios) {
        if (radio.value === value) {
            radio.checked = true;
            return true;
        }
    }

    return false;
}


function selectOptionExists(selectElement, value) {
    return Array.from(selectElement.options).some((option) => option.value === value);
}

function saveVoicePreference() {
    setCookie(PREF_COOKIE_NAMES.voice, getVoice());
}


function saveVolumePreference() {
    setCookie(PREF_COOKIE_NAMES.volume, volumePercent());
}


function saveListPreference() {
    setCookie(PREF_COOKIE_NAMES.list, dom.listSelect.value);
}


function saveNoisePreference() {
    setCookie(PREF_COOKIE_NAMES.noise, getNoiseType());
}


function saveDifficultyPreference() {
    setCookie(PREF_COOKIE_NAMES.difficulty, dom.difficultySlider.value);
}

async function restorePreferencesFromCookies() {
    const savedVoice = getCookie(PREF_COOKIE_NAMES.voice);

    if (savedVoice) {
        setRadioValue("voice", savedVoice);
    }

    /*
     * Lautstärke:
     * - wenn Cookie vorhanden: Cookie-Wert verwenden
     * - wenn kein Cookie vorhanden: Standardwert 50 %
     */
    const savedVolume = getCookie(PREF_COOKIE_NAMES.volume);

    const restoredVolume = savedVolume !== null
        ? clampNumber(
            savedVolume,
            MIN_SPEECH_VOLUME_PERCENT,
            100,
            DEFAULT_SPEECH_VOLUME_PERCENT
        )
        : DEFAULT_SPEECH_VOLUME_PERCENT;

    dom.volumeSlider.value = restoredVolume;
    dom.volumeValue.textContent = volumePercent();

    /*
     * Schwierigkeit:
     * - wenn Cookie vorhanden: Cookie-Wert verwenden
     * - wenn kein Cookie vorhanden: Standardwert -6 dB
     */
    const savedDifficulty = getCookie(PREF_COOKIE_NAMES.difficulty);

    const restoredDifficulty = savedDifficulty !== null
        ? clampNumber(
            savedDifficulty,
            Number(dom.difficultySlider.min),
            Number(dom.difficultySlider.max),
            DEFAULT_DIFFICULTY_DB
        )
        : DEFAULT_DIFFICULTY_DB;

    dom.difficultySlider.value = restoredDifficulty;

    const savedNoise = getCookie(PREF_COOKIE_NAMES.noise);

    if (savedNoise) {
        setRadioValue("noiseType", savedNoise);
    }

    updateDifficultyLabel();
    updateNoiseDifficultyState();

    const savedList = getCookie(PREF_COOKIE_NAMES.list);
    const canRestoreList =
        savedList &&
        selectOptionExists(dom.listSelect, savedList);

    if (canRestoreList) {
        dom.listSelect.value = savedList;
        await selectList();
    } else {
        resetTrainingButtons();
        showLogoOnly();
        setInfo("Bitte eine Liste auswählen.");
    }
}

function createHannFadeCurve(targetGain, fadeIn = true, points = 64) {
    const curve = new Float32Array(points);

    for (let i = 0; i < points; i += 1) {
        const x = i / (points - 1);

        /*
         * Half-Hann:
         * Fade-In:  0 → 1
         * Fade-Out: 1 → 0
         */
        const hannValue = fadeIn
            ? 0.5 * (1 - Math.cos(Math.PI * x))
            : 0.5 * (1 + Math.cos(Math.PI * x));

        curve[i] = targetGain * hannValue;
    }

    return curve;
}


function applyNoiseHannEnvelope(gainParam, targetGain, startTime, endTime) {
    const totalDuration = endTime - startTime;

    if (totalDuration <= 0) {
        return;
    }

    const requestedFadeSeconds = NOISE_FADE_WINDOW_MS / 1000;

    /*
     * Kleiner Sicherheitsabstand, damit Fade-In und Fade-Out
     * niemals exakt aneinanderstoßen oder sich durch Rundung überlappen.
     */
    const epsilonSeconds = 0.001;

    /*
     * Der Fade darf maximal knapp die halbe Gesamtdauer einnehmen.
     * So bleibt zwischen Fade-In und Fade-Out mindestens ein kleiner Abstand.
     */
    const fadeSeconds = Math.min(
        requestedFadeSeconds,
        Math.max(0, (totalDuration - epsilonSeconds) / 2)
    );

    gainParam.cancelScheduledValues(startTime);

    /*
     * Startwert ohne zusätzliches Automation-Event direkt im Kurvenbereich.
     */
    gainParam.value = 0;

    if (fadeSeconds <= 0) {
        gainParam.setValueAtTime(targetGain, startTime);
        return;
    }

    const fadeOutStartTime = endTime - fadeSeconds;

    const fadeInCurve = createHannFadeCurve(targetGain, true);
    const fadeOutCurve = createHannFadeCurve(targetGain, false);

    /*
     * Wichtig:
     * Keine setValueAtTime()-Events innerhalb oder direkt am Ende
     * der setValueCurveAtTime()-Intervalle setzen.
     */
    gainParam.setValueCurveAtTime(
        fadeInCurve,
        startTime,
        fadeSeconds
    );

    /*
     * Nach dem Fade-In bleibt der letzte Kurvenwert erhalten,
     * also targetGain.
     */

    gainParam.setValueCurveAtTime(
        fadeOutCurve,
        fadeOutStartTime,
        fadeSeconds
    );

    /*
     * Nach dem Fade-Out ist der letzte Kurvenwert 0.
     * Da die Noise-Source bei endTime gestoppt wird, brauchen wir
     * hier kein zusätzliches setValueAtTime(0, endTime).
     */
}

/* ==========================================================================
   Button-Zustände
   ========================================================================== */

function resetTrainingButtons() {
    state.hasStarted = false;
    state.currentSample = null;
    state.solutionVisible = false;

    dom.startButton.textContent = "Start";
    dom.startButton.disabled = true;

    dom.nextButton.disabled = true;
    dom.solutionButton.disabled = true;
}


function enableStartState() {
    state.hasStarted = false;
    state.currentSample = null;
    state.solutionVisible = false;

    dom.startButton.textContent = "Start";
    dom.startButton.disabled = false;

    dom.nextButton.disabled = true;
    dom.solutionButton.disabled = true;
}


function enableTrainingState() {
    state.hasStarted = true;

    dom.startButton.textContent = "Wiederholen";
    dom.startButton.disabled = false;

    dom.nextButton.disabled = false;
    dom.solutionButton.disabled = state.solutionVisible;
}


function disableTrainingStateAfterFinished() {
    state.hasStarted = false;
    state.currentSample = null;
    state.solutionVisible = false;

    dom.startButton.textContent = "Wiederholen";
    dom.startButton.disabled = true;

    dom.nextButton.disabled = true;
    dom.solutionButton.disabled = true;
}


/* ==========================================================================
   UI: Schwierigkeit und Störgeräusche
   ========================================================================== */

function updateDifficultyLabel() {
    const value = Number(dom.difficultySlider.value);

    if (value <= -12) {
        dom.difficultyValue.textContent = "Leicht";
    } else if (value <= -6) {
        dom.difficultyValue.textContent = "Mittel";
    } else {
        dom.difficultyValue.textContent = "Schwer";
    }
}


function updateNoiseDifficultyState() {
    const hasNoise = getNoiseType() !== "none";
    dom.difficultyBox.disabled = !hasNoise;
}


function renderNoiseOptions() {
    dom.noiseTypeList.innerHTML = "";

    const noneLabel = document.createElement("label");

    const noneInput = document.createElement("input");
    noneInput.type = "radio";
    noneInput.name = "noiseType";
    noneInput.value = "none";
    noneInput.checked = true;

    noneLabel.appendChild(noneInput);
    noneLabel.appendChild(document.createTextNode(" ohne"));

    dom.noiseTypeList.appendChild(noneLabel);

    if (!state.availableNoises.length) {
        const message = document.createElement("p");
        message.className = "muted";
        message.textContent = "Keine Störgeräuschdateien gefunden.";

        dom.noiseTypeList.appendChild(message);
        updateNoiseDifficultyState();
        return;
    }

    for (const noise of state.availableNoises) {
        const label = document.createElement("label");

        const input = document.createElement("input");
        input.type = "radio";
        input.name = "noiseType";
        input.value = noise.id;

        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${noise.label}`));

        dom.noiseTypeList.appendChild(label);
    }

    updateNoiseDifficultyState();
}


/* ==========================================================================
   UI: Listen
   ========================================================================== */

function renderListOptions() {
    dom.listSelect.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Bitte eine Liste auswählen!";
    dom.listSelect.appendChild(placeholder);

    if (!state.availableLists.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "Keine Listen gefunden";
        option.disabled = true;

        dom.listSelect.appendChild(option);

        resetTrainingButtons();
        setInfo("Keine Listen gefunden. Bitte Zuordnungsdatei prüfen.");
        return;
    }

    for (const list of state.availableLists) {
        const option = document.createElement("option");
        option.value = list.filename;
        option.textContent = list.label;
        option.dataset.label = list.label;

        dom.listSelect.appendChild(option);
    }

    resetTrainingButtons();
    // setInfo("Bitte eine Liste auswählen."); 
    setInfo(" ");
}


/* ==========================================================================
   API
   ========================================================================== */

async function apiGet(url) {
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.message || "Unbekannter Fehler");
    }

    return data;
}


async function apiPost(url, payload = {}) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.message || "Unbekannter Fehler");
    }

    return data;
}


async function loadLists() {
    const data = await apiGet("/api/lists");

    state.availableLists = data.lists || [];

    renderListOptions();
}


async function loadNoiseUrls() {
    const data = await apiGet("/api/noises");

    state.availableNoises = data.noises || [];
    state.noiseUrls = {};

    for (const noise of state.availableNoises) {
        state.noiseUrls[noise.id] = noise.url;
    }

    renderNoiseOptions();
}


/* ==========================================================================
   Audio
   ========================================================================== */

function stopPlayback() {
    for (const source of state.activeSources) {
        try {
            source.stop();
        } catch (error) {
            // Quelle war eventuell bereits gestoppt.
        }
    }

    state.activeSources = [];
}


async function ensureAudioContext() {
    if (!state.audioContext) {
        state.audioContext = new AudioContext();
    }

    if (state.audioContext.state === "suspended") {
        await state.audioContext.resume();
    }

    return state.audioContext;
}


async function loadAudioBuffer(url) {
    const ctx = await ensureAudioContext();
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Audiodatei konnte nicht geladen werden: ${url}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuffer);
}


async function playSample(sample) {
    stopPlayback();

    const ctx = await ensureAudioContext();

    const speechBuffer = await loadAudioBuffer(sample.audio_url);

    const speechSource = ctx.createBufferSource();
    speechSource.buffer = speechBuffer;

    const speechGain = ctx.createGain();
    speechGain.gain.value = volumeLinear();

    speechSource.connect(speechGain);
    speechGain.connect(ctx.destination);

    state.activeSources.push(speechSource);

    const noiseType = getNoiseType();
    const noiseUrl = noiseType !== "none" ? state.noiseUrls[noiseType] : null;
    const hasNoise = Boolean(noiseUrl);

    const now = ctx.currentTime;

    /*
     * Mit Störgeräusch:
     * voller Vorlauf + Sprache + voller Nachlauf
     *
     * Ohne Störgeräusch:
     * halber Vorlauf + Sprache + halber Nachlauf
     */
    const preRollSeconds = hasNoise
        ? NOISE_PRE_ROLL_SECONDS
        : NOISE_PRE_ROLL_SECONDS * NO_NOISE_PAUSE_FACTOR;

    const postRollSeconds = hasNoise
        ? NOISE_POST_ROLL_SECONDS
        : NOISE_POST_ROLL_SECONDS * NO_NOISE_PAUSE_FACTOR;

    const speechStartTime = now + preRollSeconds;

    const totalBlockDuration =
        preRollSeconds +
        speechBuffer.duration +
        postRollSeconds;

    const blockEndTime = now + totalBlockDuration;

    if (hasNoise) {
        const noiseBuffer = await loadAudioBuffer(noiseUrl);

        const noiseSource = ctx.createBufferSource();
        noiseSource.buffer = noiseBuffer;

        /*
         * Wenn das Störgeräusch kürzer ist als die benötigte Gesamtdauer,
         * wird geloopt. Wenn es lang genug ist, wird ein zufälliger
         * zusammenhängender Ausschnitt gewählt.
         */
        noiseSource.loop = noiseBuffer.duration < totalBlockDuration;

        const noiseGain = ctx.createGain();

        const difficultyDb = Number(dom.difficultySlider.value);
        const noiseTargetGain = volumeLinear() * dbToLinear(difficultyDb);

        /*
         * Wichtig:
         * Startwert 0, damit kein Klick beim Start entsteht.
         * Die eigentliche Lautstärke wird danach per Hann-Hüllkurve automatisiert.
         */
        noiseGain.gain.value = 0;

        applyNoiseHannEnvelope(
            noiseGain.gain,
            noiseTargetGain,
            now,
            blockEndTime
        );

        noiseSource.connect(noiseGain);
        noiseGain.connect(ctx.destination);

        state.activeSources.push(noiseSource);

        const offset = randomNoiseOffset(
            noiseBuffer.duration,
            totalBlockDuration
        );

        noiseSource.start(now, offset);
        noiseSource.stop(blockEndTime);
    }

    /*
     * Die Sprache startet immer erst nach dem Vorlauf.
     * Ohne Störgeräusch ist das eine kürzere stille Pause.
     */
    speechSource.start(speechStartTime);
}
/* ==========================================================================
   Trainingslogik
   ========================================================================== */

async function selectList() {
    const filename = dom.listSelect.value;
    const selectedOption = dom.listSelect.options[dom.listSelect.selectedIndex];

    const label = selectedOption
        ? selectedOption.dataset.label || selectedOption.textContent
        : "";

    stopPlayback();

    if (!filename) {
        resetTrainingButtons();
        showLogoOnly();
        //setInfo("Bitte eine Liste auswählen.");
        setInfo(" ");
        return;
    }

    try {
        const data = await apiPost("/api/select-list", {
            filename,
            label,
        });

        enableStartState();
        showLogoOnly();

        setInfo(`${data.label} ausgewählt – ${data.count} Einträge.`);
    } catch (error) {
        resetTrainingButtons();
        showLogoOnly();
        setInfo(error.message);
    }
}


async function nextSample() {
    try {
        clearSolution();

        const data = await apiPost("/api/next", {
            voice: getVoice(),
        });

        if (!data.ok && data.finished) {
            dom.startLogo.hidden = true;
            dom.solutionText.hidden = false;
            dom.solutionText.textContent = data.message;

            disableTrainingStateAfterFinished();
            return;
        }

        state.currentSample = data.sample;

        await playSample(state.currentSample);

        enableTrainingState();
    } catch (error) {
        setInfo(error.message);
    }
}

async function repeatSample() {
    try {
        const data = await apiPost("/api/repeat", {
            voice: getVoice(),
        });

        state.currentSample = data.sample;

        await playSample(state.currentSample);
    } catch (error) {
        setInfo(error.message);
    }
}


async function startTraining() {
    await nextSample();

    if (state.currentSample) {
        enableTrainingState();
    }
}


async function startOrRepeat() {
    if (!state.hasStarted) {
        await startTraining();
    } else {
        await repeatSample();
    }
}


async function showSolution() {
    try {
        const data = await apiGet("/api/solution");

        if (!data.ok) {
            throw new Error(data.message || "Keine Lösung verfügbar.");
        }

        showSolutionText(data.text);

        dom.solutionButton.disabled = true;
    } catch (error) {
        setInfo(error.message);
    }
}

/* ==========================================================================
   Events
   ========================================================================== */

function registerEventListeners() {
    dom.listSelect.addEventListener("change", async () => {
        saveListPreference();
        await selectList();
    });

    dom.startButton.addEventListener("click", startOrRepeat);
    dom.nextButton.addEventListener("click", nextSample);
    dom.solutionButton.addEventListener("click", showSolution);

    document.querySelectorAll("input[name='voice']").forEach((input) => {
        input.addEventListener("change", saveVoicePreference);
    });

    dom.noiseTypeList.addEventListener("change", () => {
        updateNoiseDifficultyState();
        saveNoisePreference();
    });

    dom.volumeSlider.addEventListener("input", () => {
        if (Number(dom.volumeSlider.value) < MIN_SPEECH_VOLUME_PERCENT) {
            dom.volumeSlider.value = MIN_SPEECH_VOLUME_PERCENT;
        }

        dom.volumeValue.textContent = volumePercent();
    });

    dom.volumeSlider.addEventListener("change", saveVolumePreference);

    dom.difficultySlider.addEventListener("input", updateDifficultyLabel);
    dom.difficultySlider.addEventListener("change", saveDifficultyPreference);

    dom.fontSizeSlider.addEventListener("input", () => {
        dom.solutionText.style.fontSize = `${dom.fontSizeSlider.value}px`;
    });
}

/* ==========================================================================
   Initialisierung
   ========================================================================== */

async function init() {
    registerEventListeners();

    resetTrainingButtons();
    showLogoOnly();

    dom.volumeSlider.value = DEFAULT_SPEECH_VOLUME_PERCENT;
    dom.volumeValue.textContent = volumePercent();

    dom.difficultySlider.value = DEFAULT_DIFFICULTY_DB;
    updateDifficultyLabel();

    dom.solutionText.style.fontSize = `${dom.fontSizeSlider.value}px`;

    try {
        await loadLists();
    } catch (error) {
        setInfo(error.message);
    }

    try {
        await loadNoiseUrls();
    } catch (error) {
        setInfo(error.message);
    }

    await restorePreferencesFromCookies();
}


document.addEventListener("DOMContentLoaded", init);