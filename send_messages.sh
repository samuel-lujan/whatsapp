#!/bin/bash

API_URL="https://whatsapp2.samuellujan.com.br/v3/session"
TOKEN="sua-chave-secreta-aqui"

NUMBER="+55 18 991553865"
MESSAGE="Olá, tudo bem? Esta é uma mensagem de teste"
CUSTOM_NAME="Samuel"

SESSIONS=(
  "livecycle"
  "soul-corporalli"
  "seven-studio"
  "WebhookRegiane"
  "studio-infinity"
  "hardcycle"
  "talk2mila"
  "move-on"
  "JuSilveiraSpinning"
  "studio-lifecycle"
  "Ultraspinning"
  "studio-power-jump"
)

for SESSION in "${SESSIONS[@]}"; do
  echo "Enviando para sessão: $SESSION"

  curl --location --request POST "$API_URL/$SESSION/message" \
    --header "Authorization: Bearer $TOKEN" \
    --header "Content-Type: application/json" \
    --data-raw "{
      \"number\": \"$NUMBER\",
      \"message\": \"$MESSAGE\",
      \"customName\": \"$CUSTOM_NAME\"
    }"

  echo -e "\n-----------------------------\n"
done