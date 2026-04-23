<?php
// Same-origin health proxy for Mission Control frontend.
// Proxies a minimal health check to the configured backend target.

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$defaultTarget = 'https://mission-control-api-mo8l.onrender.com';
$target = isset($_GET['target']) ? trim($_GET['target']) : $defaultTarget;
$path = isset($_GET['path']) ? trim($_GET['path']) : 'config';
$pathMap = [
  'config' => '/api/config',
  'worker-status' => '/api/worker/status'
];
$upstreamPath = $pathMap[$path] ?? null;

if ($upstreamPath === null) {
  http_response_code(400);
  echo json_encode(['ok' => false, 'error' => 'invalid_path']);
  exit;
}

$parts = @parse_url($target);
if (!$parts || !isset($parts['scheme']) || !isset($parts['host'])) {
  http_response_code(400);
  echo json_encode(['ok' => false, 'error' => 'invalid_target']);
  exit;
}

$allowedHosts = [
  'mission-control-api-mo8l.onrender.com',
  'mc-austin-control.loca.lt'
];

if (!in_array(strtolower($parts['host']), $allowedHosts, true)) {
  http_response_code(403);
  echo json_encode(['ok' => false, 'error' => 'target_not_allowed']);
  exit;
}

$url = rtrim($target, '/') . $upstreamPath;
$headers = ['Accept: application/json'];
$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if ($authHeader) {
  $headers[] = 'Authorization: ' . $authHeader;
}
$xWorkerId = $_SERVER['HTTP_X_WORKER_ID'] ?? '';
if ($xWorkerId) {
  $headers[] = 'X-Worker-Id: ' . $xWorkerId;
}

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
curl_setopt($ch, CURLOPT_TIMEOUT, 8);
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
$body = curl_exec($ch);
$errno = curl_errno($ch);
$error = curl_error($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($errno) {
  http_response_code(502);
  echo json_encode([
    'ok' => false,
    'via' => 'health-proxy',
    'target' => $target,
    'path' => $path,
    'error' => 'upstream_connect_failed',
    'detail' => $error
  ]);
  exit;
}

if ($status >= 200 && $status < 300) {
  http_response_code(200);
  echo json_encode([
    'ok' => true,
    'via' => 'health-proxy',
    'target' => $target,
    'path' => $path,
    'upstream_status' => $status,
    'body' => json_decode($body, true)
  ]);
  exit;
}

http_response_code(502);
echo json_encode([
  'ok' => false,
  'via' => 'health-proxy',
  'target' => $target,
  'path' => $path,
  'upstream_status' => $status,
  'error' => 'upstream_unhealthy',
  'body' => json_decode($body, true)
]);
