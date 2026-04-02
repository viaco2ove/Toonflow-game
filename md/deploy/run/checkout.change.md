# 假设你要切到 dev
cd ~/Toonflow-game
git fetch origin
git switch -c dev --track origin/dev
git pull origin dev

# 如果你已经在 dev 本地分支上了，就只要：

git switch dev
git pull

# 强行跟远端某个分支完全一致，也可以：

git fetch origin
git checkout 分支名
git reset --hard origin/dev