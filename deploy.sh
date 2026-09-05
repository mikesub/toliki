#!/usr/bin/env bash
set -euo pipefail
ssh toliki 'git -C /home/ubuntu/toliki pull --rebase'
