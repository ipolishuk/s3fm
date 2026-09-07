ARG BASE=python:3.11.9-bookworm

FROM ${BASE}

WORKDIR /app

COPY src/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

COPY src/ .

RUN printf '%s\n' '#!/bin/sh' 'exec python /app/config.py "$@"' > /usr/local/bin/s3 \
    && chmod +x /usr/local/bin/s3 \
    && echo "alias s3='python /app/config.py'" > /etc/profile.d/s3.sh

EXPOSE 3000

CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
