#!/bin/sh

#cd ~/robo1
curl -sL https://deb.nodesource.com/setup_14.x | sudo -E bash -
sudo apt -y install nodejs
tmux has-session -t bot
tmux new-session -d -s bot 'npm i && npm install pm2@latest -g && pm2 start ecosystem.config.js && pm2 monit'
tmux attach -t bot
