#!/usr/bin/env bash
#
# Confere o que o tarball leva, antes de ele sair da maquina.
#
#   packages/client/scripts/varrer-o-pacote.sh
#
# Quatro perguntas:
#   1. Entrou alguma coisa com cara de credencial?
#   2. Entrou algum endereco que nao e de um lugar que este pacote deva citar?
#   3. Entrou algum arquivo fora da lista que o `files` promete?
#   4. Entrou teste, exemplo ou script?
#
# A pergunta 2 e por LISTA DE PERMISSAO e nao por lista de proibicao, e isso e
# de proposito. Uma lista de proibicao teria de escrever aqui os nomes dos
# recursos privados que ela quer barrar — num arquivo que vai para um
# repositorio publico. O jeito de barrar `https://algum-servico-interno` sem
# nunca digitar `algum-servico-interno` e dizer o que PODE aparecer.
#
# Quem quiser barrar nomes especificos alem disso cria
# `scripts/padroes-privados.txt`, uma expressao regular estendida por linha.
# Esse arquivo nao e exportado para o repositorio publico, e e onde o monorepo
# do nucleo guarda os nomes dele.
set -euo pipefail

PACOTE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORA="$(mktemp -d)"
trap 'rm -rf "$FORA"' EXIT

cd "$PACOTE"
npx --no-install tsc -p tsconfig.json 2>/dev/null || ./node_modules/.bin/tsc -p tsconfig.json 2>/dev/null || tsc -p tsconfig.json
TARBALL="$(npm pack --pack-destination "$FORA" --silent | tail -1)"
tar xf "$FORA/$TARBALL" -C "$FORA"
ALVO="$FORA/package"

echo "── conteudo de $TARBALL"
(cd "$ALVO" && find . -type f | sed 's|^\./|   |' | sort)

echo "── 1. cara de credencial"
PADROES='AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[0-9A-Za-z]{30,}|npm_[0-9A-Za-z]{30,}|sk-[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|://[^[:space:]"]+:[^[:space:]"@/]+@|[0-9]{10,}-[0-9a-z]{32}\.apps\.googleusercontent\.com|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
if grep -rEIn "$PADROES" "$ALVO"; then
  echo "   ACHOU. o pacote nao sai assim."
  exit 1
fi
echo "   limpo"

echo "── 2. enderecos, por lista de permissao"
# Os unicos hosts que este pacote tem motivo de citar: a licenca, o proprio
# repositorio, o registro, e os exemplos, que usam nomes reservados para
# documentacao (RFC 2606 e RFC 5737).
PERMITIDOS='^(www\.)?(apache\.org|github\.com/neilor/retick-client|registry\.npmjs\.org|npmjs\.com|keepachangelog\.com|semver\.org|retick\.example|example\.com|localhost|127\.0\.0\.1)'
ACHADOS="$(grep -rEIoh 'https?://[A-Za-z0-9._~:/?#@!$&*+,;=-]+' "$ALVO" \
  | sed -E 's|^https?://||; s|[).,"`'"'"']+$||' \
  | sort -u || true)"
SOBRA=""
while IFS= read -r endereco; do
  [ -z "$endereco" ] && continue
  echo "$endereco" | grep -qE "$PERMITIDOS" || SOBRA="$SOBRA$endereco"$'\n'
done <<< "$ACHADOS"
if [ -n "$SOBRA" ]; then
  echo "   endereco que nao esta na lista de permissao:"
  echo "$SOBRA" | sed '/^$/d; s|^|     |'
  echo "   se for legitimo, acrescente em PERMITIDOS. Se nao for, tire do pacote."
  exit 1
fi
echo "   limpo ($(echo "$ACHADOS" | sed '/^$/d' | wc -l | tr -d ' ') enderecos, todos na lista)"

echo "── 3. nomes que este repositorio queira barrar"
PRIVADOS="$PACOTE/scripts/padroes-privados.txt"
if [ -f "$PRIVADOS" ]; then
  while IFS= read -r padrao; do
    [ -z "$padrao" ] && continue
    case "$padrao" in \#*) continue ;; esac
    if grep -rEIn "$padrao" "$ALVO"; then
      echo "   ACHOU um padrao de $PRIVADOS."
      exit 1
    fi
  done < "$PRIVADOS"
  echo "   limpo"
else
  echo "   sem lista local, nada a fazer"
fi

echo "── 4. so o que o files promete"
INESPERADOS="$(cd "$ALVO" && find . -type f \
  ! -path './dist/*' \
  ! -path './src/*' \
  ! -name 'package.json' \
  ! -name 'README.md' \
  ! -name 'CHANGELOG.md' \
  ! -name 'LICENSE' \
  ! -name 'NOTICE')"
if [ -n "$INESPERADOS" ]; then
  echo "   arquivo fora da lista:"
  echo "$INESPERADOS" | sed 's|^\./|     |'
  exit 1
fi
echo "   limpo"

echo "── 5. nem teste, nem exemplo, nem script"
for proibido in test examples scripts publico node_modules .github; do
  if [ -e "$ALVO/$proibido" ]; then
    echo "   $proibido entrou no tarball"
    exit 1
  fi
done
echo "   limpo"

echo ""
echo "o pacote leva codigo, tipos, licenca e leitura. Nada mais."
