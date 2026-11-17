# Serves this folder on http://localhost and opens it in the default browser.
# The page must be loaded over http (not by double-clicking index.html).
param([int]$Port = 8791, [switch]$NoBrowser)

$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$types = @{
  ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".css" = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"; ".wasm" = "application/wasm"; ".bin" = "application/octet-stream"
  ".png" = "image/png"; ".svg" = "image/svg+xml"; ".wav" = "audio/wav"; ".txt" = "text/plain; charset=utf-8"
  ".md" = "text/plain; charset=utf-8"; ".webmanifest" = "application/manifest+json"
}

$listener = $null
foreach ($p in $Port..($Port + 9)) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l
    $Port = $p
    break
  } catch { }
}
if ($null -eq $listener) { Write-Host "Could not open a local port ($Port-$($Port + 9))."; exit 1 }

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  Fable 5.2 challenge page is running at $url"
Write-Host "  Keep this window open while you play. Close it to stop."
Write-Host ""
if (-not $NoBrowser) { Start-Process $url }

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path.EndsWith("/")) { $path += "index.html" }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart("/")))
    $inside = $file.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    if ($inside -and (Test-Path -LiteralPath $file -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
      if ($types.ContainsKey($ext)) { $ctx.Response.ContentType = $types[$ext] } else { $ctx.Response.ContentType = "application/octet-stream" }
      $ctx.Response.Headers["Cache-Control"] = "no-store"
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch { }
  } finally {
    try { $ctx.Response.Close() } catch { }
  }
}
