#!/bin/sh
# Certificado de Let's Encrypt para el puerto directo de DASH, por el reto DNS de DuckDNS: no necesita
# abrir ningún puerto ni que el servidor sea accesible desde Internet. Se renueva solo.
if [ -z "$DASH_HOST" ] || [ -z "$DUCKDNS_TOKEN" ]; then
    echo "Sin DASH_HOST o DUCKDNS_TOKEN: DASH sigue pasando por el punto de entrada y no se pide certificado."
    exec sleep infinity
fi
export DUCKDNS_PROPAGATION_TIMEOUT=${DUCKDNS_PROPAGATION_TIMEOUT:-180}
while true; do
    if [ -s "/certs/certificates/${DASH_HOST}.crt" ]; then
        /lego --accept-tos --dns duckdns --domains "$DASH_HOST" --path /certs renew --days 30
    else
        /lego --accept-tos --dns duckdns --domains "$DASH_HOST" --path /certs run
    fi
    sleep 43200
done
