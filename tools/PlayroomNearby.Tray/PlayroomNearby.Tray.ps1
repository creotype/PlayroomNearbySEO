[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [ValidateSet('Start', 'Stop', 'Restart', 'Exit')]
    [string]$Request = 'Start',
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

Add-Type -Language CSharp -ReferencedAssemblies @(
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Net.Http.dll',
    'System.Windows.Forms.dll'
) -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace PlayroomNearby.TraySupport
{
    public sealed class JobLease : IDisposable
    {
        private const uint KillOnJobClose = 0x00002000;
        private SafeFileHandle handle;

        public JobLease(Process process)
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create Job Object");

            var limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
            int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, pointer, false);
                if (!SetInformationJobObject(handle, 9, pointer, (uint)size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to configure Job Object");
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }

            if (!AssignProcessToJobObject(handle, process.SafeHandle))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to assign Node to Job Object");
        }

        public void Dispose()
        {
            if (handle != null) handle.Dispose();
            handle = null;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            SafeFileHandle job, int informationClass, IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeProcessHandle process);
    }

    public sealed class ProcessLog : IDisposable
    {
        private readonly object sync = new object();
        private StreamWriter writer;

        public ProcessLog(Process process, string path)
        {
            writer = new StreamWriter(new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read));
            writer.AutoFlush = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { Write("OUT", args.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { Write("ERR", args.Data); };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        private void Write(string stream, string line)
        {
            if (line == null) return;
            lock (sync)
            {
                if (writer != null)
                    writer.WriteLine(DateTimeOffset.Now.ToString("O") + " " + stream + " " + line);
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (writer != null) writer.Dispose();
                writer = null;
            }
        }
    }

    public static class Helpers
    {
        private static readonly HttpClient Http = CreateHttpClient();

        private static HttpClient CreateHttpClient()
        {
            var handler = new HttpClientHandler();
            handler.UseProxy = false;
            var client = new HttpClient(handler);
            client.Timeout = TimeSpan.FromMilliseconds(1500);
            return client;
        }

        public static async Task<bool> ProbeReadyAsync(int port)
        {
            try
            {
                using (var response = await Http.GetAsync("http://127.0.0.1:" + port + "/readyz").ConfigureAwait(false))
                {
                    if (!response.IsSuccessStatusCode) return false;
                    string body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    body = body.Replace(" ", "").Replace("\r", "").Replace("\n", "").Replace("\t", "");
                    return body.IndexOf("\"ready\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch
            {
                return false;
            }
        }

        public static Icon CreateIcon(Color color, string glyph)
        {
            using (var bitmap = new Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(bitmap))
            using (var shadow = new SolidBrush(Color.FromArgb(80, 0, 0, 0)))
            using (var fill = new SolidBrush(color))
            using (var border = new Pen(Color.FromArgb(180, 255, 255, 255), 1.2f))
            using (var font = new Font("Segoe UI Symbol", 17, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var text = new SolidBrush(Color.White))
            {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                graphics.FillEllipse(shadow, 3, 4, 27, 27);
                graphics.FillEllipse(fill, 2, 2, 27, 27);
                graphics.DrawEllipse(border, 2.5f, 2.5f, 26, 26);
                SizeF size = graphics.MeasureString(glyph, font);
                graphics.DrawString(glyph, font, text, (32 - size.Width) / 2, (30 - size.Height) / 2);
                IntPtr raw = bitmap.GetHicon();
                try
                {
                    using (var borrowed = Icon.FromHandle(raw)) return (Icon)borrowed.Clone();
                }
                finally
                {
                    DestroyIcon(raw);
                }
            }
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr handle);
    }
}
'@

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $repo 'package.json') -PathType Leaf)) {
    throw "В папке не найден package.json: $repo"
}

$runtimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PlayroomNearbySEO'
$startRequestFile = Join-Path $runtimeRoot 'start.request'
if ($ValidateOnly) {
    Write-Output 'Tray support compiled and validated.'
    return
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\PlayroomNearbySEO.Tray', [ref]$createdNew)
if (-not $createdNew) {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    Set-Content -LiteralPath $startRequestFile -Value $Request.ToLowerInvariant() -Encoding ASCII
    $mutex.Dispose()
    return
}
if ($Request -eq 'Exit') {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
    return
}
Remove-Item -LiteralPath $startRequestFile -Force -ErrorAction SilentlyContinue

$logRoot = Join-Path $runtimeRoot 'logs'
$controllerLog = Join-Path $runtimeRoot 'controller.log'
$stateFile = Join-Path $runtimeRoot 'state.json'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$port = 8080
$environmentFile = Join-Path $repo '.env.local'
if (Test-Path -LiteralPath $environmentFile -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $environmentFile) {
        if ($line -match '^\s*PORT\s*=\s*["'']?(?<port>\d+)') {
            $candidatePort = [int]$Matches.port
            if ($candidatePort -gt 0 -and $candidatePort -le 65535) { $port = $candidatePort }
            break
        }
    }
}

$script:OwnedProcess = $null
$script:JobLease = $null
$script:ProcessLog = $null
$script:HealthTask = $null
$script:NextHealthAt = [DateTime]::MinValue
$script:StartupDeadline = [DateTime]::MinValue
$script:StopDeadline = [DateTime]::MinValue
$script:ReadyChecks = 0
$script:FailedChecks = 0
$script:RecoveryChecks = 0
$script:AfterStop = 'none'
$script:AfterStopError = ''
$script:State = 'Stopped'
$script:Detail = 'Остановлен'
$script:RenderedState = ''
$script:RenderedDetail = ''
$script:AutoStart = $Request -in @('Start', 'Restart')
$script:Exiting = $false

$icons = @{
    Stopped    = [PlayroomNearby.TraySupport.Helpers]::CreateIcon([Drawing.Color]::DimGray, '■')
    Starting   = [PlayroomNearby.TraySupport.Helpers]::CreateIcon([Drawing.Color]::Goldenrod, '…')
    Running    = [PlayroomNearby.TraySupport.Helpers]::CreateIcon([Drawing.Color]::ForestGreen, '✓')
    Stopping   = [PlayroomNearby.TraySupport.Helpers]::CreateIcon([Drawing.Color]::Goldenrod, '■')
    Restarting = [PlayroomNearby.TraySupport.Helpers]::CreateIcon([Drawing.Color]::Goldenrod, '↻')
    Error      = [PlayroomNearby.TraySupport.Helpers]::CreateIcon([Drawing.Color]::Firebrick, '!')
    Conflict   = [PlayroomNearby.TraySupport.Helpers]::CreateIcon([Drawing.Color]::DarkOrange, '!')
}

$statusItem = New-Object Windows.Forms.ToolStripMenuItem('Остановлен')
$statusItem.Enabled = $false
$startItem = New-Object Windows.Forms.ToolStripMenuItem('Запустить')
$stopItem = New-Object Windows.Forms.ToolStripMenuItem('Остановить')
$restartItem = New-Object Windows.Forms.ToolStripMenuItem('Перезапустить')
$exitItem = New-Object Windows.Forms.ToolStripMenuItem('Выход')
$menu = New-Object Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($startItem)
[void]$menu.Items.Add($stopItem)
[void]$menu.Items.Add($restartItem)
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($exitItem)

$notify = New-Object Windows.Forms.NotifyIcon
$notify.ContextMenuStrip = $menu
$notify.Icon = $icons.Stopped
$notify.Text = 'Playroom SEO - Stopped'
$notify.Visible = $true

function Test-OwnedProcessAlive {
    if ($null -eq $script:OwnedProcess) { return $false }
    try { return -not $script:OwnedProcess.HasExited } catch { return $false }
}

function Set-ControllerState([string]$State, [string]$Detail) {
    if ($script:State -ne $State -or $script:Detail -ne $Detail) {
        try {
            New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
            $line = '{0} {1} {2}{3}' -f [DateTimeOffset]::Now.ToString('O'), $State, $Detail, [Environment]::NewLine
            [IO.File]::AppendAllText($controllerLog, $line, [Text.Encoding]::UTF8)
        } catch { }
    }
    $script:State = $State
    $script:Detail = $Detail
}

function Test-PortOccupied {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $port)
        if (-not $task.Wait(700)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Write-StateFile {
    try {
        New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
        [ordered]@{
            pid = $script:OwnedProcess.Id
            started_at = $script:OwnedProcess.StartTime.ToUniversalTime().ToString('O')
            executable = $nodePath
            repository = $repo
        } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    } catch {
        # The live Process object and Job handle, never this file, prove ownership.
    }
}

function Clear-OwnedProcess {
    if ($null -ne $script:ProcessLog) {
        $script:ProcessLog.Dispose()
        $script:ProcessLog = $null
    }
    if ($null -ne $script:JobLease) {
        $script:JobLease.Dispose()
        $script:JobLease = $null
    }
    if ($null -ne $script:OwnedProcess) {
        $script:OwnedProcess.Dispose()
        $script:OwnedProcess = $null
    }
    $script:HealthTask = $null
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
}

function Start-Bot {
    if (Test-OwnedProcessAlive) { return }
    try {
        $required = @('.env.local', 'dist\src\index.js')
        foreach ($relative in $required) {
            if (-not (Test-Path -LiteralPath (Join-Path $repo $relative) -PathType Leaf)) {
                throw "Не найден $relative. Запустите Windows installer повторно."
            }
        }
        if (Test-PortOccupied) {
            Set-ControllerState 'Conflict' "Порт $port занят внешним процессом; он не был остановлен"
            return
        }

        New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
        $logPath = Join-Path $logRoot ('service-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $nodePath
        $startInfo.Arguments = '--env-file=.env.local dist/src/index.js'
        $startInfo.WorkingDirectory = $repo
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardInput = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.EnvironmentVariables['TRAY_MANAGED'] = '1'

        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'Node не запустился.' }
        try {
            $job = [PlayroomNearby.TraySupport.JobLease]::new($process)
            $processLog = [PlayroomNearby.TraySupport.ProcessLog]::new($process, $logPath)
        } catch {
            try { if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(2000) } } catch { }
            $process.Dispose()
            throw
        }

        $script:OwnedProcess = $process
        $script:JobLease = $job
        $script:ProcessLog = $processLog
        $script:StartupDeadline = [DateTime]::UtcNow.AddSeconds(30)
        $script:NextHealthAt = [DateTime]::UtcNow
        $script:ReadyChecks = 0
        $script:FailedChecks = 0
        $script:RecoveryChecks = 0
        $script:AfterStop = 'none'
        Write-StateFile
        Set-ControllerState 'Starting' 'Проверяются интеграции'
    } catch {
        Clear-OwnedProcess
        Set-ControllerState 'Error' ('Ошибка запуска: ' + $_.Exception.Message)
    }
}

function Request-Stop([ValidateSet('stopped', 'restart', 'exit', 'error')][string]$After, [string]$ErrorMessage = '') {
    $script:AfterStop = $After
    $script:AfterStopError = $ErrorMessage
    if (-not (Test-OwnedProcessAlive)) {
        Clear-OwnedProcess
        Complete-AfterStop
        return
    }
    $script:StopDeadline = [DateTime]::UtcNow.AddMinutes(5)
    if ($After -eq 'restart') {
        Set-ControllerState 'Restarting' 'Перезапускается'
    } else {
        Set-ControllerState 'Stopping' 'Останавливается'
    }
    try {
        $script:OwnedProcess.StandardInput.WriteLine('shutdown')
        $script:OwnedProcess.StandardInput.Flush()
    } catch {
        # The timer will terminate only this exact owned process after the deadline.
    }
}

function Complete-AfterStop {
    $action = $script:AfterStop
    $errorMessage = $script:AfterStopError
    $script:AfterStop = 'none'
    $script:AfterStopError = ''
    if ($action -eq 'restart') {
        Start-Bot
    } elseif ($action -eq 'exit') {
        $timer.Stop()
        $notify.Visible = $false
        [Windows.Forms.Application]::ExitThread()
    } elseif ($action -eq 'error') {
        Set-ControllerState 'Error' $errorMessage
    } else {
        Set-ControllerState 'Stopped' 'Остановлен'
    }
}

function Finish-OwnedExit([bool]$Expected) {
    $exitCode = -1
    try { $exitCode = $script:OwnedProcess.ExitCode } catch { }
    Clear-OwnedProcess
    if ($Expected) {
        Complete-AfterStop
    } else {
        Set-ControllerState 'Error' "Node неожиданно завершился (exit code $exitCode)"
    }
}

function Update-HealthProbe {
    if (-not (Test-OwnedProcessAlive)) { return }
    if ($script:State -notin @('Starting', 'Running', 'Error')) { return }

    if ($null -ne $script:HealthTask -and $script:HealthTask.IsCompleted) {
        $ready = $false
        try { $ready = $script:HealthTask.GetAwaiter().GetResult() } catch { }
        $script:HealthTask = $null
        if ($ready) {
            $script:FailedChecks = 0
            $script:ReadyChecks++
            $script:RecoveryChecks++
            if ($script:State -eq 'Starting' -and $script:ReadyChecks -ge 3) {
                Set-ControllerState 'Running' 'Работает'
            } elseif ($script:State -eq 'Error' -and $script:RecoveryChecks -ge 2) {
                Set-ControllerState 'Running' 'Работает'
            }
        } else {
            $script:ReadyChecks = 0
            $script:RecoveryChecks = 0
            $script:FailedChecks++
            if ($script:State -eq 'Running' -and $script:FailedChecks -ge 2) {
                Set-ControllerState 'Error' 'Node запущен, но интеграции не готовы'
            }
        }
    }

    if ($null -eq $script:HealthTask -and [DateTime]::UtcNow -ge $script:NextHealthAt) {
        $script:HealthTask = [PlayroomNearby.TraySupport.Helpers]::ProbeReadyAsync($port)
        $script:NextHealthAt = [DateTime]::UtcNow.AddSeconds(1)
    }
}

function Update-Ui {
    if ($script:RenderedState -eq $script:State -and $script:RenderedDetail -eq $script:Detail) { return }
    $previous = $script:RenderedState
    $script:RenderedState = $script:State
    $script:RenderedDetail = $script:Detail
    $notify.Icon = $icons[$script:State]
    $notify.Text = switch ($script:State) {
        'Running' { 'Playroom SEO - Running' }
        'Starting' { 'Playroom SEO - Starting' }
        'Restarting' { 'Playroom SEO - Restarting' }
        'Stopping' { 'Playroom SEO - Stopping' }
        'Conflict' { 'Playroom SEO - Conflict' }
        'Error' { 'Playroom SEO - Error' }
        default { 'Playroom SEO - Stopped' }
    }
    $owned = Test-OwnedProcessAlive
    $statusItem.Text = if ($owned) { "$($script:Detail) - PID $($script:OwnedProcess.Id)" } else { $script:Detail }
    $changing = $script:State -in @('Starting', 'Stopping', 'Restarting')
    $startItem.Enabled = (-not $owned) -and (-not $changing)
    $stopItem.Enabled = $owned -and $script:State -ne 'Stopping'
    $restartItem.Enabled = $owned -and (-not $changing)
    if ($script:State -in @('Error', 'Conflict') -and $previous -ne $script:State) {
        $notify.ShowBalloonTip(5000, 'Playroom SEO', $script:Detail, [Windows.Forms.ToolTipIcon]::Error)
    }
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if (Test-Path -LiteralPath $startRequestFile -PathType Leaf) {
        $requestedAction = (Get-Content -LiteralPath $startRequestFile -Raw).Trim().ToLowerInvariant()
        Remove-Item -LiteralPath $startRequestFile -Force -ErrorAction SilentlyContinue
        switch ($requestedAction) {
            'stop' { if (Test-OwnedProcessAlive) { Request-Stop 'stopped' } }
            'restart' {
                if (Test-OwnedProcessAlive) { Request-Stop 'restart' } else { Start-Bot }
            }
            'exit' {
                if (Test-OwnedProcessAlive) {
                    Request-Stop 'exit'
                } else {
                    $script:AfterStop = 'exit'
                    Complete-AfterStop
                }
            }
            default { if (-not (Test-OwnedProcessAlive)) { Start-Bot } }
        }
    }

    if ($script:AutoStart) {
        $script:AutoStart = $false
        Start-Bot
    }

    if ($null -ne $script:OwnedProcess) {
        $alive = Test-OwnedProcessAlive
        if (-not $alive) {
            $expected = $script:State -in @('Stopping', 'Restarting')
            Finish-OwnedExit $expected
        } elseif ($script:State -in @('Stopping', 'Restarting') -and [DateTime]::UtcNow -ge $script:StopDeadline) {
            try {
                $script:OwnedProcess.Kill()
                [void]$script:OwnedProcess.WaitForExit(2000)
            } catch { }
            Finish-OwnedExit $true
        } elseif ($script:State -eq 'Starting' -and [DateTime]::UtcNow -ge $script:StartupDeadline) {
            Request-Stop 'error' 'Сервис не стал готов за 30 секунд'
        }
    }

    Update-HealthProbe
    Update-Ui
})

$startItem.Add_Click({ Start-Bot })
$stopItem.Add_Click({ Request-Stop 'stopped' })
$restartItem.Add_Click({
    if (Test-OwnedProcessAlive) { Request-Stop 'restart' } else { Start-Bot }
})
$exitItem.Add_Click({
    if ($script:Exiting) { return }
    $script:Exiting = $true
    $startItem.Enabled = $false
    $stopItem.Enabled = $false
    $restartItem.Enabled = $false
    if (Test-OwnedProcessAlive) {
        Request-Stop 'exit'
    } else {
        $script:AfterStop = 'exit'
        Complete-AfterStop
    }
})

try {
    $timer.Start()
    [Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $notify.Visible = $false
    if (Test-OwnedProcessAlive) {
        try { $script:OwnedProcess.StandardInput.WriteLine('shutdown'); $script:OwnedProcess.StandardInput.Flush() } catch { }
        try { if (-not $script:OwnedProcess.WaitForExit(2000)) { $script:OwnedProcess.Kill() } } catch { }
    }
    Clear-OwnedProcess
    $timer.Dispose()
    $notify.Dispose()
    $menu.Dispose()
    foreach ($icon in $icons.Values) { $icon.Dispose() }
    Remove-Item -LiteralPath $startRequestFile -Force -ErrorAction SilentlyContinue
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}
