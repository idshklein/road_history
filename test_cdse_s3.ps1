[CmdletBinding()]
param(
    [string]$CredentialsFile = (Join-Path $PSScriptRoot 's3_keys.txt'),
    [string]$DuckDb = 'duckdb',
    [double[]]$Bbox = @(35.15, 31.70, 35.25, 31.80),
    [string]$DateTime = '2025-01-01T00:00:00Z/2025-12-31T23:59:59Z'
)

$ErrorActionPreference = 'Stop'

function Get-CredentialValue {
    param(
        [string]$Content,
        [string]$Label
    )

    $pattern = "(?im)^\s*$([regex]::Escape($Label))\s*\r?`n\s*(?<value>\S+)"
    $match = [regex]::Match($Content, $pattern)

    if (-not $match.Success) {
        throw "Could not find '$Label' in $CredentialsFile."
    }

    return $match.Groups['value'].Value
}

if (-not (Test-Path -LiteralPath $CredentialsFile -PathType Leaf)) {
    throw "Credentials file not found: $CredentialsFile"
}

$credentials = Get-Content -LiteralPath $CredentialsFile -Raw
$env:AWS_ACCESS_KEY_ID = Get-CredentialValue -Content $credentials -Label 'Access key'
$env:AWS_SECRET_ACCESS_KEY = Get-CredentialValue -Content $credentials -Label 'Secret key'

$stacRequest = @{
    collections = @('sentinel-2-l2a')
    bbox        = $Bbox
    datetime    = $DateTime
    limit       = 1
} | ConvertTo-Json -Compress

try {
    $stacResponse = Invoke-RestMethod `
        -Method Post `
        -Uri 'https://stac.dataspace.copernicus.eu/v1/search' `
        -ContentType 'application/json' `
        -Body $stacRequest

    $scene = $stacResponse.features | Select-Object -First 1
    if ($null -eq $scene) {
        throw 'The STAC search returned no Sentinel-2 L2A scenes for the supplied AOI and date range.'
    }

    $b04 = $scene.assets.B04_10m.href
    $b08 = $scene.assets.B08_10m.href
    if ([string]::IsNullOrWhiteSpace($b04) -or [string]::IsNullOrWhiteSpace($b08)) {
        throw 'The returned scene does not contain both B04_10m and B08_10m assets.'
    }

    [pscustomobject]@{
        ItemId     = $scene.id
        DateTime   = $scene.properties.datetime
        CloudCover = $scene.properties.'eo:cloud_cover'
        B04_10m    = $b04
        B08_10m    = $b08
    } | Format-List

$sql = @"
INSTALL httpfs;
LOAD httpfs;

CREATE OR REPLACE SECRET cdse_s3 (
    TYPE s3,
    PROVIDER credential_chain,
    CHAIN 'env',
    REGION 'us-east-1',
    ENDPOINT 'eodata.dataspace.copernicus.eu',
    URL_STYLE 'path',
    USE_SSL true
);

SELECT file
FROM glob('$b04')
LIMIT 1;
"@

    Write-Host 'Testing DuckDB access to the returned B04_10m S3 asset.'
    $sql | & $DuckDb ':memory:'

    if ($LASTEXITCODE -ne 0) {
        throw "DuckDB exited with code $LASTEXITCODE."
    }

    Write-Host 'Milestone 1 succeeded: STAC discovery and DuckDB S3 access are working.'
}
finally {
    Remove-Item Env:AWS_ACCESS_KEY_ID -ErrorAction SilentlyContinue
    Remove-Item Env:AWS_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
}