function ConvertTo-M1bWindowsArgument([string]$Value) {
  $m1bEscaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $m1bEscaped = [regex]::Replace($m1bEscaped, '(\\+)$', '$1$1')
  return '"' + $m1bEscaped + '"'
}

function Invoke-M1bNativeProcess {
  param([string]$FilePath, [string[]]$ArgumentList, [string]$LogPath, [string]$Stage)
  $m1bInfo = New-Object System.Diagnostics.ProcessStartInfo
  $m1bInfo.FileName = $FilePath
  $m1bInfo.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-M1bWindowsArgument $_ }) -join ' ')
  $m1bInfo.UseShellExecute = $false
  $m1bInfo.CreateNoWindow = $true
  $m1bInfo.RedirectStandardOutput = $true
  $m1bInfo.RedirectStandardError = $true
  $m1bProcess = New-Object System.Diagnostics.Process
  $m1bProcess.StartInfo = $m1bInfo
  $m1bOut = $null; $m1bErr = $null; $m1bStarted = $false
  try {
    # Separate byte streams: no NativeCommandError translation or interleaving.
    # CreateNew preserves every previous attempt's private output.
    $m1bOut = [IO.File]::Open($LogPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $m1bErrPath = $LogPath + '.stderr'
    $m1bErr = [IO.File]::Open($m1bErrPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    if (-not $m1bProcess.Start()) { throw 'Native process did not start' }
    $m1bStarted = $true
    $m1bOutTask = $m1bProcess.StandardOutput.BaseStream.CopyToAsync($m1bOut)
    $m1bErrTask = $m1bProcess.StandardError.BaseStream.CopyToAsync($m1bErr)
    $m1bTimer = [Diagnostics.Stopwatch]::StartNew()
    $m1bNextNotice = 30
    Write-Host ('[' + $Stage + '] started; private logs capture stdout/stderr.')
    while (-not $m1bProcess.WaitForExit(1000)) {
      if ($m1bOutTask.IsFaulted -or $m1bErrTask.IsFaulted) { throw 'Private output capture failed' }
      if ($m1bTimer.Elapsed.TotalSeconds -ge $m1bNextNotice) {
        Write-Host ('[' + $Stage + '] still running; elapsed ' + [int]$m1bTimer.Elapsed.TotalSeconds + ' seconds.')
        $m1bNextNotice += 30
      }
    }
    $m1bOutTask.GetAwaiter().GetResult()
    $m1bErrTask.GetAwaiter().GetResult()
    $m1bOut.Flush(); $m1bErr.Flush()
    return [pscustomobject]@{ ExitCode=$m1bProcess.ExitCode; Stdout=$LogPath; Stderr=$m1bErrPath }
  } finally {
    if ($m1bStarted -and -not $m1bProcess.HasExited) {
      # Only the exact process created by this invocation is eligible for stop.
      # A later recovery must still check for a surviving Docker plugin worker.
      try { $m1bProcess.Kill(); $m1bProcess.WaitForExit(5000) | Out-Null } catch { }
    }
    if ($m1bOut) { $m1bOut.Dispose() }
    if ($m1bErr) { $m1bErr.Dispose() }
    $m1bProcess.Dispose()
  }
}
