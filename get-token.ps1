Add-Type -AssemblyName "System.Data.SQLite"
$conn = [System.Data.SQLite.SQLiteConnection]::new("Data Source=D:\Users\viaco\tools\Toonflow-game\toonflow-app-run-db\db.sqlite;Version=3;")
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT id, tokenKey FROM t_setting LIMIT 1"
$reader = $cmd.ExecuteReader()
if ($reader.Read()) {
    Write-Host "userId: $($reader['id']) tokenKey: $($reader['tokenKey'])"
}
$conn.Close()