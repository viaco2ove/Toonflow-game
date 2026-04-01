# 运行项目                                                                                                                                                                                                           
`curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs `
`
apt-get update                                                                                                                                                                                                                    
apt-get install -y python3 make g++
`                                                                                                                                                                                     
                                                                                                                                                                                                                                    
`
cd ~/Toonflow-game                                                                                                                                                                                                                
yarn install                                                                                                                                                                                                                      
npm install -g pm2
`                                                                                                                                                                                                           
                                                                                                                                                                                                                                    
  然后不要先用 yarn build，直接用下面这组更稳：                                                                                                                                                                                     
                                                                                                                                                                                                                                    
`  
cd ~/Toonflow-game                                                                                                                                                                                                                
NODE_ENV=prod PREFER_PROCESS_ENV=1 npx tsx scripts/build.ts                                                                                                                                                                       
pm2 start build/app.js --name toonflow-app --update-env                                                                                                                                                                           
pm2 save
`                                                                                                                                                                                                                   
                                                                                                                                                                                                                                    
  再检查：                                                                                                                                                                                                                          
                                                                                                                                                                                                                                    
  pm2 logs toonflow-app                                                                                                                                                                                                             
  curl http://127.0.0.1:60002/

  如果 yarn install 这一步又报错，把完整报错贴我。
  如果是 esbuild 找不到，我再给你下一条修正命令。
  curl http://127.0.0.1:60002/

  如果 yarn install 这一步又报错，把完整报错贴我。
  如果是 esbuild 找不到，我再给你下一条修正命令。

 


