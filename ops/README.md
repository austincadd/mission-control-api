# Launchd wrappers

These are the live launchd wrapper scripts for Mission Control.

The files under `~/.openclaw/workspace/tools/` are symlinks to this directory, so edit the copies here and the changes will be picked up on the next launchd restart.

`bluehost-root.htaccess` is a captured copy of the live Bluehost `.htaccess` as of 2026-04-24. It was manually deployed to Bluehost, and any edits to the live file must be SCP'd back up after updating this copy in repo.

Frontend deploys now use `npm run deploy-frontend` (backed by `tools/deploy-frontend.sh`). That script SCPs `index.html` and `health-proxy.php` to Bluehost, prints the git SHA, and refuses to run on a dirty tree. Use it instead of ad-hoc manual SCPs.
