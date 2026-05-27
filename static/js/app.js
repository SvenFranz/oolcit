"use strict";

const NOISE_PRE_ROLL_SECONDS = 1.0;
const NOISE_POST_ROLL_SECONDS = 1.0;
const NO_NOISE_PAUSE_FACTOR = 0.5;

const MIN_SPEECH_VOLUME_PERCENT = 1;
const DEFAULT_SPEECH_VOLUME_PERCENT = 50;
const DEFAULT_DIFFICULTY_DB = -6;

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const NOISE_FADE_WINDOW_MS = 50;

const START_BUTTON_TEXT = "Start";
const REPEAT_BUTTON_TEXT = "Wiederholen";

const PREF_COOKIE_NAMES = {
    voice: "olcit_voice",
    volume: "olcit_volume",
    list: "olcit_list",
    noise: "olcit_noise",
    difficulty: "olcit_difficulty",
};

/* ==========================================================================
   Zustand
   ========================================================================== */

const state = {
    audioContext: null,
    activeSources: [],

    currentSample: null,
    currentSampleWasPlayed: false,
    solutionVisible: false,

    availableLists: [],
    availableNoises: [],
    noiseUrls: {},

    loadingCounter: 0,
    currentSampleNeedsVoiceRefresh: false,

    /*
     * Cache für bereits geladene und dekodierte Audiodaten.
     *
     * Key:   Audio-URL
     * Value: Promise<AudioBuffer>
     *
     * Wir speichern bewusst Promises, damit dieselbe Datei auch dann
     * nur einmal geladen wird, wenn kurz hintereinander mehrere Anfragen
     * für dieselbe URL kommen.
     */
    audioBufferCache: new Map(),
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

    app: document.querySelector(".app"),
    trainerGrid: document.querySelector(".trainer-grid"),
    loadingOverlay: document.getElementById("loadingOverlay"),
    loadingText: document.getElementById("loadingText"),
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


function getSelectedNoiseUrl() {
    const noiseType = getNoiseType();

    if (!noiseType || noiseType === "none") {
        return null;
    }

    return state.noiseUrls[noiseType] || null;
}


function getSampleAudioUrl(sample) {
    if (!sample) {
        return null;
    }

    /*
     * Dein Backend verwendet aktuell sample.audio_url.
     * Die weiteren Varianten sind nur als robuste Absicherung enthalten.
     */
    return sample.audio_url
        || sample.audioUrl
        || sample.speech_url
        || sample.speechUrl
        || sample.url
        || null;
}


function dbToLinear(db) {
    return Math.pow(10, db / 20);
}


function volumePercent() {
    const value = Number(dom.volumeSlider.value);

    if (!Number.isFinite(value)) {
        return MIN_SPEECH_VOLUME_PERCENT;
    }

    return Math.min(Math.max(value, MIN_SPEECH_VOLUME_PERCENT), 100);
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


function setStartButtonToStart() {
    dom.startButton.textContent = START_BUTTON_TEXT;
}


function setStartButtonToRepeat() {
    dom.startButton.textContent = REPEAT_BUTTON_TEXT;
}


function setAppLoading(active, message = "Bitte warten …") {
    if (active) {
        state.loadingCounter += 1;

        if (dom.loadingText) {
            dom.loadingText.textContent = message;
        }

        if (dom.loadingOverlay) {
            dom.loadingOverlay.hidden = false;
        }

        document.body.classList.add("app-loading");

        if (dom.app) {
            dom.app.setAttribute("aria-busy", "true");
        }

        /*
         * inert verhindert auch Tastaturbedienung während des Ladens.
         */
        if (dom.trainerGrid && "inert" in dom.trainerGrid) {
            dom.trainerGrid.inert = true;
        }

        return;
    }

    state.loadingCounter = Math.max(0, state.loadingCounter - 1);

    if (state.loadingCounter > 0) {
        return;
    }

    if (dom.loadingOverlay) {
        dom.loadingOverlay.hidden = true;
    }

    document.body.classList.remove("app-loading");

    if (dom.app) {
        dom.app.removeAttribute("aria-busy");
    }

    if (dom.trainerGrid && "inert" in dom.trainerGrid) {
        dom.trainerGrid.inert = false;
    }
}


async function withAppLoading(message, task) {
    setAppLoading(true, message);

    try {
        return await task();
    } finally {
        setAppLoading(false);
    }
}


function isAppLoading() {
    return state.loadingCounter > 0;
}

function handleVoiceChange() {
    saveVoicePreference();

    /*
     * Beim Wechsel der Stimme soll die aktuelle Listenposition erhalten bleiben.
     *
     * Wichtig:
     * - currentSample wird NICHT gelöscht.
     * - /api/next darf danach NICHT aufgerufen werden.
     * - stattdessen wird beim nächsten Start /api/repeat mit der neuen Stimme genutzt.
     */
    stopPlayback();

    showLogoOnly();
    setStartButtonToStart();

    if (!dom.listSelect.value) {
        resetTrainingButtons();
        setInfo("Bitte eine Liste auswählen.");
        return;
    }

    if (state.currentSample) {
        /*
         * Es gibt bereits ein aktuelles Item.
         * Genau dieses Item soll mit der neu ausgewählten Stimme
         * erneut geladen und abgespielt werden.
         */
        state.currentSampleWasPlayed = false;
        state.currentSampleNeedsVoiceRefresh = true;
        state.solutionVisible = false;

        dom.startButton.disabled = false;
        dom.nextButton.disabled = true;
        dom.solutionButton.disabled = true;

        setInfo("Stimme geändert – aktuelles Signal wird mit Start neu gesprochen.");
        return;
    }

    /*
     * Falls noch kein aktuelles Sample existiert,
     * z. B. direkt nach Auswahl einer Liste,
     * kann Start normal das erste Signal laden.
     */
    state.currentSampleWasPlayed = false;
    state.currentSampleNeedsVoiceRefresh = false;
    state.solutionVisible = false;

    dom.startButton.disabled = false;
    dom.nextButton.disabled = true;
    dom.solutionButton.disabled = true;

    setInfo("Stimme geändert – bitte Start drücken.");
}

async function loadCurrentSampleWithSelectedVoice() {
    /*
     * Wichtig:
     * /api/repeat soll denselben aktuellen Listeneintrag liefern,
     * aber mit der aktuell gewählten Stimme.
     *
     * Dadurch wird die Liste NICHT weitergeschaltet.
     */
    const data = await apiPost("/api/repeat", {
        voice: getVoice(),
    });

    if (!data.ok) {
        throw new Error(data.message || "Aktuelles Signal konnte nicht mit neuer Stimme geladen werden.");
    }

    state.currentSample = data.sample;
    state.currentSampleWasPlayed = false;
    state.currentSampleNeedsVoiceRefresh = false;
    state.solutionVisible = false;

    return data.sample;
}

/* ==========================================================================
   Cookies
   ========================================================================== */

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

/* ==========================================================================
   Hann-Fade für Störgeräusche
   ========================================================================== */

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
     * Sicherheitsabstand, damit sich setValueCurveAtTime-Intervalle
     * durch Browser-Rundungen nicht überlappen.
     */
    const epsilonSeconds = 0.001;

    const fadeSeconds = Math.min(
        requestedFadeSeconds,
        Math.max(0, (totalDuration - epsilonSeconds) / 2)
    );

    gainParam.cancelScheduledValues(startTime);
    gainParam.value = 0;

    if (fadeSeconds <= 0) {
        gainParam.setValueAtTime(targetGain, startTime);
        return;
    }

    const fadeOutStartTime = endTime - fadeSeconds;

    const fadeInCurve = createHannFadeCurve(targetGain, true);
    const fadeOutCurve = createHannFadeCurve(targetGain, false);

    gainParam.setValueCurveAtTime(
        fadeInCurve,
        startTime,
        fadeSeconds
    );

    gainParam.setValueCurveAtTime(
        fadeOutCurve,
        fadeOutStartTime,
        fadeSeconds
    );
}

/* ==========================================================================
   Button-Zustände
   ========================================================================== */

function resetTrainingButtons() {
    state.currentSample = null;
    state.currentSampleWasPlayed = false;
    state.currentSampleNeedsVoiceRefresh = false;
    state.solutionVisible = false;

    setStartButtonToStart();

    dom.startButton.disabled = true;
    dom.nextButton.disabled = true;
    dom.solutionButton.disabled = true;
}


function enableReadyForFirstStart() {
    state.currentSample = null;
    state.currentSampleWasPlayed = false;
    state.currentSampleNeedsVoiceRefresh = false;
    state.solutionVisible = false;

    setStartButtonToStart();

    dom.startButton.disabled = false;
    dom.nextButton.disabled = true;
    dom.solutionButton.disabled = true;
}


function enableSampleLoadedButNotPlayed() {
    state.currentSampleWasPlayed = false;
    state.solutionVisible = false;

    dom.startButton.textContent = START_BUTTON_TEXT;
    dom.startButton.disabled = false;

    /*
     * "Weiter" soll erst nach dem Anhören des neuen Samples
     * wieder möglich sein.
     */
    dom.nextButton.disabled = true;
    dom.solutionButton.disabled = true;
}


function enableAfterPlayback() {
    state.currentSampleWasPlayed = true;

    setStartButtonToRepeat();

    dom.startButton.disabled = false;
    dom.nextButton.disabled = false;
    dom.solutionButton.disabled = state.solutionVisible;
}


function disableTrainingStateAfterFinished() {
    state.currentSample = null;
    state.currentSampleWasPlayed = false;
    state.currentSampleNeedsVoiceRefresh = false;
    state.solutionVisible = false;

    setStartButtonToStart();

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

    /*
     * Wichtig:
     * Bei /api/next kann data.ok === false mit HTTP 200 zurückkommen,
     * wenn die Liste fertig ist. Deshalb werfen wir nur bei echtem
     * HTTP-Fehler.
     */
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
            /*
             * Quelle war eventuell bereits gestoppt.
             * Das ist unkritisch.
             */
        }
    }

    state.activeSources = [];
}


async function ensureAudioContext() {
    if (!state.audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) {
            throw new Error("Dieser Browser unterstützt die Web Audio API nicht.");
        }

        state.audioContext = new AudioContextClass();
    }

    if (state.audioContext.state === "suspended") {
        await state.audioContext.resume();
    }

    return state.audioContext;
}


function isAudioBufferCached(url) {
    if (!url) {
        return true;
    }

    return state.audioBufferCache.has(url);
}


async function loadAudioBufferCached(url) {
    if (!url) {
        return null;
    }

    if (state.audioBufferCache.has(url)) {
        return await state.audioBufferCache.get(url);
    }

    const promise = (async () => {
        const ctx = await ensureAudioContext();

        const response = await fetch(url, {
            cache: "force-cache",
        });

        if (!response.ok) {
            throw new Error(`Audiodatei konnte nicht geladen werden: ${url}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return await ctx.decodeAudioData(arrayBuffer);
    })();

    state.audioBufferCache.set(url, promise);

    try {
        return await promise;
    } catch (error) {
        /*
         * Falls das Laden oder Dekodieren fehlschlägt,
         * entfernen wir den defekten Cache-Eintrag.
         */
        state.audioBufferCache.delete(url);
        throw error;
    }
}


function playbackNeedsLoading(sample) {
    const speechUrl = getSampleAudioUrl(sample);
    const noiseUrl = getSelectedNoiseUrl();

    if (speechUrl && !isAudioBufferCached(speechUrl)) {
        return true;
    }

    if (noiseUrl && !isAudioBufferCached(noiseUrl)) {
        return true;
    }

    return false;
}


async function preloadSelectedNoiseIfNeeded() {
    const noiseUrl = getSelectedNoiseUrl();

    if (!noiseUrl || isAudioBufferCached(noiseUrl)) {
        return;
    }

    await withAppLoading("Störgeräusch wird geladen …", async () => {
        await loadAudioBufferCached(noiseUrl);
    });
}


async function playSample(sample) {
    stopPlayback();

    const ctx = await ensureAudioContext();

    const speechUrl = getSampleAudioUrl(sample);

    if (!speechUrl) {
        throw new Error("Für dieses Signal wurde keine Audiodatei gefunden.");
    }

    /*
     * Wichtig:
     * Sprachsignal wird aus dem Cache geladen.
     * Falls es noch nicht im Cache ist, wird es genau einmal geladen
     * und dekodiert.
     */
    const speechBuffer = await loadAudioBufferCached(speechUrl);

    const speechSource = ctx.createBufferSource();
    speechSource.buffer = speechBuffer;

    const speechGain = ctx.createGain();
    speechGain.gain.value = volumeLinear();

    speechSource.connect(speechGain);
    speechGain.connect(ctx.destination);

    state.activeSources.push(speechSource);

    const noiseUrl = getSelectedNoiseUrl();
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
        /*
         * Wichtig:
         * Störgeräusch wird ebenfalls aus dem Cache geladen.
         * Schwierigkeit und Lautstärke ändern nur den Gain,
         * nicht die geladene Audiodatei.
         */
        const noiseBuffer = await loadAudioBufferCached(noiseUrl);

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
    speechSource.stop(speechStartTime + speechBuffer.duration);
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
        setInfo(" ");
        return;
    }

    try {
        const data = await withAppLoading("Liste wird geladen …", async () => {
            return await apiPost("/api/select-list", {
                filename,
                label,
            });
        });

        enableReadyForFirstStart();
        showLogoOnly();

        setInfo(`${data.label} ausgewählt – ${data.count} Einträge.`);
    } catch (error) {
        resetTrainingButtons();
        showLogoOnly();
        setInfo(error.message);
    }
}


async function loadNextSample() {
    const data = await apiPost("/api/next", {
        voice: getVoice(),
    });

    if (data.finished || data.ok === false) {
        disableTrainingStateAfterFinished();
        showLogoOnly();
        setInfo(data.message || "Diese Liste ist komplett.");

        return null;
    }

    state.currentSample = data.sample;
    state.currentSampleWasPlayed = false;
    state.currentSampleNeedsVoiceRefresh = false;
    state.solutionVisible = false;

    return data.sample;
}


async function startOrRepeat() {
    if (dom.startButton.disabled || isAppLoading()) {
        return;
    }

    /*
     * Normales Wiederholen:
     * Nur dann aus dem Cache wiederholen, wenn kein Stimmenwechsel aussteht.
     */
    const isRepeat =
        state.currentSample &&
        state.currentSampleWasPlayed &&
        !state.currentSampleNeedsVoiceRefresh;

    try {
        /*
         * AudioContext möglichst unmittelbar nach dem User-Klick aktivieren.
         * Das ist für mobile Browser wichtig.
         */
        await ensureAudioContext();

        if (isRepeat) {
            const repeatTask = async () => {
                dom.startButton.disabled = true;
                dom.solutionButton.disabled = true;

                showLogoOnly();

                await playSample(state.currentSample);

                state.currentSampleWasPlayed = true;
                state.solutionVisible = false;

                enableAfterPlayback();
                setInfo(" ");
            };

            /*
             * Normalerweise ist beim Wiederholen alles bereits im Cache.
             * Falls aber z. B. seit dem letzten Abspielen ein neues
             * Störgeräusch gewählt wurde, kann dafür einmalig noch Laden
             * nötig sein.
             */
            if (playbackNeedsLoading(state.currentSample)) {
                await withAppLoading("Signal wird vorbereitet …", repeatTask);
            } else {
                await repeatTask();
            }

            return;
        }

        await withAppLoading("Signal wird geladen …", async () => {
            dom.startButton.disabled = true;
            dom.solutionButton.disabled = true;

            showLogoOnly();

            let sample = null;

            /*
             * Fall 1:
             * Stimme wurde gewechselt.
             *
             * Dann darf NICHT /api/next aufgerufen werden,
             * weil das die Liste weiterschalten würde.
             *
             * Stattdessen holen wir denselben aktuellen Eintrag
             * mit der neu gewählten Stimme über /api/repeat.
             */
            if (state.currentSample && state.currentSampleNeedsVoiceRefresh) {
                sample = await loadCurrentSampleWithSelectedVoice();
            }

            /*
             * Fall 2:
             * Noch kein aktuelles Sample vorhanden.
             * Dann wird ein neues Sample geladen.
             */
            else if (!state.currentSample) {
                sample = await loadNextSample();
            }

            /*
             * Fall 3:
             * Sample vorhanden, aber noch nicht abgespielt.
             */
            else if (!state.currentSampleWasPlayed) {
                sample = state.currentSample;
            }

            if (!sample) {
                return;
            }

            await playSample(sample);

            state.currentSample = sample;
            state.currentSampleWasPlayed = true;
            state.currentSampleNeedsVoiceRefresh = false;
            state.solutionVisible = false;

            enableAfterPlayback();

            setInfo(" ");
        });
    } catch (error) {
        dom.startButton.disabled = false;

        if (state.currentSampleWasPlayed) {
            dom.nextButton.disabled = false;
            dom.solutionButton.disabled = state.solutionVisible;
            setStartButtonToRepeat();
        } else {
            dom.nextButton.disabled = true;
            dom.solutionButton.disabled = true;
            setStartButtonToStart();
        }

        setInfo(error.message);
    }
}


async function nextSample() {
    if (dom.nextButton.disabled || isAppLoading()) {
        return;
    }

    try {
        /*
         * AudioContext möglichst unmittelbar nach dem User-Klick aktivieren.
         */
        await ensureAudioContext();

        await withAppLoading("Nächstes Signal wird geladen …", async () => {
            stopPlayback();
            showLogoOnly();
            setInfo(" ");

            dom.startButton.disabled = true;
            dom.nextButton.disabled = true;
            dom.solutionButton.disabled = true;

            const sample = await loadNextSample();

            if (!sample) {
                return;
            }

            await playSample(sample);

            state.currentSample = sample;
            state.currentSampleWasPlayed = true;
            state.solutionVisible = false;

            enableAfterPlayback();

            setInfo(" ");
        });
    } catch (error) {
        if (state.currentSample) {
            enableAfterPlayback();
        } else {
            resetTrainingButtons();
        }

        setInfo(error.message);
    }
}


async function showSolution() {
    if (dom.solutionButton.disabled || isAppLoading()) {
        return;
    }

    try {
        await withAppLoading("Lösung wird geladen …", async () => {
            const data = await apiGet("/api/solution");

            if (!data.ok) {
                throw new Error(data.message || "Keine Lösung verfügbar.");
            }

            showSolutionText(data.text);

            dom.solutionButton.disabled = true;
        });
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
        input.addEventListener("change", handleVoiceChange);
    });

    dom.noiseTypeList.addEventListener("change", async () => {
        updateNoiseDifficultyState();
        saveNoisePreference();

        /*
         * Optionales Vorladen:
         * Wenn ein Störgeräusch ausgewählt wird, laden wir es direkt einmalig.
         * Dadurch ist beim nächsten Start/Wiederholen meist keine Wartezeit mehr nötig.
         *
         * Bei "ohne" passiert nichts.
         * Bei bereits gecachter Datei passiert ebenfalls nichts.
         */
        try {
            await preloadSelectedNoiseIfNeeded();
        } catch (error) {
            setInfo(error.message);
        }
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
        await withAppLoading("App wird vorbereitet …", async () => {
            await loadLists();
            await loadNoiseUrls();
            await restorePreferencesFromCookies();
        });
    } catch (error) {
        resetTrainingButtons();
        showLogoOnly();
        setInfo(error.message);
    }
}

document.addEventListener("DOMContentLoaded", init);