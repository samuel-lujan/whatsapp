redis-cli -p 7777 --scan --pattern 'whatsapp:session:\*'

redis-cli -p 7777 GET whatsapp:session:YOUR_COMPANY_NAME

redis-cli -p 7777 SMEMBERS whatsapp:session:active
