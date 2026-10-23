# Windows PowerShell 5.1: expose the response size before streaming the body.
# Runs inside the same supervisor-owned process/Job and staging directory.
function Save-DshRuntime([string] $Uri) {
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.AllowAutoRedirect = $false
    $request.Timeout = 240000
    $request.ReadWriteTimeout = 240000
    $response = $null
    $inputStream = $null
    $outputStream = $null
    try {
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { throw 'Unexpected download status' }
        $headers = "HTTP/1.1 200`r`n"
        if ($response.ContentLength -gt 0) {
            $headers += "Content-Length: $($response.ContentLength)`r`n"
        }
        Set-Content -LiteralPath download.headers -Value $headers -Encoding ASCII
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open('runtime.zip', [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $inputStream.CopyTo($outputStream)
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}
