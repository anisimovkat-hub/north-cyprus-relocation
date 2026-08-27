#!/bin/sh
set -eu

worker_url="${1:-}"
if [ -z "$worker_url" ]; then
  echo "Использование: sh scripts/configure-telegram.sh https://WORKER.workers.dev"
  exit 1
fi

printf "Вставьте полный BOT_TOKEN (ввод скрыт): "
trap 'stty echo 2>/dev/null || true' EXIT INT TERM
stty -echo
IFS= read -r task_bot_token
stty echo
printf "\n"

task_webhook_secret="$(openssl rand -hex 32)"
printf "%s" "$task_bot_token" | npx wrangler secret put BOT_TOKEN
printf "%s" "$task_webhook_secret" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

response="$(curl --fail --silent --show-error \
  --request POST "https://api.telegram.org/bot${task_bot_token}/setWebhook" \
  --data-urlencode "url=${worker_url%/}/telegram/webhook" \
  --data-urlencode "secret_token=${task_webhook_secret}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' \
  --data-urlencode 'drop_pending_updates=false')"

unset task_bot_token task_webhook_secret
printf "%s\n" "$response"
