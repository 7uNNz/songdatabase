param([string]$Site = "https://songdatabase-1.onrender.com", [string]$OutputFolder = "$env:USERPROFILE\Downloads")
$ErrorActionPreference = "Stop"
$Site = $Site.TrimEnd('/')
if (!(Test-Path -LiteralPath $OutputFolder)) { throw "找不到備份目的資料夾：$OutputFolder" }
function Get-Utf8Json([string]$Uri) {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 120
    $bytes = $response.RawContentStream.ToArray()
    $decoder = New-Object System.Text.UTF8Encoding($false, $true)
    return ($decoder.GetString($bytes) | ConvertFrom-Json)
}
$songs = New-Object System.Collections.Generic.List[object]
$ids = New-Object System.Collections.Generic.HashSet[string]
$expected = $null
for ($page = 0; ; $page++) {
    $result = Get-Utf8Json "$Site/api/songs?page=$page"
    if ($null -eq $result.songs -or $null -eq $result.total) { throw "網站回傳格式不正確，尚未建立備份。" }
    if ($null -eq $expected) { $expected = [int]$result.total }
    if ([int]$result.total -ne $expected) { throw "匯出時曲庫数量有變更，請暫停編輯並重試。" }
    foreach ($entry in $result.songs) {
        if (!$ids.Add([string]$entry.id)) { throw "匯出時歌曲排序有變更，請暫停編輯並重試。" }
        $id = [Uri]::EscapeDataString([string]$entry.id)
        $detail = Get-Utf8Json "$Site/api/songs?id=$id"
        if ($detail.id -ne $entry.id -or $null -eq $detail.lyrics) { throw "歌曲資料載入失敗，尚未建立備份。" }
        $songs.Add($detail)
        Write-Progress -Activity "備份現有曲庫，包含歌詞" -Status "$($songs.Count) / $expected 首" -PercentComplete ([int](100 * $songs.Count / [Math]::Max(1,$expected)))
    }
    if ($songs.Count -ge $expected) { break }
    if (@($result.songs).Count -eq 0) { throw "歌曲數量不完整，尚未建立備份。" }
}
if ($songs.Count -eq 0) { throw "網站目前沒有歌曲，尚未建立備份。" }
$check = Get-Utf8Json "$Site/api/songs?page=0"
if ([int]$check.total -ne $songs.Count) { throw "匯出過程曲庫有變動，請暫停編輯並重試。" }
$destination = Join-Path $OutputFolder ("pk-library-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
$json = ConvertTo-Json -InputObject @($songs.ToArray()) -Depth 10
[IO.File]::WriteAllText($destination,$json,(New-Object Text.UTF8Encoding($false)))
Write-Progress -Activity "備份現有曲庫，包含歌詞" -Completed
$ready = @($songs | Where-Object { $_.lyrics -and $_.lyrics.Trim() }).Count
Write-Host "備份完成：$destination"
Write-Host "$($songs.Count) 首歌曲，$ready 首有歌詞。請保留這個檔案再部署。"
