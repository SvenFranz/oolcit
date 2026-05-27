<?php

declare(strict_types=1);

session_start([
    'cookie_httponly' => true,
    'cookie_samesite' => 'Lax',
]);

$BASE_DIR = dirname(__DIR__);
$DATA_DIR = $BASE_DIR . '/data';
$AUDIO_DIR = $DATA_DIR . '/audio';
$LIST_DIR = $AUDIO_DIR . '/lists';
$NOISE_DIR = $AUDIO_DIR . '/noise';
$LIST_MAPPING_FILE = $AUDIO_DIR . '/list_mapping.dat';

$LIST_EXTENSIONS = ['dat'];
$AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a'];

function starts_with_string(string $haystack, string $needle): bool
{
    return strncmp($haystack, $needle, strlen($needle)) === 0;
}

function abort_response(int $code): void
{
    http_response_code($code);

    echo match ($code) {
        400 => '400 Bad Request',
        403 => '403 Forbidden',
        404 => '404 Not Found',
        405 => '405 Method Not Allowed',
        default => 'Error',
    };

    exit;
}

function json_response(array $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');

    echo json_encode(
        $data,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );

    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');

    if ($raw === false || trim($raw) === '') {
        return [];
    }

    $data = json_decode($raw, true);

    if (!is_array($data)) {
        return [];
    }

    return $data;
}

function parse_float_value(string $value): ?float
{
    $value = trim(str_replace(',', '.', $value));

    if ($value === '') {
        return null;
    }

    if (!is_numeric($value)) {
        return null;
    }

    return (float) $value;
}

function parse_sample_line(string $line): ?array
{
    $line = trim($line);

    if ($line === '') {
        return null;
    }

    if (starts_with_string($line, '#')) {
        return null;
    }

    $parts = array_map('trim', explode(';', $line, 5));

    if (count($parts) < 5) {
        return null;
    }

    return [
        'text' => $parts[4],
        'female_path' => $parts[0],
        'male_path' => $parts[1],
        'female_rms' => parse_float_value($parts[2]),
        'male_rms' => parse_float_value($parts[3]),
    ];
}

function safe_list_file(string $filename): string
{
    global $LIST_DIR, $LIST_EXTENSIONS;

    $base = realpath($LIST_DIR);

    if ($base === false) {
        abort_response(404);
    }

    $candidate = realpath($LIST_DIR . '/' . $filename);

    if ($candidate === false) {
        abort_response(404);
    }

    if (!starts_with_string($candidate, $base . DIRECTORY_SEPARATOR)) {
        abort_response(403);
    }

    if (!is_file($candidate)) {
        abort_response(404);
    }

    $extension = strtolower(pathinfo($candidate, PATHINFO_EXTENSION));

    if (!in_array($extension, $LIST_EXTENSIONS, true)) {
        abort_response(400);
    }

    return $candidate;
}

function load_samples_from_file(string $filename): array
{
    $list_file = safe_list_file($filename);
    $samples = [];

    $lines = file($list_file, FILE_IGNORE_NEW_LINES);

    if ($lines === false) {
        return [];
    }

    foreach ($lines as $line) {
        $sample = parse_sample_line($line);

        if ($sample !== null) {
            $samples[] = $sample;
        }
    }

    return $samples;
}

function parse_list_mapping_line(string $line): ?array
{
    $line = trim($line);

    if ($line === '') {
        return null;
    }

    if (starts_with_string($line, '#')) {
        return null;
    }

    $parts = array_map('trim', explode(';', $line, 2));

    if (count($parts) !== 2) {
        return null;
    }

    $filename = $parts[0];
    $label = $parts[1];

    if (!str_ends_with(strtolower($filename), '.dat')) {
        return null;
    }

    return [
        'id' => $filename,
        'filename' => $filename,
        'label' => $label,
    ];
}

function discover_lists(): array
{
    global $LIST_MAPPING_FILE, $LIST_DIR, $LIST_EXTENSIONS;

    if (!file_exists($LIST_MAPPING_FILE)) {
        return [];
    }

    $result = [];
    $lines = file($LIST_MAPPING_FILE, FILE_IGNORE_NEW_LINES);

    if ($lines === false) {
        return [];
    }

    foreach ($lines as $line) {
        $entry = parse_list_mapping_line($line);

        if ($entry === null) {
            continue;
        }

        $list_path = $LIST_DIR . '/' . $entry['filename'];

        if (!file_exists($list_path)) {
            continue;
        }

        if (!is_file($list_path)) {
            continue;
        }

        $extension = strtolower(pathinfo($list_path, PATHINFO_EXTENSION));

        if (!in_array($extension, $LIST_EXTENSIONS, true)) {
            continue;
        }

        $result[] = $entry;
    }

    return $result;
}

function sample_audio_path(array $sample, string $voice): string
{
    if ($voice === 'male') {
        return $sample['male_path'];
    }

    return $sample['female_path'];
}

function sample_rms_value(array $sample, string $voice): ?float
{
    if ($voice === 'male') {
        return $sample['male_rms'];
    }

    return $sample['female_rms'];
}

function media_url(string $rel_path): string
{
    $parts = explode('/', $rel_path);
    $encoded = array_map('rawurlencode', $parts);

    return '/media/' . implode('/', $encoded);
}

function sample_to_payload(array $sample, int $index, string $voice, bool $reveal_text = false): array
{
    $audio_rel = sample_audio_path($sample, $voice);

    $payload = [
        'index' => $index,
        'audio_url' => media_url($audio_rel),
        'rms' => sample_rms_value($sample, $voice),
    ];

    if ($reveal_text) {
        $payload['text'] = $sample['text'];
    }

    return $payload;
}

function prettify_noise_label(string $stem): string
{
    $replacements = [
        'white_noise' => 'Rauschen',
        'noise' => 'Rauschen',
        'refactory' => 'Mensa/Café',
        'cafeteria' => 'Mensa/Café',
        'mensa' => 'Mensa/Café',
        'street' => 'Straßenlärm',
        'street_noise' => 'Straßenlärm',
    ];

    $key = strtolower($stem);

    if (isset($replacements[$key])) {
        return $replacements[$key];
    }

    return ucwords(str_replace(['_', '-'], ' ', $stem));
}

function discover_noises(): array
{
    global $BASE_DIR, $NOISE_DIR, $AUDIO_EXTENSIONS;

    if (!is_dir($NOISE_DIR)) {
        return [];
    }

    $files = scandir($NOISE_DIR);

    if ($files === false) {
        return [];
    }

    sort($files);

    $noises = [];

    foreach ($files as $file) {
        if ($file === '.' || $file === '..') {
            continue;
        }

        $path = $NOISE_DIR . '/' . $file;

        if (!is_file($path)) {
            continue;
        }

        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));

        if (!in_array($extension, $AUDIO_EXTENSIONS, true)) {
            continue;
        }

        $relative = str_replace($BASE_DIR . '/', '', $path);
        $relative = str_replace(DIRECTORY_SEPARATOR, '/', $relative);

        $stem = pathinfo($path, PATHINFO_FILENAME);

        $noises[] = [
            'id' => $stem,
            'label' => prettify_noise_label($stem),
            'path' => $relative,
            'url' => media_url($relative),
        ];
    }

    return $noises;
}

function safe_media_path(string $rel_path): string
{
    global $BASE_DIR;

    $base = realpath($BASE_DIR);

    if ($base === false) {
        abort_response(404);
    }

    $candidate = realpath($BASE_DIR . '/' . $rel_path);

    if ($candidate === false) {
        abort_response(404);
    }

    if (!starts_with_string($candidate, $base . DIRECTORY_SEPARATOR)) {
        abort_response(403);
    }

    if (!is_file($candidate)) {
        abort_response(404);
    }

    return $candidate;
}

function send_media_file(string $path): void
{
    if (!is_file($path)) {
        abort_response(404);
    }

    $mime = mime_content_type($path);

    if ($mime === false) {
        $mime = 'application/octet-stream';
    }

    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($path));
    header('Accept-Ranges: bytes');

    readfile($path);
    exit;
}

function render_template_index(): void
{
    global $BASE_DIR;

    $template_file = $BASE_DIR . '/templates/index.html';

    if (!is_file($template_file)) {
        abort_response(404);
    }

    $html = file_get_contents($template_file);

    if ($html === false) {
        abort_response(500);
    }

    $html = str_replace(
        '{{ title }}',
        'OLCIT – Oldenburger CI-Trainer',
        $html
    );

    $html = preg_replace_callback(
        "/{{\\s*url_for\\('static',\\s*filename='([^']+)'\\)\\s*}}/",
        function (array $matches): string {
            return '/static/' . ltrim($matches[1], '/');
        },
        $html
    );

    header('Content-Type: text/html; charset=utf-8');
    echo $html;
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if ($path === false || $path === null) {
    $path = '/';
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/*
|--------------------------------------------------------------------------
| Statische Dateien minimalinvasiv aus /static ausliefern
|--------------------------------------------------------------------------
| Der PHP-Built-in-Server liefert vorhandene Dateien selbst aus,
| wenn dieses Router-Script "false" zurückgibt.
*/
if (starts_with_string($path, '/static/')) {
    $file = $BASE_DIR . $path;

    if (is_file($file)) {
        return false;
    }

    abort_response(404);
}

/*
|--------------------------------------------------------------------------
| Direkten Zugriff auf /data blockieren
|--------------------------------------------------------------------------
| Audiodateien sollen nur über /media/... ausgeliefert werden.
*/
if (starts_with_string($path, '/data/')) {
    abort_response(403);
}

if ($method === 'GET' && $path === '/') {
    render_template_index();
}

if ($method === 'GET' && starts_with_string($path, '/media/')) {
    $rel_path = urldecode(substr($path, strlen('/media/')));
    $file = safe_media_path($rel_path);
    send_media_file($file);
}

if ($method === 'GET' && $path === '/api/lists') {
    $lists = discover_lists();

    json_response([
        'lists' => array_map(
            fn ($entry) => [
                'id' => $entry['id'],
                'filename' => $entry['filename'],
                'label' => $entry['label'],
            ],
            $lists
        ),
    ]);
}

if ($method === 'GET' && $path === '/api/noises') {
    json_response([
        'noises' => discover_noises(),
    ]);
}

if ($method === 'POST' && $path === '/api/select-list') {
    $data = read_json_body();

    $filename = $data['filename'] ?? null;
    $label = $data['label'] ?? '';

    if (!$filename) {
        $_SESSION['selected_filename'] = null;
        $_SESSION['selected_label'] = null;
        $_SESSION['remaining_indices'] = [];
        $_SESSION['current_index'] = null;

        json_response([
            'ok' => false,
            'message' => 'Keine Liste ausgewählt.',
        ], 400);
    }

    $available = discover_lists();
    $allowed_filenames = array_map(fn ($entry) => $entry['filename'], $available);

    if (!in_array($filename, $allowed_filenames, true)) {
        json_response([
            'ok' => false,
            'message' => 'Diese Liste ist nicht in der Zuordnungsdatei eingetragen.',
        ], 400);
    }

    $samples = load_samples_from_file($filename);

    if (count($samples) === 0) {
        $_SESSION['selected_filename'] = null;
        $_SESSION['selected_label'] = null;
        $_SESSION['remaining_indices'] = [];
        $_SESSION['current_index'] = null;

        json_response([
            'ok' => false,
            'message' => 'Die ausgewählte Liste ist leer oder konnte nicht gelesen werden.',
        ], 400);
    }

    $indices = range(0, count($samples) - 1);
    shuffle($indices);

    $_SESSION['selected_filename'] = $filename;
    $_SESSION['selected_label'] = $label;
    $_SESSION['remaining_indices'] = $indices;
    $_SESSION['current_index'] = null;

    json_response([
        'ok' => true,
        'filename' => $filename,
        'label' => $label,
        'count' => count($samples),
    ]);
}

if ($method === 'POST' && $path === '/api/next') {
    $filename = $_SESSION['selected_filename'] ?? null;
    $remaining = $_SESSION['remaining_indices'] ?? [];

    if (!$filename) {
        json_response([
            'ok' => false,
            'message' => 'Bitte zuerst eine Liste auswählen.',
        ], 400);
    }

    $samples = load_samples_from_file($filename);

    if (count($remaining) === 0) {
        $_SESSION['current_index'] = null;

        json_response([
            'ok' => false,
            'finished' => true,
            'message' => 'Diese Liste ist komplett, bitte wählen Sie die nächste Liste aus.',
        ]);
    }

    $data = read_json_body();
    $voice = $data['voice'] ?? 'female';

    $index = array_shift($remaining);

    $_SESSION['remaining_indices'] = $remaining;
    $_SESSION['current_index'] = $index;

    $sample = $samples[$index];

    json_response([
        'ok' => true,
        'finished' => false,
        'sample' => sample_to_payload($sample, $index, $voice, false),
        'remaining' => count($remaining),
    ]);
}

if ($method === 'POST' && $path === '/api/repeat') {
    $filename = $_SESSION['selected_filename'] ?? null;
    $current_index = $_SESSION['current_index'] ?? null;

    if ($filename === null || $current_index === null) {
        json_response([
            'ok' => false,
            'message' => 'Es gibt aktuell kein Sample zum Wiederholen.',
        ], 400);
    }

    $samples = load_samples_from_file($filename);

    if ($current_index < 0 || $current_index >= count($samples)) {
        json_response([
            'ok' => false,
            'message' => 'Ungültiger Sample-Index.',
        ], 400);
    }

    $data = read_json_body();
    $voice = $data['voice'] ?? 'female';

    $sample = $samples[$current_index];

    json_response([
        'ok' => true,
        'sample' => sample_to_payload($sample, $current_index, $voice, false),
    ]);
}

if ($method === 'GET' && $path === '/api/solution') {
    $filename = $_SESSION['selected_filename'] ?? null;
    $current_index = $_SESSION['current_index'] ?? null;

    if ($filename === null || $current_index === null) {
        json_response([
            'ok' => false,
            'message' => 'Keine Lösung verfügbar.',
        ], 400);
    }

    $samples = load_samples_from_file($filename);

    if ($current_index < 0 || $current_index >= count($samples)) {
        json_response([
            'ok' => false,
            'message' => 'Ungültiger Sample-Index.',
        ], 400);
    }

    json_response([
        'ok' => true,
        'text' => $samples[$current_index]['text'],
    ]);
}

abort_response(404);