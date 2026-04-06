# 测试新的初始化接口
$baseUrl = "http://localhost:60002"
$token = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwibmFtZSI6ImFkbWluIiwiaWF0IjoxNzc1NDUxNzY0LCJleHAiOjE3OTEwMDM3NjR9.CLbqCzyy87RgdGYNX7FaLXF5YB0clOhaFh8PrXgUpNw"

Write-Host "===== 测试新接口 =====" -ForegroundColor Cyan

# 测试 initDebug
Write-Host "`n1. 测试 /game/initDebug" -ForegroundColor Yellow
try {
    $body = @{
        worldId = 1
    } | ConvertTo-Json
    
    $response = Invoke-RestMethod -Uri "$baseUrl/game/initDebug" `
        -Method Post `
        -Headers @{ "Authorization" = $token } `
        -ContentType "application/json" `
        -Body $body
    
    Write-Host "✓ 成功!" -ForegroundColor Green
    Write-Host "返回数据:"
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "✗ 失败: $_" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "错误详情: $responseBody"
    }
}

# 测试 initStory
Write-Host "`n2. 测试 /game/initStory" -ForegroundColor Yellow
try {
    $body = @{
        worldId = 1
        chapterId = 1
    } | ConvertTo-Json
    
    $response = Invoke-RestMethod -Uri "$baseUrl/game/initStory" `
        -Method Post `
        -Headers @{ "Authorization" = $token } `
        -ContentType "application/json" `
        -Body $body
    
    Write-Host "✓ 成功!" -ForegroundColor Green
    Write-Host "返回数据:"
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "✗ 失败: $_" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "错误详情: $responseBody"
    }
}

Write-Host "`n===== 测试完成 =====" -ForegroundColor Cyan
