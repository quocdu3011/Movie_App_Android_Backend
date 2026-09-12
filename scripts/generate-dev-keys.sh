#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(cd -- "${script_dir}/.." && pwd)"
secret_dir="${backend_dir}/../.secrets"
mkdir -p "${secret_dir}"
chmod 700 "${secret_dir}"
if [[ -e "${secret_dir}/auth-private.pem" || -e "${secret_dir}/auth-public.pem" ]]; then
  echo "Refusing to overwrite existing development keys in ${secret_dir}" >&2
  exit 1
fi
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${secret_dir}/auth-private.pem"
openssl pkey -in "${secret_dir}/auth-private.pem" -pubout -out "${secret_dir}/auth-public.pem"
chmod 600 "${secret_dir}/auth-private.pem"
chmod 644 "${secret_dir}/auth-public.pem"
printf 'Development JWT keys created under %s\n' "${secret_dir}"
printf 'Copy Backend/.env.example to Backend/.env and adjust the paths before starting services.\n'
