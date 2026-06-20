windows
```
# 清华源加速下载+静默安装+初始化conda
$installer = "$env:TEMP\miniconda.exe"
Invoke-WebRequest -Uri "https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Windows-x86_64.exe" -OutFile $installer
# 静默安装到用户目录，不写入系统PATH
Start-Process $installer -ArgumentList "/S /InstallationType=JustMe /RegisterPython=0 /AddToPath=0" -Wait
Remove-Item $installer -Force
# 初始化powershell，新开终端生效
& "$env:USERPROFILE\miniconda3\Scripts\conda.exe" init powershell
```

linux
```
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O miniconda.sh && bash miniconda.sh -b -p $HOME/miniconda3 && rm -f miniconda.sh && ~/miniconda3/bin/conda init bash zsh && source ~/.bashrc
```