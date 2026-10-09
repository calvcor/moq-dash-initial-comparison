FROM python:3.12-alpine

# tc (htb/tbf/netem) e iptables para reenviar y degradar el tráfico entre el cliente y los servidores finales
RUN apk add --no-cache iproute2-tc iptables

COPY agent.py /agent.py

CMD ["python3", "-u", "/agent.py"]
