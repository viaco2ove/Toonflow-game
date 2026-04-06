# 测试新的初始化接口
$baseUrl = "http://localhost:60002"
$token = "test-token-123"  # 替换为实际token

Write-Host "===== 测试调试模式初始化接口 =====" -ForegroundColor Cyan

# 测试 initDebug
Write-Host "`n1. 测试 /game/initDebug" -ForegroundColor Yellow
try {
    $body = @{
        worldId = 1
    } | ConvertTo-Json
    
    $response = Invoke-RestMethod -Uri "$baseUrl/game/initDebug" `
        -Method Post `
        -Headers @{ "Authorization" = "Bearer $token" } `
        -ContentType "application/json" `
        -Body $body
    
    Write-Host "成功!" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "失败: $_" -ForegroundColor Red
    Write-Host $_.Exception.Message
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
        -Headers @{ "Authorization" = "Bearer $token" } `
        -ContentType "application/json" `
        -Body $body
    
    Write-Host "成功!" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "失败: $_" -ForegroundColor Red
    Write-Host $_.Exception.Message
}

Write-Host "`n===== 测试完成 =====" -ForegroundColor Cyan
