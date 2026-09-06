#!/usr/bin/env bash
git pull --rebase
ssh toliki 'git -C /home/ubuntu/toliki pull --rebase'
