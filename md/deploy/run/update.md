            
  cd ~/Toonflow-game
  git pull  
            
  rm -rf node_modules               
  yarn install      
            
  NODE_ENV=prod PREFER_PROCESS_ENV=1 npx tsx scripts/build.ts
            
  pm2 delete toonflow-app || true   
  NODE_ENV=prod PREFER_PROCESS_ENV=1 pm2 start build/app.js --name toonflow-app --update-env
  pm2 save  
  pm2 logs toonflow-app           
