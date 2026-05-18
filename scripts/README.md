# scripts/

Scripts utilitários standalone — não fazem parte dos pacotes do monorepo.

## smoke-test-adt.ts

Valida que conseguimos falar com seu SAP via ADT REST usando Basic auth, antes de empilhar código real.

### Setup

```powershell
# 1. Garante Node 22 (confira)
node --version

# 2. Instala deps (já configuradas no package.json raiz)
npm install

# 3. Define credenciais (PowerShell)
$env:SAP_URL = "https://<seu-tenant-sap>:<porta>"
$env:SAP_USER = "<your-user>"
$env:SAP_PASSWORD = "<your-password>"
$env:SAP_CLIENT = "100"

# 4. Roda
npm run smoke:adt
```

### O que o script faz

1. **login** — Basic auth, valida credenciais e fetch de CSRF token
2. **systemUsers / objectTypes** — sanity check: ADT responde a metadados básicos
3. **searchObject** — busca alguns Z\* (PROG, CLAS, DDLS) na TADIR
4. **transportsByConfig** — lista transports do seu usuário
5. **logout** — encerra sessão limpa

### O que NÃO faz (intencionalmente)

- Não lê tabelas de negócio
- Não executa SQL
- Não exporta dados
- Não escreve nada

Fica 100% dentro do escopo endossado de developer tooling da SAP API Policy Q33.

### Output esperado

Cada etapa marca `[ok Xms]` ou `[FAIL Xms]`. Se algum endpoint falhar, o erro fica visível mas o script continua nos demais (alguns sistemas restringem certos endpoints).

### Troubleshooting

- **401 Unauthorized** → credenciais erradas ou client errado
- **403 Forbidden em endpoint específico** → falta autorização SAP (S_DEVELOP, S_TCODE, etc.) — pedir ao basis
- **CSRF 403** → cookie/sessão não persistiu — abap-adt-api lida internamente, mas reportar se acontecer
- **ECONNREFUSED / ETIMEDOUT** → URL/porta erradas, ou firewall/VPN
- **Self-signed cert** → setar `NODE_TLS_REJECT_UNAUTHORIZED=0` *apenas em sandbox*
