以下是 conda 环境管理的常用命令：

### 创建环境

```bash
# 创建指定 Python 版本的环境
conda create -n myenv python=3.9

# 创建环境并安装指定包
conda create -n myenv python=3.9 numpy pandas

# 指定环境安装路径
conda create --prefix /path/to/env python=3.9
```

### 激活（进入）环境

```bash
conda activate myenv
```

### 退出环境

```bash
conda deactivate
```

### 查看所有环境

```bash
conda env list
# 或
conda info --envs
```

### 删除环境

```bash
conda env remove -n myenv
```

### 导出/导入环境配置

```bash
# 导出当前环境配置到 YAML 文件
conda env export > environment.yml

# 根据 YAML 文件创建环境
conda env create -f environment.yml
```

### 其他常用命令

```bash
# 在当前环境中安装包
conda install numpy pandas

# 卸载包
conda remove numpy

# 查看当前环境已安装的包
conda list

# 更新 conda 本身
conda update conda

# 更新环境中所有包
conda update --all
```

> 💡 **小贴士**：
> - 如果 `conda activate` 提示命令找不到，需要先执行 `conda init bash`（或 `conda init zsh`），然后重启终端。
> - 使用 `--prefix` 创建的环境，激活时需要写完整路径：`conda activate /path/to/env`。

---

#  ~/.bashrc
```
# pm2 daemon is managed by DroidDesk service (no auto-resurrect in shell)
source ~/miniconda3/etc/profile.d/conda.sh
# conda activate base
```