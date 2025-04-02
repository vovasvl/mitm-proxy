#!/bin/sh

BASE_DIR=$(dirname "$0")

HOST=$1
SERIAL=$2
OUTPUT_CERT="$BASE_DIR/certs/$HOST.crt"

openssl req -new -key "$BASE_DIR/cert.key" -subj "/CN=$HOST" -sha256 | \
openssl x509 -req -days 3650 -CA "$BASE_DIR/ca.crt" -CAkey "$BASE_DIR/ca.key" -set_serial "$SERIAL" -out "$OUTPUT_CERT"