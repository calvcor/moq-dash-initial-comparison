#!/bin/sh
# Certificado de Let's Encrypt para el puerto directo de DASH, con acme.sh y el reto DNS de DuckDNS: no
# necesita abrir ningún puerto ni que el servidor sea accesible desde Internet. La cuenta se registra sin
# correo electrónico. Se renueva solo; nginx-dash detecta el certificado nuevo y se recarga.
if [ -z "$DASH_HOST" ] || [ -z "$DUCKDNS_TOKEN" ]; then
    echo "Sin DASH_HOST o DUCKDNS_TOKEN: DASH sigue pasando por el punto de entrada y no se pide certificado."
    exec sleep infinity
fi
export DuckDNS_Token="$DUCKDNS_TOKEN"
ACME="acme.sh --config-home /certs/acme"
CERT="/certs/certificates/${DASH_HOST}.crt"
KEY="/certs/certificates/${DASH_HOST}.key"
mkdir -p /certs/certificates

until [ -s "$CERT" ]; do
    $ACME --issue --server letsencrypt --dns dns_duckdns --dnssleep 120 -d "$DASH_HOST" --keylength ec-256
    # 0: emitido; 2: ya había uno válido. En ambos casos se copia a donde lo busca nginx-dash.
    case $? in
        0|2) $ACME --install-cert -d "$DASH_HOST" --ecc --fullchain-file "$CERT" --key-file "$KEY" ;;
        *) echo "No se pudo obtener el certificado; se reintenta en 10 minutos" >&2; sleep 600 ;;
    esac
done

# Renovación: acme.sh solo renueva cuando faltan menos de 30 días, y al hacerlo vuelve a copiarlo
while true; do
    sleep 43200
    $ACME --cron
done
