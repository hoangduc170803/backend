param(
  [string]$BaseUrl = 'http://127.0.0.1:3000/api',
  [int]$IntervalMs = 1000,
  [int]$IdleMinutes = 10
)

$ErrorActionPreference = 'Stop'
$token = $env:WES_CARGO_API_TEST_TOKEN
Remove-Item Env:WES_CARGO_API_TEST_TOKEN -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($token)) { throw 'WES_CARGO_API_TEST_TOKEN is required.' }
$headers = @{ Authorization = "Bearer $token" }
$points = @()
$stores = @()
$lastRefresh = [datetime]::MinValue
$lastFingerprint = $null
$lastChange = [datetime]::UtcNow
$lastAudit = [datetime]::MinValue
$sequence = 0
$tag = [datetime]::UtcNow.ToString('yyyyMMddHHmmss')

function Get-Api([string]$path) {
  Invoke-RestMethod -Method Get -Uri "$BaseUrl$path" -Headers $headers -TimeoutSec 15
}

function Post-Api([string]$path, [object]$body) {
  Invoke-RestMethod -Method Post -Uri "$BaseUrl$path" -Headers $headers -Body ($body | ConvertTo-Json -Compress -Depth 5) -ContentType 'application/json' -TimeoutSec 20
}

function Refresh-Candidates {
  $zones = Get-Api '/zones'
  $locations = Get-Api '/operating/plant-model/locations'
  $pickup = @($zones | Where-Object { $_.type -eq 'PICKUP' -and $_.status -eq 'ACTIVE' })
  $script:stores = @($zones | Where-Object { $_.type -eq 'DROPOFF' -and $_.status -eq 'ACTIVE' })
  $names = @($pickup | ForEach-Object { $_.members } | ForEach-Object { $_.locationName })
  $script:points = @($locations | Where-Object { $names -contains $_.name } | ForEach-Object { $_.pointNames } | Where-Object { $_ } | Sort-Object -Unique)
  $script:lastRefresh = [datetime]::UtcNow
}

function Remove-Done([object[]]$cargos, [string]$storeId = '') {
  $ids = @($cargos | Where-Object {
    $_.status -eq 'DONE' -and $_.onLoadedMap -ne $false -and
    (-not $storeId -or $_.targetStoreAreaWesId -eq $storeId)
  } | ForEach-Object { $_.cargoId })
  $deleted = 0
  for ($i = 0; $i -lt $ids.Count; $i += 200) {
    $end = [Math]::Min($i + 199, $ids.Count - 1)
    $result = Post-Api '/operating/cargo/delete' @{ ids = @($ids[$i..$end]) }
    $deleted += @($result.results | Where-Object { $_.outcome -eq 'deleted' }).Count
  }
  return $deleted
}

while ($true) {
  $tick = [datetime]::UtcNow
  try {
    if (($tick - $lastRefresh).TotalSeconds -ge 30 -or $points.Count -eq 0 -or $stores.Count -eq 0) { Refresh-Candidates }
    if ($points.Count -gt 0 -and $stores.Count -gt 0) {
      $list = Get-Api '/operating/cargo'
      $cargos = @($list.cargos)
      if (($tick - $lastAudit).TotalSeconds -ge 10) {
        $fingerprint = (@($cargos | Sort-Object cargoId | ForEach-Object { $_.cargoId + ':' + $_.status + ':' + $_.updatedAt }) -join '|')
        if ($null -ne $lastFingerprint -and $fingerprint -ne $lastFingerprint) { $lastChange = $tick }
        $lastFingerprint = $fingerprint
        $lastAudit = $tick
      }
      $fullOfFinished = @($stores | Where-Object {
        $storeId = $_.id
        $capacity = [int]$_.totalSlotCount
        $capacity -gt 0 -and @($cargos | Where-Object {
          $_.targetStoreAreaWesId -eq $storeId -and $_.status -eq 'DONE'
        }).Count -ge $capacity
      })
      $idle = ($tick - $lastChange).TotalMinutes -ge $IdleMinutes
      if ($fullOfFinished.Count -gt 0 -or $idle) {
        $deleted = 0
        if ($idle) {
          $deleted = Remove-Done $cargos
        } else {
          foreach ($store in $fullOfFinished) { $deleted += Remove-Done $cargos $store.id }
        }
        if ($deleted -gt 0) {
          $lastChange = [datetime]::UtcNow
          $lastFingerprint = $null
          $lastRefresh = [datetime]::MinValue
        } elseif ($idle) {
          # Nothing finished can be removed; retry creation until the next idle check.
          $lastChange = [datetime]::UtcNow
        }
      } else {
        $busy = @($cargos | Where-Object { $_.status -in @('QUEUED','BLOCKED','PICK_PENDING','PICKING') -and $_.pickupPointName } | ForEach-Object { $_.pickupPointName })
        $available = @($points | Where-Object { $busy -notcontains $_ })
        $sourceOrder = if ($available.Count -gt 0) { @($available | Get-Random -Count ([Math]::Min($available.Count, 20))) } else { @() }
        $storeOrder = @($stores | Get-Random -Count $stores.Count)
        $created = $false
        foreach ($point in $sourceOrder) {
          foreach ($store in $storeOrder) {
            $sequence++
            $code = 'LOADTEST-' + $tag + '-' + $sequence.ToString('D6')
            try {
              $null = Post-Api '/operating/cargo' @{ cargoId = $code; pickupPointName = $point; targetStoreAreaWesId = $store.id }
              $created = $true
              $lastChange = [datetime]::UtcNow
              break
            } catch {
              if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { throw }
            }
          }
          if ($created) { break }
        }
      }
    }
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { throw }
    Write-Warning $_.Exception.Message
  }
  $delay = [Math]::Max(0, $IntervalMs - [int](([datetime]::UtcNow - $tick).TotalMilliseconds))
  Start-Sleep -Milliseconds $delay
}
