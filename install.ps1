# Installs or updates Tucano on Windows, in PowerShell:
#   irm https://github.com/eduwxyz/tucano/releases/latest/download/install.ps1 | iex
#
# It downloads the installer of the latest release and runs it without its window: Tucano
# goes into your user's programs (%LOCALAPPDATA%\Programs), with no admin rights, and opens.
# A file PowerShell downloads isn't marked as coming from the internet, so Windows doesn't
# warn about the installer, which isn't code-signed. An open Tucano is asked to quit first,
# as its tray menu does; your data (%APPDATA%\Tucano) stays where it is.
#
# For testing a build before it is released (then the app doesn't open): TUCANO_EXE, the
# installer (a URL or a local file).
#
# Everything runs inside a script block, so an error ends it without closing the
# PowerShell window that `iex` runs it in.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell downloads slowly with a progress bar
  $Latest = 'https://github.com/eduwxyz/tucano/releases/latest/download'

  # Messages in Portuguese on a system set to Portuguese, in English otherwise. This file
  # stays ASCII, since Windows PowerShell reads a download with no charset as Latin-1:
  # accents are written \u00e3 and the like, and {0} takes a value.
  $pt = (Get-UICulture).Name -like 'pt*'
  function Say($p, $e) { $t = [regex]::Unescape($(if ($pt) { $p } else { $e })); if ($args) { $t -f $args } else { $t } }
  function Fail { throw (Say @args) }

  try {
    if ([Environment]::OSVersion.Version.Major -lt 10 -or -not [Environment]::Is64BitOperatingSystem) {
      Fail 'O Tucano roda no Windows 10 ou 11, de 64 bits.' 'Tucano runs on 64-bit Windows 10 or 11.'
    }
    # Windows PowerShell 5.1 may still default to TLS 1.0, which GitHub refuses.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $src = if ($env:TUCANO_EXE) { $env:TUCANO_EXE } else { "$Latest/tucano-win-x64.exe" }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("tucano-" + [Guid]::NewGuid().ToString('N') + '.exe')
    Write-Host (Say 'Baixando o Tucano\u2026' 'Downloading Tucano\u2026')
    if ($src -match '^https?://') {
      # curl.exe (in Windows since 2018) shows how far it got; Invoke-WebRequest otherwise.
      if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        curl.exe -fL --progress-bar -o $tmp $src
        if ($LASTEXITCODE -ne 0) { Fail 'N\u00e3o deu pra baixar {0}.' "Couldn't download {0}." $src }
      } else {
        Invoke-WebRequest -UseBasicParsing -Uri $src -OutFile $tmp
      }
    } else {
      Copy-Item -LiteralPath $src -Destination $tmp
    }

    # Where Tucano is installed, from its entry in Installed apps: the icon is the app's own
    # executable ("C:\...\Tucano.exe,0").
    function Installed {
      $keys = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue
      foreach ($k in $keys) {
        $v = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
        if ($v.DisplayName -notlike 'Tucano*' -or -not $v.DisplayIcon) { continue }
        $exe = ($v.DisplayIcon -replace ',\d+$', '').Trim('"')
        if ((Split-Path -Leaf $exe) -eq 'Tucano.exe' -and (Test-Path -LiteralPath $exe)) { return $exe }
      }
    }
    function Running($exe) { @(Get-Process Tucano -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count -gt 0 }

    # Replacing a running app's files fails: ask it to quit, as its tray menu does.
    $app = Installed
    if ($app -and (Running $app)) {
      Write-Host (Say 'Fechando o app aberto\u2026' 'Closing the running app\u2026')
      Start-Process -FilePath $app -ArgumentList '--quit'
      for ($i = 0; $i -lt 30 -and (Running $app); $i++) { Start-Sleep -Seconds 1 }
      if (Running $app) { Fail 'O app n\u00e3o fechou. Encerre o Tucano (\u00edcone perto do rel\u00f3gio \u203a Encerrar) e rode de novo.' "The app didn't close. Quit Tucano (icon by the clock \u203a Quit) and run this again." }
    }

    Write-Host (Say 'Instalando\u2026' 'Installing\u2026')
    $p = Start-Process -FilePath $tmp -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail 'O instalador parou com o c\u00f3digo {0}.' 'The installer stopped with code {0}.' $p.ExitCode }
    $app = Installed
    if (-not $app) { Fail 'O instalador terminou, mas o Tucano n\u00e3o apareceu nos apps instalados.' "The installer finished, but Tucano isn't in the installed apps." }

    Write-Host (Say 'Instalado em {0}' 'Installed in {0}' $app)
    if (-not $env:TUCANO_EXE) { Start-Process -FilePath $app }
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
  } finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}
